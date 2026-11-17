// The REST v3 surface: the API root, meta, the token's user, repositories and their contents,
// branches, commits, git refs, labels, issues and pull requests — the routes the suite drives,
// with GitHub's statuses and shapes. Everything reads and writes the one shared store, so an
// object created here is the same object the git, GraphQL and MCP surfaces see.

import { VIEWER } from './scenario.ts';
import {
  Forge,
  diffFlat,
  isOid,
  mergePull,
  parseCommit,
  pullChanges,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { badRequest, bool, jsonBody, jsonRes, notFound, str, unprocessable, type Req, type Res } from './web.ts';

const INSTALLED_VERSION = '1.0.0';

// ------------------------------------------------------------------------------------------------
// Shapes
// ------------------------------------------------------------------------------------------------

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(repo.createdSec * 1000).toISOString(),
    html_url: `/repos/${repo.owner}/${repo.name}`,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: repo.owner },
    created_at: new Date(issue.createdSec * 1000).toISOString(),
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: forge.branchTip(repo, pull.headRef) ?? '',
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: forge.branchTip(repo, pull.baseRef) ?? '',
      label: `${repo.owner}:${pull.baseRef}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : new Date(pull.mergedAtSec * 1000).toISOString(),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner },
    created_at: new Date(pull.createdSec * 1000).toISOString(),
  };
}

export function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login } };
}

// ------------------------------------------------------------------------------------------------
// Pagination
// ------------------------------------------------------------------------------------------------

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(req: Req, all: readonly T[]): Page<T> {
  const perRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const per = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * per;
  const items = all.slice(start, start + per);
  const headers: Record<string, string> = {};
  if (start + per < all.length) {
    const lastPage = Math.max(1, Math.ceil(all.length / per));
    const urlFor = (target: number): string => {
      const params = new URLSearchParams(req.query);
      params.set('page', String(target));
      params.set('per_page', String(per));
      return `<http://${req.host}${req.rawPath}?${params.toString()}>`;
    };
    headers.link = `${urlFor(page + 1)}; rel="next", ${urlFor(lastPage)}; rel="last"`;
  }
  return { items, headers };
}

// ------------------------------------------------------------------------------------------------
// Repositories
// ------------------------------------------------------------------------------------------------

function createRepo(forge: Forge, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const name = str(parsed.value.name);
  if (name === undefined || name === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return unprocessable('name is invalid');
  }
  if (forge.getRepo(VIEWER.login, name) !== undefined) {
    return unprocessable('name already exists on this account');
  }
  const repo = forge.createRepo(VIEWER.login, name, bool(parsed.value.private) ?? false, str(parsed.value.description) ?? '');
  return jsonRes(201, repoJson(repo));
}

function listUserRepos(forge: Forge, req: Req): Res {
  const page = paginate(req, forge.reposOf(VIEWER.login));
  return jsonRes(200, page.items.map(repoJson), page.headers);
}

function getRepo(repo: RepoRec): Res {
  return jsonRes(200, repoJson(repo));
}

