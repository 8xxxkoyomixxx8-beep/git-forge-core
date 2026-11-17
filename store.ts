// The forge's store: git objects held verbatim by their SHA-1, repositories with refs, issues,
// pull requests, labels and comments, and the tree/merge machinery every surface shares.
//
// Objects are stored exactly as received or built (never re-serialised), so a pushed commit or tag
// round-trips byte-for-byte. All state is in this one process's memory: a trial starts the entry
// fresh, and nothing here touches the filesystem.

import { createHash } from 'node:crypto';
import { DEFAULT_BRANCH, EPOCH_SEC, VIEWER } from './scenario.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}
export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => HEX40.test(value);

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Serialise tree entries the way git does (sorted, directories compared as name + '/'). */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

/** Parse an annotated tag object's headers. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

/** Build a commit object's bytes with one identity line for author and committer. */
export function buildCommitData(fields: { tree: string; parents: readonly string[]; message: string; ident: string }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.ident}`, `committer ${fields.ident}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ------------------------------------------------------------------------------------------------
// Records
// ------------------------------------------------------------------------------------------------

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSec: number;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSec: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  nextNumber: number;
  createdSec: number;
}

export class Forge {
  readonly objects = new Map<string, StoredObject>();
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private clockSec = EPOCH_SEC;

  /** A monotonic clock (seconds) so generated timestamps are sane and ever-increasing. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** The identity line REST/GraphQL/MCP-created commits carry: the token owner at the tick. */
  ident(sec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
    const repo: RepoRec = {
      id: (this.repoSeq += 1),
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSec: this.tick(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  repoById(id: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  newIssue(repo: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec {
    const issue: IssueRec = {
      kind: 'issue',
      id: (this.issueSeq += 1),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSec: this.tick(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  newPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const pull: PullRec = {
      kind: 'pull',
      id: (this.issueSeq += 1),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAtSec: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdSec: this.tick(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  newComment(issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: (this.commentSeq += 1), body };
    issue.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------------------------------------
  // Git graph helpers
  // ----------------------------------------------------------------------------------------------

  /** Every object reachable from `roots` (commit → tree + parents, tree → entries, tag → target). */
  reachable(roots: Iterable<string>, into?: Set<string>): Set<string> {
    const seen = into ?? new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isOid(root) && !seen.has(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** The commit a ref-ish oid names, peeling annotated tags; null when it is not commit-like. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All ancestors of a commit (including itself), following parents. */
  commitAncestors(tip: string): Set<string> {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return seen;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    return this.commitAncestors(tip).has(ancestor);
  }

  /** A best common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = this.commitAncestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /** Commits in newest-first order from a tip (a stack walk; parents always follow children). */
  listCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  // ----------------------------------------------------------------------------------------------
  // Trees as flat path maps (contents API, diffs, merges)
  // ----------------------------------------------------------------------------------------------

  /** Flatten a tree into path → {oid, mode} for files (directories are implicit). */
  flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    if (treeOid !== null) walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree hierarchy from a flat path map; answers the root tree oid. */
  buildTreeFromFlat(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTreeData(entries));
    };
    return build(root);
  }

  /** The subtree oid at `path` under a root tree, or null when the directory is absent. */
  subtreeOid(rootTree: string | null, path: string): string | null {
    if (rootTree === null || path === '') return rootTree;
    let current = rootTree;
    for (const segment of path.split('/')) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** The tree oid a commit names, or null. */
  treeOfCommit(commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The ref's current tip commit (peeling tags), or null when unborn/missing. */
  branchTip(repo: RepoRec, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return this.peelToCommit(oid);
  }

  /**
   * Commit a set of path changes (Buffer = new content, null = delete) on a branch, creating the
   * branch from the default branch's tip when it does not exist yet. Answers the new commit oid.
   */
  commitFiles(repo: RepoRec, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    let parent = this.branchTip(repo, branch);
    if (parent === null && branch !== repo.defaultBranch) parent = this.branchTip(repo, repo.defaultBranch);
    const files = this.flattenTree(this.treeOfCommit(parent));
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { oid: this.putObject('blob', content), mode: '100644' });
    }
    const tree = this.buildTreeFromFlat(files);
    const sec = this.tick();
    const commit = this.putObject(
      'commit',
      buildCommitData({ tree, parents: parent === null ? [] : [parent], message, ident: this.ident(sec) }),
    );
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }
}

// ------------------------------------------------------------------------------------------------
// Pull-request diff and merge (shared by REST, GraphQL and MCP)
// ------------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  headOid: string | null;
  baseOid: string | null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n').length;
  return text.endsWith('\n') ? parts - 1 : parts;
}

/** The file-level diff between two flat path maps. */
export function diffFlat(
  forge: Forge,
  from: ReadonlyMap<string, { oid: string; mode: string }>,
  to: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before && after && before.oid === after.oid) continue;
    const beforeData = before ? forge.getObject(before.oid)?.data : undefined;
    const afterData = after ? forge.getObject(after.oid)?.data : undefined;
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: afterData ? lineCount(afterData) : 0,
      deletions: beforeData ? lineCount(beforeData) : 0,
      headOid: after?.oid ?? null,
      baseOid: before?.oid ?? null,
    });
  }
  return changes;
}

/** The changed files of a pull request: merge-base tree → head tree. */
export function pullChanges(forge: Forge, repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = forge.mergeBase(baseTip, headTip) ?? baseTip;
  return diffFlat(forge, forge.flattenTree(forge.treeOfCommit(base)), forge.flattenTree(forge.treeOfCommit(headTip)));
}

/**
 * A three-way, file-level merge of head into base. Answers the merged flat map, or null on a
 * conflict (both sides changed the same path to different bytes since the merge base).
 */
export function threeWayMerge(
  forge: Forge,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const mergeBase = forge.mergeBase(baseTip, headTip);
  const origin = forge.flattenTree(forge.treeOfCommit(mergeBase));
  const baseFiles = forge.flattenTree(forge.treeOfCommit(baseTip));
  const headFiles = forge.flattenTree(forge.treeOfCommit(headTip));
  const result = new Map(baseFiles);
  const paths = new Set([...origin.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const originEntry = origin.get(path);
    const headEntry = headFiles.get(path);
    if (originEntry?.oid === headEntry?.oid) continue; // head did not change it
    const baseEntry = baseFiles.get(path);
    if (baseEntry?.oid !== originEntry?.oid && baseEntry?.oid !== headEntry?.oid) return null; // both changed it, differently
    if (headEntry === undefined) result.delete(path);
    else result.set(path, headEntry);
  }
  return result;
}

/**
 * Squash-merge a pull request: one new commit on the base branch carrying the head's changes.
 * Answers the merge commit oid, or null when the merge conflicts.
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec): string | null {
  const baseTip = forge.branchTip(repo, pull.baseRef);
  const headTip = forge.branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const merged = threeWayMerge(forge, baseTip, headTip);
  if (merged === null) return null;
  const tree = forge.buildTreeFromFlat(merged);
  const sec = forge.tick();
  const commit = forge.putObject(
    'commit',
    buildCommitData({
      tree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})\n`,
      ident: forge.ident(sec),
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = sec;
  pull.mergeCommitSha = commit;
  return commit;
}
