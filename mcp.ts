// The MCP endpoint at /mcp: a stateless JSON-RPC server speaking the modern protocol era
// (server/discover, no session) with the legacy initialize handshake as a fallback. Six tools,
// backed by the same store as REST and GraphQL — a repository or issue created here is the same
// object on every surface, with the same ids.

import { VIEWER } from './scenario.ts';
import { Forge, mergePull, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { jsonRes, type Req, type Res } from './web.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' } as const;

const DISCOVER_RESULT = {
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: { tools: {} },
  serverInfo: { ...SERVER_INFO },
  _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
};

const SUPPORTED_VERSIONS = new Set(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2025-03-26', '2024-11-05', '2024-10-07']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool catalogue, built once so tools/list is byte-identical across calls. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch to merge from.' },
        base: { type: 'string', description: 'The branch to merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Res {
  return jsonRes(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Res {
  return jsonRes(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner === undefined || repo === undefined) return null;
  return forge.getRepo(owner, repo) ?? null;
}

function normalizeBranch(forge: Forge, repo: RepoRec, raw: string): string {
  let branch = raw;
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  const colon = branch.indexOf(':');
  if (colon > 0) branch = branch.slice(colon + 1);
  void forge;
  void repo;
  return branch;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === undefined || repoName === '') return toolError('name is required');
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        typeof args.private === 'boolean' ? args.private : false,
        asString(args.description) ?? '',
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(forge, args);
      return repo === null ? toolError('repository not found') : toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const title = asString(args.title);
      if (title === undefined || title === '') return toolError('title is required');
      const issue = forge.newIssue(repo, title, asString(args.body) ?? '', []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const state = asString(args.state) ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolOk({ total_count: issues.length, issues });
    }
    case 'create_pull_request': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const title = asString(args.title);
      const headRaw = asString(args.head);
      const baseRaw = asString(args.base);
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return toolError('title, head and base are required');
      }
      const head = normalizeBranch(forge, repo, headRaw);
      const base = normalizeBranch(forge, repo, baseRaw);
      if (forge.branchTip(repo, head) === null) return toolError(`head branch ${head} does not exist`);
      if (forge.branchTip(repo, base) === null) return toolError(`base branch ${base} does not exist`);
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) return toolError('a pull request for this head and base already exists');
      const pull = forge.newPull(repo, title, asString(args.body) ?? '', head, base);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(asString(args.pull_number) ?? '', 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('pull request not found');
      if (pull.merged) return toolError('pull request is already merged');
      if (pull.state !== 'open') return toolError('pull request is not open');
      const sha = mergePull(forge, repo, pull);
      if (sha === null) return toolError('pull request is not mergeable');
      return toolOk({ ...pullJson(forge, repo, pull), merged: true, sha });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/** Handle one POST /mcp request (a single JSON-RPC message; notifications get an empty 202). */
export function handleMcp(forge: Forge, req: Req): Res {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const message = parsed as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in message && message.id !== undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  if (!hasId) {
    // A notification: nothing to answer, whatever it says.
    return { status: 202, headers: {}, text: '' };
  }
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, DISCOVER_RESULT);
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, -32602, `unknown tool ${toolName}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return rpcResult(id, callTool(forge, toolName, args));
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
