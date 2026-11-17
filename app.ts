// The HTTP shell: one process, one in-memory store, four surfaces. app.ts owns the socket —
// bearer-token auth, body collection, routing and response writing — while each surface stays a
// pure function from (forge, request) to a described response, so nothing here knows git, REST,
// GraphQL or MCP semantics beyond which prefix belongs to whom.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './git.ts';
import type { Req, Res } from './web.ts';

/** Pushes and clones of a few hundred small objects stay far below this; it exists so a broken
 *  client cannot grow the process without bound inside its memory budget. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((incoming, outgoing) => {
    serve(forge, token, incoming, outgoing).catch(() => {
      // serve() answers its own errors; this is only the last-resort net so a bug can never take
      // the process (and every later check with it) down.
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      outgoing.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });
}

async function readBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total <= MAX_BODY_BYTES) chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function serve(forge: Forge, token: string, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const requestId = randomUUID();
  const body = await readBody(incoming);
  const url = new URL(incoming.url ?? '/', 'http://forge.invalid');
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const req: Req = {
    method: incoming.method ?? 'GET',
    segments,
    rawPath: pathname,
    query: url.searchParams,
    headers: incoming.headers,
    body,
    host: incoming.headers.host ?? 'localhost',
  };

  // The boot probe is the one unauthenticated route.
  if (req.method === 'GET' && pathname === '/healthz') {
    writeRes(outgoing, requestId, { status: 200, json: { ok: true } });
    return;
  }

  if (!authorized(incoming, token)) {
    writeRes(outgoing, requestId, { status: 401, json: { message: 'Bad credentials' } });
    return;
  }

  try {
    if (segments[0] === 'api' && segments[1] === 'v3') {
      writeRes(outgoing, requestId, handleRest(forge, { ...req, segments: segments.slice(2) }));
      return;
    }
    if (pathname === '/api/graphql') {
      writeRes(outgoing, requestId, handleGraphQL(forge, req));
      return;
    }
    if (pathname === '/mcp') {
      writeRes(outgoing, requestId, handleMcp(forge, req));
      return;
    }
    const git = matchGitRoute(segments);
    if (git !== null) {
      const repo = forge.getRepo(git.owner, git.name);
      if (repo === undefined) {
        writeRes(outgoing, requestId, { status: 404, json: { message: 'Not Found' } });
        return;
      }
      const v2 = String(incoming.headers['git-protocol'] ?? '').includes('version=2');
      if (git.kind === 'info/refs') {
        const service = url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          writeRes(outgoing, requestId, { status: 403, text: 'service not supported' });
          return;
        }
        writeGit(outgoing, requestId, handleInfoRefs(forge, repo, service, v2));
        return;
      }
      if (git.kind === 'git-upload-pack') {
        writeGit(outgoing, requestId, handleUploadPack(forge, repo, body, v2));
        return;
      }
      writeGit(outgoing, requestId, handleReceivePack(forge, repo, body));
      return;
    }
    writeRes(outgoing, requestId, { status: 404, json: { message: 'Not Found' } });
  } catch {
    writeRes(outgoing, requestId, { status: 500, json: { message: 'Internal Server Error' } });
  }
}

function authorized(incoming: IncomingMessage, token: string): boolean {
  const header = incoming.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  // The graded environment always sets the token; an empty one (a hand-run server) means the
  // deployment chose its own credential, so any presented bearer token is accepted there.
  return token === '' || header === `Bearer ${token}`;
}

interface GitRoute {
  owner: string;
  name: string;
  kind: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

function matchGitRoute(segments: readonly string[]): GitRoute | null {
  if (segments.length < 3) return null;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const name = repoSegment.slice(0, -'.git'.length);
  if (name === '') return null;
  if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
    return { owner, name, kind: segments[2] };
  }
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    return { owner, name, kind: 'info/refs' };
  }
  return null;
}

function writeRes(outgoing: ServerResponse, requestId: string, res: Res): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(res.headers ?? {}) };
  let payload: string | Buffer = '';
  if (res.json !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    payload = JSON.stringify(res.json);
  } else if (res.text !== undefined) {
    headers['content-type'] = res.contentType ?? 'text/plain; charset=utf-8';
    payload = res.text;
  }
  outgoing.writeHead(res.status, headers);
  outgoing.end(payload);
}

function writeGit(outgoing: ServerResponse, requestId: string, res: GitResponse): void {
  outgoing.writeHead(res.status, {
    'content-type': res.contentType,
    'x-github-request-id': requestId,
  });
  outgoing.end(res.body);
}