function patchRepo(repo: RepoRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const description = str(parsed.value.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = bool(parsed.value.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  return jsonRes(200, repoJson(repo));
}

// ------------------------------------------------------------------------------------------------
// Branches, commits, git refs
// ------------------------------------------------------------------------------------------------

function listBranches(forge: Forge, repo: RepoRec): Res {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  return jsonRes(200, branches);
}

function getBranch(forge: Forge, repo: RepoRec, branch: string): Res {
  const tip = forge.branchTip(repo, branch);
  if (tip === null) return notFound();
  return jsonRes(200, { name: branch, commit: { sha: tip }, protected: false });
}

function resolveCommit(forge: Forge, repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  const byBranch = forge.branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (isOid(ref)) return forge.peelToCommit(ref);
  return null;
}

function listCommits(forge: Forge, repo: RepoRec, req: Req): Res {
  const tip = resolveCommit(forge, repo, req.query.get('sha'));
  if (tip === null) return jsonRes(200, []);
  const commits = forge.listCommits(tip).map((oid) => {
    const object = forge.getObject(oid);
    const commit = object && object.type === 'commit' ? parseCommit(object.data) : null;
    return {
      sha: oid,
      commit: {
        message: commit?.message.replace(/\n$/, '') ?? '',
        author: { name: VIEWER.name, email: VIEWER.email },
        committer: { name: VIEWER.name, email: VIEWER.email },
      },
      parents: (commit?.parents ?? []).map((sha) => ({ sha })),
    };
  });
  return jsonRes(200, commits);
}

function createRef(forge: Forge, repo: RepoRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const ref = str(parsed.value.ref);
  const sha = str(parsed.value.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isOid(sha)) {
    return unprocessable('ref and a valid sha are required');
  }
  const object = forge.getObject(sha);
  if (object === undefined) return unprocessable('sha does not name an object');
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return unprocessable('sha is not a commit');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return jsonRes(201, { ref, object: { sha, type: object.type } });
}

function getRef(forge: Forge, repo: RepoRec, ref: string): Res {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = forge.getObject(oid);
  return jsonRes(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

function listRefs(forge: Forge, repo: RepoRec): Res {
  return jsonRes(
    200,
    [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } })),
  );
}

// ------------------------------------------------------------------------------------------------
// Contents
// ------------------------------------------------------------------------------------------------

function fileAt(forge: Forge, repo: RepoRec, branch: string, path: string): { oid: string; data: Buffer } | null {
  const tip = forge.branchTip(repo, branch);
  const files = forge.flattenTree(forge.treeOfCommit(tip));
  const entry = files.get(path);
  if (!entry) return null;
  const object = forge.getObject(entry.oid);
  if (!object || object.type !== 'blob') return null;
  return { oid: entry.oid, data: object.data };
}

function getContents(forge: Forge, repo: RepoRec, req: Req, path: string): Res {
  const ref = req.query.get('ref');
  const commit = resolveCommit(forge, repo, ref);
  if (commit === null) return notFound();
  const tree = forge.treeOfCommit(commit);
  const files = forge.flattenTree(tree);
  const entry = path === '' ? undefined : files.get(path);
  if (entry) {
    const object = forge.getObject(entry.oid);
    if (!object || object.type !== 'blob') return notFound();
    return jsonRes(200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  // A directory (or the root): list its immediate entries.
  const prefix = path === '' ? '' : `${path}/`;
  const dirs = new Map<string, string>();
  const listing: Array<Record<string, unknown>> = [];
  const seenFiles = new Set<string>();
  for (const [filePath, fileEntry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      if (!seenFiles.has(rest)) {
        seenFiles.add(rest);
        listing.push({ type: 'file', name: rest, path: filePath, sha: fileEntry.oid, size: forge.getObject(fileEntry.oid)?.data.length ?? 0 });
      }
    } else {
      const dirName = rest.slice(0, slash);
      if (!dirs.has(dirName)) dirs.set(dirName, forge.subtreeOid(tree, `${prefix}${dirName}`) ?? '');
    }
  }
  for (const [dirName, oid] of dirs) {
    listing.push({ type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: oid, size: 0 });
  }
  if (path !== '' && listing.length === 0) return notFound();
  listing.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return jsonRes(200, listing);
}

function putContents(forge: Forge, repo: RepoRec, req: Req, path: string): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const content = str(parsed.value.content);
  if (content === undefined) return unprocessable('content is required');
  const message = str(parsed.value.message) ?? '';
  const branch = str(parsed.value.branch) ?? repo.defaultBranch;
  const existing = fileAt(forge, repo, branch, path);
  const givenSha = str(parsed.value.sha);
  if (existing && givenSha !== undefined && givenSha !== existing.oid) {
    return jsonRes(409, { message: 'the given sha does not match the file on the branch' });
  }
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const commit = forge.commitFiles(repo, branch, new Map([[path, data]]), message);
  const blobOid = forge.putObject('blob', data);
  return jsonRes(existing ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
    commit: { sha: commit, message },
  });
}

function deleteContents(forge: Forge, repo: RepoRec, req: Req, path: string): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const message = str(parsed.value.message) ?? '';
  const branch = str(parsed.value.branch) ?? repo.defaultBranch;
  const existing = fileAt(forge, repo, branch, path);
  if (!existing) return notFound();
  const givenSha = str(parsed.value.sha);
  if (givenSha !== undefined && givenSha !== existing.oid) {
    return jsonRes(409, { message: 'the given sha does not match the file on the branch' });
  }
  const commit = forge.commitFiles(repo, branch, new Map([[path, null]]), message);
  return jsonRes(200, { content: null, commit: { sha: commit, message } });
}

// ------------------------------------------------------------------------------------------------
// Labels, issues, comments
// ------------------------------------------------------------------------------------------------

function createLabel(repo: RepoRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const name = str(parsed.value.name);
  if (name === undefined || name === '') return unprocessable('name is required');
  if (repo.labels.has(name)) return unprocessable('Label already exists');
  repo.labels.set(name, { name, color: str(parsed.value.color) ?? 'ededed' });
  return jsonRes(201, labelJson(repo, name));
}

function listIssues(repo: RepoRec, req: Req): Res {
  const state = req.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(req, issues);
  return jsonRes(200, page.items.map((issue) => issueJson(repo, issue)), page.headers);
}

