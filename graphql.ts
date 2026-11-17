// The GraphQL v4 surface: a small parser and executor for the documents gh and github-mcp-server
// send (viewer, repository reads, issue/pull-request connections with cursor pagination, the five
// mutations, node(id:) and the __type probes). It executes against the same store as REST, so an
// issue created here is the REST surface's issue. Global ids are opaque, stable base64 tokens.

import { VIEWER } from './scenario.ts';
import { Forge, mergePull, pullChanges, threeWayMerge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { jsonRes, type Req, type Res } from './web.ts';

// ------------------------------------------------------------------------------------------------
// Global ids
// ------------------------------------------------------------------------------------------------

export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Lexer and parser (the GraphQL subset the suite's documents use)
// ------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16)) : esc;
          i += esc === 'u' ? 6 : 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let kind: 'int' | 'float' = 'int';
      if (source[j] === '.') {
        kind = 'float';
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Map<string, ValueNode>; selectionSet: SelectionNode[] | null }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in the GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct': {
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<[string, ValueNode]> = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push([name, this.parseValue()]);
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in a value`);
      }
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('unexpected token in a value');
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selectionSet };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Schema surface for the __type probes
// ------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'commits', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
};

const TYPE_ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT', 'ORGANIZATION', 'PROJECT', 'PULL_REQUEST', 'WIKI'],
};

// ------------------------------------------------------------------------------------------------
// Executor
// ------------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: GqlError[];
}

type Source = Record<string, unknown> | null;

interface FieldDef {
  /** The GraphQL type the field's value completes as ('[Issue]' for a list). */
  type: string;
  resolve: (ctx: ExecCtx, source: Source, args: Record<string, unknown>) => unknown;
}

const wrapIssue = (repo: RepoRec, rec: IssueRec): Source => ({ __repo: repo, __rec: rec });
const wrapPull = (repo: RepoRec, rec: PullRec): Source => ({ __repo: repo, __rec: rec });

function repoFromGlobalId(ctx: ExecCtx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return ctx.forge.repoById(Number.parseInt(decoded.parts[0] as string, 10)) ?? null;
}

function issueFromGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRec; rec: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0] as string, 10));
  const rec = repo?.issues.get(Number.parseInt(decoded.parts[1] as string, 10));
  return repo && rec ? { repo, rec } : null;
}

function pullFromGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRec; rec: PullRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0] as string, 10));
  const rec = repo?.pulls.get(Number.parseInt(decoded.parts[1] as string, 10));
  return repo && rec ? { repo, rec } : null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

const FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => ({ login: VIEWER.login }) },
    repository: {
      type: 'Repository',
      resolve: (ctx, _source, args) => {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        return ctx.forge.getRepo(owner, name) ?? null;
      },
    },
    node: {
      type: 'Node',
      resolve: (ctx, _source, args) => {
        if (typeof args.id !== 'string') return null;
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0] as string, 10));
          return repo ? { __gqlType: 'Repository', __value: repo } : null;
        }
        if (decoded.type === 'Issue') {
          const found = issueFromGlobalId(ctx, args.id);
          return found ? { __gqlType: 'Issue', __value: wrapIssue(found.repo, found.rec) } : null;
        }
        if (decoded.type === 'PullRequest') {
          const found = pullFromGlobalId(ctx, args.id);
          return found ? { __gqlType: 'PullRequest', __value: wrapPull(found.repo, found.rec) } : null;
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_ctx, _source, args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[name] !== undefined) return { __name: name, __kind: 'OBJECT' };
        if (TYPE_ENUMS[name] !== undefined) return { __name: name, __kind: 'ENUM' };
        return null;
      },
    },
  },
  User: {
    login: { type: 'String', resolve: (_ctx, source) => (source as { login: string }).login },
    id: { type: 'ID', resolve: () => globalId('User', VIEWER.id) },
    name: { type: 'String', resolve: () => VIEWER.name },
    email: { type: 'String', resolve: () => VIEWER.email },
    databaseId: { type: 'Int', resolve: () => VIEWER.id },
  },
  Repository: {
    id: { type: 'ID', resolve: (_ctx, source) => globalId('Repository', (source as unknown as RepoRec).id) },
    databaseId: { type: 'Int', resolve: (_ctx, source) => (source as unknown as RepoRec).id },
    name: { type: 'String', resolve: (_ctx, source) => (source as unknown as RepoRec).name },
    nameWithOwner: {
      type: 'String',
      resolve: (_ctx, source) => {
        const repo = source as unknown as RepoRec;
        return `${repo.owner}/${repo.name}`;
      },
    },
    owner: { type: 'User', resolve: (_ctx, source) => ({ login: (source as unknown as RepoRec).owner }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (_ctx, source) => {
        const repo = source as unknown as RepoRec;
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null;
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    description: { type: 'String', resolve: (_ctx, source) => (source as unknown as RepoRec).description },
    isPrivate: { type: 'Boolean', resolve: (_ctx, source) => (source as unknown as RepoRec).isPrivate },
    issue: {
      type: 'Issue',
      resolve: (_ctx, source, args) => {
        const repo = source as unknown as RepoRec;
        const rec = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        return rec ? wrapIssue(repo, rec) : null;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (ctx, source, args) => {
        const repo = source as unknown as RepoRec;
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
        const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
        const descending = orderBy?.direction !== 'ASC'; // gh's list defaults to newest first
        issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
        let start = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          try {
            const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
            const number = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
            const index = issues.findIndex((issue) => issue.number === number);
            if (index >= 0) start = index + 1;
          } catch {
            start = 0;
          }
        }
        const first = typeof args.first === 'number' ? args.first : 30;
        const page = issues.slice(start, start + first);
        const hasNextPage = start + page.length < issues.length;
        const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as IssueRec).number) : null;
        return { __nodes: page.map((rec) => wrapIssue(repo, rec)), __pageInfo: { hasNextPage, endCursor } };
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (_ctx, source, args) => {
        const repo = source as unknown as RepoRec;
        const rec = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        return rec ? wrapPull(repo, rec) : null;
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (_ctx, source, args) => {
        const repo = source as unknown as RepoRec;
        const open = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? args.first : 30;
        return { __nodes: open.slice(0, first).map((rec) => wrapPull(repo, rec)) };
      },
    },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (_ctx, source) => (source as { __nodes: unknown }).__nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source) => (source as { __pageInfo: unknown }).__pageInfo },
    totalCount: { type: 'Int', resolve: (_ctx, source) => ((source as { __nodes: unknown[] }).__nodes ?? []).length },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (_ctx, source) => (source as { __nodes: unknown }).__nodes },
    totalCount: { type: 'Int', resolve: (_ctx, source) => ((source as { __nodes: unknown[] }).__nodes ?? []).length },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage },
    endCursor: { type: 'String', resolve: (_ctx, source) => (source as { endCursor: string | null }).endCursor },
    hasPreviousPage: { type: 'Boolean', resolve: () => false },
    startCursor: { type: 'String', resolve: (_ctx, source) => (source as { endCursor: string | null }).endCursor },
  },
  Ref: {
    name: { type: 'String', resolve: (_ctx, source) => (source as { name: string }).name },
  },
  Issue: {
    id: {
      type: 'ID',
      resolve: (_ctx, source) => {
        const wrapped = source as { __repo: RepoRec; __rec: IssueRec };
        return globalId('Issue', wrapped.__repo.id, wrapped.__rec.number);
      },
    },
    number: { type: 'Int', resolve: (_ctx, source) => (source as { __rec: IssueRec }).__rec.number },
    title: { type: 'String', resolve: (_ctx, source) => (source as { __rec: IssueRec }).__rec.title },
    body: { type: 'String', resolve: (_ctx, source) => (source as { __rec: IssueRec }).__rec.body },
    state: { type: 'String', resolve: (_ctx, source) => (source as { __rec: IssueRec }).__rec.state.toUpperCase() },
  },
  PullRequest: {
    id: {
      type: 'ID',
      resolve: (_ctx, source) => {
        const wrapped = source as { __repo: RepoRec; __rec: PullRec };
        return globalId('PullRequest', wrapped.__repo.id, wrapped.__rec.number);
      },
    },
    number: { type: 'Int', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.number },
    title: { type: 'String', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.title },
    body: { type: 'String', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.body },
    state: {
      type: 'String',
      resolve: (_ctx, source) => {
        const rec = (source as { __rec: PullRec }).__rec;
        return rec.merged ? 'MERGED' : rec.state.toUpperCase();
      },
    },
    merged: { type: 'Boolean', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.merged },
    headRefName: { type: 'String', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.headRef },
    baseRefName: { type: 'String', resolve: (_ctx, source) => (source as { __rec: PullRec }).__rec.baseRef },
    mergeable: {
      type: 'String',
      resolve: (ctx, source) => {
        const wrapped = source as { __repo: RepoRec; __rec: PullRec };
        const baseTip = ctx.forge.branchTip(wrapped.__repo, wrapped.__rec.baseRef);
        const headTip = ctx.forge.branchTip(wrapped.__repo, wrapped.__rec.headRef);
        if (baseTip === null || headTip === null) return 'UNKNOWN';
        return threeWayMerge(ctx.forge, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
      },
    },
    files: {
      type: 'ChangedFileConnection',
      resolve: (ctx, source, args) => {
        const wrapped = source as { __repo: RepoRec; __rec: PullRec };
        const first = typeof args.first === 'number' ? args.first : 30;
        const paths = pullChanges(ctx.forge, wrapped.__repo, wrapped.__rec).slice(0, first).map((change) => change.path);
        return { __nodes: paths.map((path) => ({ path })) };
      },
    },
  },
  ChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (_ctx, source) => (source as { __nodes: unknown }).__nodes },
    totalCount: { type: 'Int', resolve: (_ctx, source) => ((source as { __nodes: unknown[] }).__nodes ?? []).length },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (_ctx, source) => (source as { path: string }).path },
  },
  __Type: {
    name: { type: 'String', resolve: (_ctx, source) => (source as { __name: string }).__name },
    kind: { type: 'String', resolve: (_ctx, source) => (source as { __kind: string }).__kind },
    fields: {
      type: '[__Field]',
      resolve: (_ctx, source) => {
        const name = (source as { __name: string }).__name;
        const fields = TYPE_FIELDS[name];
        return fields === undefined ? null : fields.map((fieldName) => ({ name: fieldName }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (_ctx, source) => {
        const name = (source as { __name: string }).__name;
        const values = TYPE_ENUMS[name];
        return values === undefined ? null : values.map((valueName) => ({ name: valueName }));
      },
    },
  },
  __Field: {
    name: { type: 'String', resolve: (_ctx, source) => (source as { name: string }).name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (_ctx, source) => (source as { name: string }).name },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(ctx, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const rec = ctx.forge.newIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        return { __issue: wrapIssue(repo, rec) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(ctx, input.issueId);
        if (found === null) throw new Error('issue not found');
        found.rec.state = 'closed';
        return { __issue: wrapIssue(found.repo, found.rec) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(ctx, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (ctx.forge.branchTip(repo, head) === null || ctx.forge.branchTip(repo, base) === null) {
          throw new Error('head or base branch does not exist');
        }
        const rec = ctx.forge.newPull(repo, typeof input.title === 'string' ? input.title : '', '', head, base);
        return { __pull: wrapPull(repo, rec) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromGlobalId(ctx, input.pullRequestId);
        if (found === null) throw new Error('pull request not found');
        if (!found.rec.merged) {
          const sha = mergePull(ctx.forge, found.repo, found.rec);
          if (sha === null) throw new Error('pull request is not mergeable');
        }
        return { __pull: wrapPull(found.repo, found.rec) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(ctx, input.subjectId);
        if (found === null) throw new Error('subject not found');
        const comment = ctx.forge.newComment(found.rec, typeof input.body === 'string' ? input.body : '');
        return { __comment: { id: globalId('IssueComment', found.repo.id, found.rec.number, comment.id), body: comment.body } };
      },
    },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => (source as { __issue: unknown }).__issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => (source as { __issue: unknown }).__issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => (source as { __pull: unknown }).__pull },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => (source as { __pull: unknown }).__pull },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (_ctx, source) => ({ __node: (source as { __comment: unknown }).__comment }) },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (_ctx, source) => (source as { __node: unknown }).__node },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (_ctx, source) => (source as { id: string }).id },
    body: { type: 'String', resolve: (_ctx, source) => (source as { body: string }).body },
  },
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function executeSelectionSet(ctx: ExecCtx, typeName: string, source: Source, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const def = FIELDS[typeName]?.[selection.name];
    if (def === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of selection.args) args[argName] = evalValue(argValue, ctx.variables);
    let value: unknown;
    try {
      value = def.resolve(ctx, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, def.type, value, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: ExecCtx, type: string, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue(ctx, inner, item, selectionSet));
  }
  if (SCALARS.has(type)) return value;
  if (selectionSet === null) return value;
  let concreteType = type;
  let source = value as Source;
  if (typeof value === 'object' && value !== null && '__gqlType' in (value as Record<string, unknown>)) {
    const tagged = value as { __gqlType: string; __value: Source };
    concreteType = tagged.__gqlType;
    source = tagged.__value;
  }
  return executeSelectionSet(ctx, concreteType, source, selectionSet);
}

interface OperationRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function executeOperation(forge: Forge, request: OperationRequest): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    document.operations.find((op) => request.operationName !== undefined && op.name === request.operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecCtx = {
    forge,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

/** Handle one POST /api/graphql request (a single operation, or a batched array of them). */
export function handleGraphQL(forge: Forge, req: Req): Res {
  if (req.method !== 'POST') return jsonRes(405, { errors: [{ message: 'GraphQL only accepts POST' }] });
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonRes(400, { errors: [{ message: 'the request body is not JSON' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOperation(forge, entry as OperationRequest));
    return jsonRes(200, results);
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as OperationRequest).query !== 'string') {
    return jsonRes(400, { errors: [{ message: 'the request body holds no query' }] });
  }
  return jsonRes(200, executeOperation(forge, parsed as OperationRequest));
}
