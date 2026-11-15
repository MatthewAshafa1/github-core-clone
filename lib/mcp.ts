// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
//
// Two eras are spoken. A modern client (revision 2026-07-28) opens with
// `server/discover`, which answers the server's identity, capabilities and
// supported revisions in one request; there is no handshake and no session.
// A legacy client opens with `initialize` (offering an older revision) and
// `notifications/initialized` instead. Either way the tools act on the same
// store the REST surface reads, so a repository or an issue created over MCP
// reads back over /api/v3 as the same object.

import { Forge, ForgeError, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOL_LIST: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the token user.',
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
    description: 'Read one repository by owner and name.',
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
    name: 'list_repos',
    description: 'List the repositories owned by the token user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
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
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS: readonly ToolDef[] = Object.freeze(TOOL_LIST);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
  };
}

function issueJson(issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function pullJson(pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

/** Split an owner/repo pair out of the arguments, accepting full_name too. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = asString(args.owner ?? args.owner_login);
  let repo = asString(args.repo ?? args.repository);
  const full = asString(args.full_name ?? args.repo_full_name);
  if ((owner === '' || repo === '') && full.includes('/')) {
    const [first, second] = full.split('/', 2);
    if (owner === '') owner = first ?? '';
    if (repo === '') repo = second ?? '';
  }
  return { owner, repo };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  list_repos: [],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  get_issue: ['owner', 'repo', 'issue_number'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
});

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  const required = REQUIRED_ARGS[name] ?? [];
  const missing = required.filter((key) => {
    if (key === 'owner' || key === 'repo') {
      const pair = ownerRepo(args);
      return (key === 'owner' ? pair.owner : pair.repo) === '';
    }
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo({
          name: asString(args.name),
          isPrivate: typeof args.private === 'boolean' ? args.private : false,
          description: asString(args.description),
        });
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        return toolResult(repoJson(found));
      }
      case 'list_repos': {
        return toolResult({ repositories: forge.listRepos().map((repo) => repoJson(repo)) });
      }
      case 'create_issue': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        const issue = forge.createIssue(found, { title: asString(args.title), body: asString(args.body), labels: [] });
        return toolResult(issueJson(issue));
      }
      case 'list_issues': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        const state = asString(args.state) || 'open';
        const issues = forge.listIssues(found, { state, direction: 'desc' });
        return toolResult({ issues: issues.map((issue) => issueJson(issue)) });
      }
      case 'get_issue': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        const number = asNumber(args.issue_number ?? args.number);
        const issue = number === null ? undefined : forge.getIssue(found, number);
        if (issue === undefined) return toolError(`Issue #${String(number ?? '')} not found`);
        return toolResult(issueJson(issue));
      }
      case 'create_pull_request': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        const pull = forge.createPull(found, {
          title: asString(args.title),
          body: asString(args.body),
          head: asString(args.head),
          base: asString(args.base),
        });
        return toolResult(pullJson(pull));
      }
      case 'merge_pull_request': {
        const { owner, repo } = ownerRepo(args);
        const found = forge.getRepo(owner, repo);
        if (found === undefined) return toolError(`Repository ${owner}/${repo} not found`);
        const number = asNumber(args.pull_number ?? args.number);
        if (number === null) return toolError('Missing required argument: pull_number');
        const merged = forge.mergePull(found, number);
        return toolResult({ merged: true, sha: merged.sha, message: `Pull request #${number} merged` });
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ForgeError) return toolError(err.message);
    throw err;
  }
}

interface RpcResponse {
  status: number;
  body: unknown;
}

function rpcOk(id: unknown, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/**
 * Handle one POST /mcp body (already read as text). Auth is decided by the
 * caller before this runs: without a bearer token the answer is 401.
 */
export function handleMcp(forge: Forge, bodyText: string): RpcResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = body.id ?? null;
  const method = asString(body.method);
  if (method === '') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  // A notification carries no id and expects no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return rpcOk(id, {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: [...SUPPORTED_VERSIONS],
      protocolVersion: '2026-07-28',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const params = isRecord(body.params) ? body.params : {};
    const offered = asString(params.protocolVersion);
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcOk(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcOk(id, {});
  }
  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })) });
  }
  if (method === 'tools/call') {
    const params = isRecord(body.params) ? body.params : {};
    const toolName = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') {
      return rpcError(id, -32602, 'Invalid params: a tool name is required');
    }
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    return rpcOk(id, callTool(forge, toolName, args));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