function patchIssue(repo: RepoRec, issue: IssueRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const state = str(parsed.value.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = str(parsed.value.title);
  if (title !== undefined) issue.title = title;
  const body = str(parsed.value.body);
  if (body !== undefined) issue.body = body;
  return jsonRes(200, issueJson(repo, issue));
}

// ------------------------------------------------------------------------------------------------
// Pull requests
// ------------------------------------------------------------------------------------------------

function normalizeBranch(ref: string): string {
  let out = ref;
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.indexOf(':');
  if (colon >= 0) out = out.slice(colon + 1);
  return out;
}

function createPull(forge: Forge, repo: RepoRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const title = str(parsed.value.title);
  const headRaw = str(parsed.value.head);
  const baseRaw = str(parsed.value.base);
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    return unprocessable('title, head and base are required');
  }
  const head = normalizeBranch(headRaw);
  const base = normalizeBranch(baseRaw);
  if (forge.branchTip(repo, head) === null || forge.branchTip(repo, base) === null) {
    return unprocessable('Validation Failed: head or base branch does not exist');
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return unprocessable('A pull request already exists for this branch combination');
    }
  }
  const pull = forge.newPull(repo, title, str(parsed.value.body) ?? '', head, base);
  return jsonRes(201, pullJson(forge, repo, pull));
}

function listPulls(forge: Forge, repo: RepoRec, req: Req): Res {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const page = paginate(req, pulls);
  return jsonRes(200, page.items.map((pull) => pullJson(forge, repo, pull)), page.headers);
}

function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): Res {
  const changes = pullChanges(forge, repo, pull);
  return jsonRes(
    200,
    changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.headOid ?? '',
    })),
  );
}

function mergePullRoute(forge: Forge, repo: RepoRec, pull: PullRec): Res {
  if (pull.merged) return jsonRes(405, { message: 'Pull Request is not mergeable' });
  const sha = mergePull(forge, repo, pull);
  if (sha === null) return jsonRes(405, { message: 'Pull Request is not mergeable' });
  return jsonRes(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------------------------------------

/** Handle one /api/v3 request; `req.segments` are the segments after the prefix. */
export function handleRest(forge: Forge, req: Req): Res {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      return jsonRes(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return notFound();
  }
  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    return jsonRes(200, { installed_version: INSTALLED_VERSION });
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    return jsonRes(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') return createRepo(forge, req);
    if (method === 'GET') return listUserRepos(forge, req);
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) return notFound();
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return getRepo(repo);
      if (method === 'PATCH') return patchRepo(repo, req);
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, headers: {} };
      }
      return notFound();
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') return listBranches(forge, repo);
      if (rest.length >= 2 && method === 'GET') return getBranch(forge, repo, rest.slice(1).join('/'));
      return notFound();
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(forge, repo, req);
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') return createRef(forge, repo, req);
      if (rest.length === 2 && method === 'GET') return listRefs(forge, repo);
      if (rest.length >= 3 && method === 'GET') return getRef(forge, repo, `refs/${rest.slice(2).join('/')}`);
      return notFound();
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return getContents(forge, repo, req, path);
      if (method === 'PUT') return putContents(forge, repo, req, path);
      if (method === 'DELETE') return deleteContents(forge, repo, req, path);
      return notFound();
    }
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') return createLabel(repo, req);
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') return createIssueWithForge(forge, repo, req);
        if (method === 'GET') return listIssues(repo, req);
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (issue === undefined) return notFound();
        if (method === 'GET') return jsonRes(200, issueJson(repo, issue));
        if (method === 'PATCH') return patchIssue(repo, issue, req);
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (method === 'POST') return createCommentWithForge(forge, issue, req);
        if (method === 'GET') return jsonRes(200, issue.comments.map(commentJson));
        return notFound();
      }
      return notFound();
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') return createPull(forge, repo, req);
        if (method === 'GET') return listPulls(forge, repo, req);
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        if (pull === undefined) return notFound();
        return jsonRes(200, pullJson(forge, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound();
        return pullFiles(forge, repo, pull);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound();
        const parsed = jsonBody(req);
        if (!parsed.ok) return parsed.res;
        return mergePullRoute(forge, repo, pull);
      }
      return notFound();
    }
    return notFound();
  }

  return notFound();
}

// Issue and comment creation go through the Forge so ids and numbers stay consistent; the small
// wrappers keep the route table above readable.
function createIssueWithForge(forge: Forge, repo: RepoRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const title = str(parsed.value.title);
  if (title === undefined) return unprocessable('title is required');
  const labels = parsed.value.labels;
  const labelNames: string[] = [];
  if (Array.isArray(labels)) {
    for (const label of labels) {
      const name = typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name);
      if (name === undefined || !repo.labels.has(name)) {
        return unprocessable(`Validation Failed: label ${name ?? '?'} does not exist`);
      }
      labelNames.push(name);
    }
  }
  const issue = forge.newIssue(repo, title, str(parsed.value.body) ?? '', labelNames);
  return jsonRes(201, issueJson(repo, issue));
}

function createCommentWithForge(forge: Forge, issue: IssueRec, req: Req): Res {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.res;
  const body = str(parsed.value.body);
  if (body === undefined) return unprocessable('body is required');
  const comment = forge.newComment(issue, body);
  return jsonRes(201, commentJson(comment));
}
