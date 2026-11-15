// A small GraphQL executor for the documents gh and github-mcp-server
// send: viewer and repository reads, issue and pull-request connections,
// Relay global ids, introspection of the types those clients probe, and
// the five mutations (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment).
//
// It is a real parser and executor, not a set of string matches: the query
// is lexed, parsed into selections, and resolved field by field against the
// same store the REST surface reads. A field the schema does not hold is
// an HTTP 200 with an errors array naming it, as GitHub answers.

import { Forge, VIEWER, decodeNodeId, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { base64urlDecode, base64urlEncode } from './util.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const ch = input[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\' && index + 1 < input.length) {
          const next = input[index + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          index += 2;
        } else {
          value += input[index] as string;
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[index + 1] ?? ''))) {
      let value = '';
      let floating = false;
      while (index < input.length && /[0-9.eE+-]/.test(input[index] as string)) {
        if (input[index] === '.' || input[index] === 'e' || input[index] === 'E') floating = true;
        value += input[index] as string;
        index += 1;
      }
      tokens.push({ kind: floating ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index] as string)) {
        value += input[index] as string;
        index += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (input.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    index += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  type: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  type: string;
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new ParseError(`expected ${value}, got ${token.value}`);
    return token;
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelections() });
      } else if (this.peek().value === 'query' || this.peek().value === 'mutation') {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, selections: this.parseSelections() });
      } else if (this.peek().value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.expect('on');
        const type = this.next().value;
        this.skipDirectives();
        fragments.set(name, { name, type, selections: this.parseSelections() });
      } else {
        throw new ParseError(`unexpected token ${this.peek().value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new ParseError('unterminated variable definitions');
      if (token.value === '(') depth += 1;
      if (token.value === ')') depth -= 1;
    }
  }

  private parseSelections(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().value === 'on') {
        this.next();
        const type = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', type, selections: this.parseSelections() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', type: null, selections: this.parseSelections() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new ParseError(`expected a field name, got ${first.value}`);
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    const selections = this.peek().value === '{' ? this.parseSelections() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    if (token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') return { kind: 'enum', value: token.value };
    throw new ParseError(`unexpected value token ${token.value}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of node.fields) out[key] = valueOf(child, variables);
      return out;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// schema tables for introspection
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Readonly<Record<string, TypeInfo>> = Object.freeze({
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'assignees'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author', 'labels', 'commits'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'defaultBranch'],
  },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
});

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type Resolved =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'Viewer' }
  | { type: 'Repository'; repo: RepoRec }
  | { type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { type: 'User'; login: string }
  | { type: 'Ref'; name: string }
  | { type: 'Type'; name: string }
  | { type: 'IssueConnection'; repo: RepoRec; issues: IssueRec[]; hasNext: boolean; endCursor: string | null }
  | { type: 'PullRequestConnection'; repo: RepoRec; pulls: PullRec[] }
  | { type: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { type: 'ChangedFiles'; repo: RepoRec; pull: PullRec; paths: string[] }
  | { type: 'ChangedFile'; path: string }
  | { type: 'CommentEdge'; repo: RepoRec; issueNumber: number; commentId: number; body: string }
  | { type: 'Comment'; id: string; body: string }
  | { type: 'TypeField'; name: string }
  | { type: 'EnumValue'; name: string }
  | { type: 'CreateIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { type: 'CloseIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { type: 'CreatePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { type: 'MergePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { type: 'AddCommentPayload'; repo: RepoRec; issueNumber: number; commentId: number; body: string };

const ROOT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'defaultBranch'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'assignees'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author', 'labels', 'commits'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  ChangedFiles: ['nodes', 'totalCount'],
  ChangedFile: ['path'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body'],
  TypeField: ['name'],
  EnumValue: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
});

class Executor {
  private readonly errors: Array<{ message: string }> = [];
  private readonly forge: Forge;
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, FragmentNode>;

  constructor(forge: Forge, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>) {
    this.forge = forge;
    this.variables = variables;
    this.fragments = fragments;
  }

  getErrors(): Array<{ message: string }> {
    return this.errors;
  }

  execute(operation: OperationNode): Record<string, unknown> {
    const root: Resolved = operation.kind === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
    const data = this.applySelections(root, operation.selections);
    return data;
  }

  private argsOf(field: FieldNode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, node] of field.args) out[key] = valueOf(node, this.variables);
    return out;
  }

  private applySelections(value: Resolved, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        out[key] = this.resolveField(value, selection);
      } else if (selection.kind === 'inline') {
        if (selection.type === null || selection.type === value.type) {
          Object.assign(out, this.applySelections(value, selection.selections));
        }
      } else {
        const fragment = this.fragments.get(selection.name);
        if (fragment !== undefined && fragment.type === value.type) {
          Object.assign(out, this.applySelections(value, fragment.selections));
        }
      }
    }
    return out;
  }

  private resolveField(parent: Resolved, field: FieldNode): unknown {
    const allowed = ROOT_FIELDS[parent.type] ?? [];
    if (!allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.type}".` });
      return null;
    }
    const args = this.argsOf(field);
    const child = this.fieldValue(parent, field.name, args);
    if (child === null || child === undefined) return null;
    if (typeof child === 'object' && 'type' in (child as Record<string, unknown>) && field.selections !== null) {
      return this.applySelections(child as Resolved, field.selections);
    }
    if (Array.isArray(child)) {
      if (field.selections === null) return child;
      return child.map((entry) => {
        if (entry !== null && typeof entry === 'object' && 'type' in (entry as Record<string, unknown>)) {
          return this.applySelections(entry as Resolved, field.selections as SelectionNode[]);
        }
        return entry;
      });
    }
    return child;
  }

  private fieldValue(parent: Resolved, name: string, args: Record<string, unknown>): unknown {
    switch (parent.type) {
      case 'Query': {
        if (name === 'viewer') return { type: 'Viewer' } as Resolved;
        if (name === 'repository') {
          const repo = this.forge.getRepo(asString(args.owner), asString(args.name));
          return repo === undefined ? null : ({ type: 'Repository', repo } as Resolved);
        }
        if (name === 'node') {
          const decoded = decodeNodeId(asString(args.id));
          if (decoded === null) return null;
          const repo = this.forge.getRepo(decoded.owner, decoded.repo);
          if (repo === undefined) return null;
          if (decoded.kind === 'Repository') return { type: 'Repository', repo } as Resolved;
          if (decoded.kind === 'Issue' && decoded.number !== null) {
            const issue = this.forge.getIssue(repo, decoded.number);
            return issue === undefined ? null : ({ type: 'Issue', repo, issue } as Resolved);
          }
          if (decoded.kind === 'PullRequest' && decoded.number !== null) {
            const pull = this.forge.getPull(repo, decoded.number);
            return pull === undefined ? null : ({ type: 'PullRequest', repo, pull } as Resolved);
          }
          return null;
        }
        if (name === '__type') {
          const typeName = asString(args.name);
          return SCHEMA[typeName] === undefined ? null : ({ type: 'Type', name: typeName } as Resolved);
        }
        if (name === '__schema') return null;
        return null;
      }
      case 'Mutation': {
        if (name === 'createIssue') return this.createIssue(args);
        if (name === 'closeIssue') return this.closeIssue(args);
        if (name === 'createPullRequest') return this.createPullRequest(args);
        if (name === 'mergePullRequest') return this.mergePullRequest(args);
        if (name === 'addComment') return this.addComment(args);
        return null;
      }
      case 'Viewer': {
        return name === 'login' ? VIEWER.login : null;
      }
      case 'Repository': {
        const repo = parent.repo;
        switch (name) {
          case 'id':
            return repo.nodeId;
          case 'databaseId':
            return repo.dbId;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return `${repo.owner}/${repo.name}`;
          case 'owner':
            return { type: 'User', login: repo.owner } as Resolved;
          case 'defaultBranchRef': {
            const tip = this.forge.refTip(repo, repo.defaultBranch);
            return tip === undefined ? null : ({ type: 'Ref', name: repo.defaultBranch } as Resolved);
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'description':
            return repo.description;
          case 'url':
            return '';
          case 'isPrivate':
            return repo.isPrivate;
          case 'defaultBranch':
            return repo.defaultBranch;
          case 'issue': {
            const issue = this.forge.getIssue(repo, Number(args.number));
            return issue === undefined ? null : ({ type: 'Issue', repo, issue } as Resolved);
          }
          case 'issues':
            return this.issueConnection(repo, args);
          case 'pullRequests': {
            const pulls = this.forge.listPulls(repo, 'open');
            const first = typeof args.first === 'number' ? args.first : pulls.length;
            return { type: 'PullRequestConnection', repo, pulls: pulls.slice(0, first) } as Resolved;
          }
          case 'pullRequest': {
            const pull = this.forge.getPull(repo, Number(args.number));
            return pull === undefined ? null : ({ type: 'PullRequest', repo, pull } as Resolved);
          }
          default:
            return null;
        }
      }
      case 'Issue': {
        const issue = parent.issue;
        switch (name) {
          case 'id':
            return issue.nodeId;
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'body':
            return issue.body;
          case 'state':
            return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'url':
            return '';
          case 'author':
            return { type: 'User', login: VIEWER.login } as Resolved;
          default:
            return null;
        }
      }
      case 'PullRequest': {
        const pull = parent.pull;
        switch (name) {
          case 'id':
            return pull.nodeId;
          case 'number':
            return pull.number;
          case 'title':
            return pull.title;
          case 'body':
            return pull.body;
          case 'state':
            return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged':
            return pull.merged;
          case 'mergeable':
            return this.forge.mergeable(parent.repo, pull);
          case 'headRefName':
            return pull.headRef;
          case 'baseRefName':
            return pull.baseRef;
          case 'files': {
            const files = this.forge.pullFiles(parent.repo, pull);
            const first = typeof args.first === 'number' ? args.first : files.length;
            return { type: 'ChangedFiles', repo: parent.repo, pull, paths: files.slice(0, first).map((file) => file.filename) } as Resolved;
          }
          case 'author':
            return { type: 'User', login: VIEWER.login } as Resolved;
          default:
            return null;
        }
      }
      case 'User': {
        if (name === 'login') return parent.login;
        if (name === 'id') return VIEWER.id;
        if (name === 'name') return VIEWER.name;
        if (name === 'email') return VIEWER.email;
        return null;
      }
      case 'Ref': {
        return name === 'name' ? parent.name : null;
      }
      case 'Type': {
        const info = SCHEMA[parent.name];
        if (info === undefined) return null;
        if (name === 'name') return parent.name;
        if (name === 'kind') return info.kind;
        if (name === 'description') return null;
        if (name === 'fields') {
          return (info.fields ?? []).map((fieldName) => ({ type: 'TypeField', name: fieldName }) as Resolved);
        }
        if (name === 'enumValues') {
          return (info.enumValues ?? []).map((enumName) => ({ type: 'EnumValue', name: enumName }) as Resolved);
        }
        return null;
      }
      case 'IssueConnection': {
        if (name === 'nodes') return parent.issues.map((issue) => ({ type: 'Issue', repo: parent.repo, issue }) as Resolved);
        if (name === 'totalCount') return parent.issues.length;
        if (name === 'pageInfo') return { type: 'PageInfo', hasNext: parent.hasNext, endCursor: parent.endCursor } as Resolved;
        return null;
      }
      case 'PullRequestConnection': {
        if (name === 'nodes') return parent.pulls.map((pull) => ({ type: 'PullRequest', repo: parent.repo, pull }) as Resolved);
        if (name === 'totalCount') return parent.pulls.length;
        if (name === 'pageInfo') return { type: 'PageInfo', hasNext: false, endCursor: null } as Resolved;
        return null;
      }
      case 'PageInfo': {
        if (name === 'hasNextPage') return parent.hasNext;
        if (name === 'hasPreviousPage') return false;
        if (name === 'endCursor') return parent.endCursor;
        if (name === 'startCursor') return null;
        return null;
      }
      case 'ChangedFiles': {
        if (name === 'nodes') return parent.paths.map((path) => ({ type: 'ChangedFile', path }) as Resolved);
        if (name === 'totalCount') return parent.paths.length;
        return null;
      }
      case 'ChangedFile': {
        return name === 'path' ? parent.path : null;
      }
      case 'CommentEdge': {
        if (name === 'node') return { type: 'Comment', id: parent.commentId.toString(), body: parent.body } as Resolved;
        if (name === 'cursor') return '';
        return null;
      }
      case 'Comment': {
        if (name === 'id') return parent.id;
        if (name === 'body') return parent.body;
        return null;
      }
      case 'TypeField':
      case 'EnumValue': {
        return name === 'name' ? parent.name : null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (name === 'issue') return { type: 'Issue', repo: parent.repo, issue: parent.issue } as Resolved;
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (name === 'pullRequest') return { type: 'PullRequest', repo: parent.repo, pull: parent.pull } as Resolved;
        return null;
      }
      case 'AddCommentPayload': {
        if (name === 'commentEdge') {
          return { type: 'CommentEdge', repo: parent.repo, issueNumber: parent.issueNumber, commentId: parent.commentId, body: parent.body } as Resolved;
        }
        return null;
      }
      default:
        return null;
    }
  }

  private issueConnection(repo: RepoRec, args: Record<string, unknown>): Resolved {
    let issues = this.forge.listIssues(repo, { state: 'all', direction: 'asc' });
    if (Array.isArray(args.states)) {
      const wanted = new Set((args.states as unknown[]).map((state) => String(state)));
      issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
    const direction = String(orderBy.direction ?? 'ASC');
    const field = String(orderBy.field ?? 'CREATED_AT');
    if (field === 'CREATED_AT') {
      issues = [...issues].sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
    }
    if (typeof args.after === 'string' && args.after !== '') {
      const decoded = base64urlDecode(args.after);
      const match = decoded === null ? null : /^issue:(\d+)$/.exec(decoded);
      if (match !== null) {
        const cursorSeq = Number(match[1]);
        issues = issues.filter((issue) => (direction === 'DESC' ? issue.seq < cursorSeq : issue.seq > cursorSeq));
      }
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNext = issues.length > first;
    const endCursor = page.length > 0 ? base64urlEncode(`issue:${page[page.length - 1]?.seq ?? 0}`) : null;
    return { type: 'IssueConnection', repo, issues: page, hasNext, endCursor };
  }

  private repoFromGlobalId(id: string): RepoRec | null {
    const decoded = decodeNodeId(id);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    return this.forge.getRepo(decoded.owner, decoded.repo) ?? null;
  }

  private createIssue(args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const repo = this.repoFromGlobalId(asString(input.repositoryId));
    if (repo === null) {
      this.errors.push({ message: 'repository not found' });
      return null;
    }
    try {
      const issue = this.forge.createIssue(repo, { title: asString(input.title), body: asString(input.body), labels: [] });
      return { type: 'CreateIssuePayload', repo, issue } as Resolved;
    } catch (err) {
      this.errors.push({ message: err instanceof Error ? err.message : 'createIssue failed' });
      return null;
    }
  }

  private closeIssue(args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const decoded = decodeNodeId(asString(input.issueId));
    if (decoded === null || decoded.kind !== 'Issue' || decoded.number === null) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    const repo = this.forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    const issue = this.forge.patchIssue(repo, decoded.number, { state: 'closed' });
    return { type: 'CloseIssuePayload', repo, issue } as Resolved;
  }

  private createPullRequest(args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const repo = this.repoFromGlobalId(asString(input.repositoryId));
    if (repo === null) {
      this.errors.push({ message: 'repository not found' });
      return null;
    }
    try {
      const pull = this.forge.createPull(repo, {
        title: asString(input.title),
        body: asString(input.body),
        head: asString(input.headRefName),
        base: asString(input.baseRefName),
      });
      return { type: 'CreatePullRequestPayload', repo, pull } as Resolved;
    } catch (err) {
      this.errors.push({ message: err instanceof Error ? err.message : 'createPullRequest failed' });
      return null;
    }
  }

  private mergePullRequest(args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const decoded = decodeNodeId(asString(input.pullRequestId));
    if (decoded === null || decoded.kind !== 'PullRequest' || decoded.number === null) {
      this.errors.push({ message: 'pull request not found' });
      return null;
    }
    const repo = this.forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) {
      this.errors.push({ message: 'pull request not found' });
      return null;
    }
    const pull = this.forge.getPull(repo, decoded.number);
    if (pull === undefined) {
      this.errors.push({ message: 'pull request not found' });
      return null;
    }
    try {
      this.forge.mergePull(repo, decoded.number);
    } catch (err) {
      this.errors.push({ message: err instanceof Error ? err.message : 'mergePullRequest failed' });
      return null;
    }
    return { type: 'MergePullRequestPayload', repo, pull } as Resolved;
  }

  private addComment(args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const decoded = decodeNodeId(asString(input.subjectId));
    if (decoded === null || decoded.kind !== 'Issue' || decoded.number === null) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    const repo = this.forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) {
      this.errors.push({ message: 'issue not found' });
      return null;
    }
    const comment = this.forge.addComment(repo, decoded.number, asString(input.body));
    return {
      type: 'AddCommentPayload',
      repo,
      issueNumber: decoded.number,
      commentId: comment.id,
      body: comment.body,
    } as Resolved;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Run one GraphQL request body (a single operation object, or an array of
 * them for GitHub's operation batching) and answer the response body.
 */
export function executeGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  const runOne = (operationBody: unknown): Record<string, unknown> => {
    if (!isRecord(operationBody) || typeof operationBody.query !== 'string') {
      return { errors: [{ message: 'a GraphQL query string is required' }] };
    }
    const variables = isRecord(operationBody.variables) ? operationBody.variables : {};
    let parsed;
    try {
      parsed = new Parser(lex(operationBody.query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'query could not be parsed' }] };
    }
    const operation =
      typeof operationBody.operationName === 'string'
        ? parsed.operations.find((entry) => entry.name === operationBody.operationName) ?? parsed.operations[0]
        : parsed.operations[0];
    if (operation === undefined) {
      return { errors: [{ message: 'no operation in the query' }] };
    }
    const executor = new Executor(forge, variables, parsed.fragments);
    const data = executor.execute(operation);
    const errors = executor.getErrors();
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
