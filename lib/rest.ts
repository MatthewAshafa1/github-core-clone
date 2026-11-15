// The REST v3 API under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels, pull requests and git refs.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id, an
// error is a JSON body with a string message, and a repository belongs to
// the login the token names, so the same name under another owner is a 404,
// never a 403. Pagination follows GitHub: `per_page` and `page`, with a
// Link header whose rel="next" points at the next page when there is one.

import { getObject, parseCommit } from './gitcore.ts';
import { Forge, ForgeError, VIEWER, type IssueRec, type Label, type PullRec, type RepoRec } from './store.ts';
import { EPOCH_BASE_SEC, isoAt } from './util.ts';

export interface RestCtx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyError: boolean;
  origin: string;
}

export interface RestOut {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function identParts(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: isoAt(Number(match[3])) };
}

function repoUrl(origin: string, repo: RepoRec): string {
  return `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
}

function repoJson(repo: RepoRec, origin: string): Record<string, unknown> {
  const url = repoUrl(origin, repo);
  return {
    id: repo.dbId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: '', type: 'User', site_admin: false },
    private: repo.isPrivate,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url,
    created_at: isoAt(EPOCH_BASE_SEC + repo.seq),
    updated_at: isoAt(EPOCH_BASE_SEC + repo.seq),
    pushed_at: isoAt(EPOCH_BASE_SEC + repo.seq),
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: RepoRec, label: Label, origin: string): Record<string, unknown> {
  const index = [...repo.labels.keys()].indexOf(label.name);
  return {
    id: index + 1,
    node_id: '',
    url: `${repoUrl(origin, repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(issue: IssueRec, repo: RepoRec, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${repoUrl(origin, repo)}/issues/${issue.number}`,
    repository_url: repoUrl(origin, repo),
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((label) => labelJson(repo, label, origin)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: isoAt(EPOCH_BASE_SEC + issue.seq),
    updated_at: isoAt(EPOCH_BASE_SEC + issue.seq),
    closed_at: issue.state === 'closed' ? isoAt(EPOCH_BASE_SEC + issue.seq) : null,
    author_association: 'OWNER',
  };
}

function pullJson(pull: PullRec, repo: RepoRec, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${repoUrl(origin, repo)}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [],
    milestone: null,
    created_at: isoAt(EPOCH_BASE_SEC + pull.seq),
    updated_at: isoAt(EPOCH_BASE_SEC + pull.seq),
    closed_at: pull.state === 'closed' ? isoAt(EPOCH_BASE_SEC + pull.seq) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    merged_by: pull.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo, origin),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo, origin),
    },
    author_association: 'OWNER',
  };
}

function commentJson(repo: RepoRec, issueNumber: number, comment: { id: number; nodeId: string; body: string; seq: number }, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${repoUrl(origin, repo)}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoAt(EPOCH_BASE_SEC + comment.seq),
    updated_at: isoAt(EPOCH_BASE_SEC + comment.seq),
    author_association: 'OWNER',
  };
}

function branchJson(repo: RepoRec, name: string, sha: string, origin: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${repoUrl(origin, repo)}/commits/${sha}` },
    protected: false,
  };
}

function commitJson(forge: Forge, repo: RepoRec, sha: string, message: string, author: string, committer: string, parents: string[], tree: string, origin: string): Record<string, unknown> {
  const authorParts = identParts(author);
  const committerParts = identParts(committer);
  return {
    sha,
    node_id: '',
    commit: {
      author: authorParts,
      committer: committerParts,
      message,
      tree: { sha: tree },
      url: `${repoUrl(origin, repo)}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${repoUrl(origin, repo)}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${repoUrl(origin, repo)}/commits/${sha}/comments`,
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: parents.map((parent) => ({ sha: parent, url: `${repoUrl(origin, repo)}/commits/${parent}` })),
  };
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, origin: string): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const link = (targetPage: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `<${origin}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(link(page + 1, 'next'), link(lastPage, 'last'));
  if (page > 1) parts.push(link(1, 'first'), link(page - 1, 'prev'));
  if (parts.length > 0) headers.link = parts.join(', ');
  return { page: [...pageItems], headers };
}

function notFound(): RestOut {
  return { status: 404, body: { message: 'Not Found' } };
}

function requireRepo(forge: Forge, owner: string, name: string): RepoRec {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ForgeError(404, 'Not Found');
  return repo;
}

function badBody(ctx: RestCtx): RestOut | null {
  if (ctx.bodyError) return { status: 400, body: { message: 'Invalid JSON body' } };
  return null;
}

export function handleRest(forge: Forge, ctx: RestCtx): RestOut {
  try {
    return dispatch(forge, ctx);
  } catch (err) {
    if (err instanceof ForgeError) return { status: err.status, body: { message: err.message } };
    throw err;
  }
}

function dispatch(forge: Forge, ctx: RestCtx): RestOut {
  const { method, segments: s, query, origin } = ctx;
  const bad = badBody(ctx);
  if (bad !== null && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) return bad;

  // The API root and the meta probe.
  if (s.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: `${origin}/api/v3/user`, rate_limit_url: `${origin}/api/v3/rate_limit` },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method === 'GET') return { status: 200, body: { installed_version: '1.0.0', version: '1.0.0' } };
    return notFound();
  }

  // The token's user.
  if (s.length === 1 && s[0] === 'user') {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          login: VIEWER.login,
          id: VIEWER.id,
          node_id: '',
          type: 'User',
          name: VIEWER.name,
          email: VIEWER.email,
          html_url: `${origin}/${VIEWER.login}`,
          url: `${origin}/api/v3/users/${VIEWER.login}`,
        },
      };
    }
    return notFound();
  }

  // The token's repositories.
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { page, headers } = paginate(repos, query, '/api/v3/user/repos', origin);
      return { status: 200, body: page.map((repo) => repoJson(repo, origin)), headers };
    }
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = asString(body.name);
      if (name === '') return { status: 422, body: { message: 'name is required' } };
      const repo = forge.createRepo({
        name,
        isPrivate: asBoolean(body.private, false),
        description: asString(body.description),
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
      });
      return { status: 201, body: repoJson(repo, origin) };
    }
    return notFound();
  }

  if (s.length >= 3 && s[0] === 'repos') {
    return dispatchRepo(forge, ctx, s[1] as string, s[2] as string);
  }
  return notFound();
}

function dispatchRepo(forge: Forge, ctx: RestCtx, owner: string, name: string): RestOut {
  const { method, segments: s, query, origin } = ctx;
  const rest = s.slice(3);

  // /repos/{owner}/{repo} itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(requireRepo(forge, owner, name), origin) };
    if (method === 'PATCH') {
      const repo = requireRepo(forge, owner, name);
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return { status: 200, body: repoJson(repo, origin) };
    }
    if (method === 'DELETE') {
      if (!forge.deleteRepo(owner, name)) return notFound();
      return { status: 204, body: null };
    }
    return notFound();
  }

  const repo = requireRepo(forge, owner, name);
  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = forge.listBranches(repo);
      return { status: 200, body: branches.map((branch) => branchJson(repo, branch.name, branch.sha, origin)) };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branchName = rest.slice(1).join('/');
      const sha = forge.refTip(repo, branchName);
      if (sha === undefined) return notFound();
      return { status: 200, body: branchJson(repo, branchName, sha, origin) };
    }
    return notFound();
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? undefined;
      const commits = forge.listCommits(repo, ref);
      const { page, headers } = paginate(commits, query, `/api/v3/repos/${owner}/${name}/commits`, origin);
      return {
        status: 200,
        body: page.map((commit) => commitJson(forge, repo, commit.sha, commit.message, commit.author, commit.committer, commit.parents, commit.tree, origin)),
        headers,
      };
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      const object = getObject(forge.objects, sha);
      if (object?.type !== 'commit') return notFound();
      const parsed = parseCommit(object.data);
      return {
        status: 200,
        body: commitJson(forge, repo, sha, parsed.message, parsed.author, parsed.committer, parsed.parents, parsed.tree, origin),
      };
    }
    return notFound();
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const message = asString(body.message);
      const content = asString(body.content);
      if (message === '' || content === '') return { status: 422, body: { message: 'message and content are required' } };
      const result = forge.commitFile(repo, {
        path,
        content: Buffer.from(content, 'base64'),
        message,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      const fileName = path.split('/').pop() ?? path;
      return {
        status: result.created ? 201 : 200,
        body: {
          content: {
            name: fileName,
            path,
            sha: result.blobSha,
            size: Buffer.byteLength(Buffer.from(content, 'base64')),
            url: `${repoUrl(origin, repo)}/contents/${path}`,
            html_url: `${origin}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
            git_url: `${repoUrl(origin, repo)}/git/blobs/${result.blobSha}`,
            download_url: `${origin}/${owner}/${name}/raw/${repo.defaultBranch}/${path}`,
            type: 'file',
            encoding: 'base64',
            content,
          },
          commit: { sha: result.commitSha, message },
        },
      };
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? undefined;
      const found = forge.readPathAt(repo, ref, path);
      if (found === null) return notFound();
      if (found.kind === 'file') {
        const fileName = path.split('/').pop() ?? path;
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: found.content.length,
            name: fileName,
            path,
            sha: found.oid,
            content: found.content.toString('base64'),
            url: `${repoUrl(origin, repo)}/contents/${path}`,
            html_url: `${origin}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
            git_url: `${repoUrl(origin, repo)}/git/blobs/${found.oid}`,
            download_url: `${origin}/${owner}/${name}/raw/${repo.defaultBranch}/${path}`,
          },
        };
      }
      return {
        status: 200,
        body: found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : (getObject(forge.objects, entry.oid)?.data.length ?? 0),
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          url: `${repoUrl(origin, repo)}/contents/${entry.path}`,
          html_url: `${origin}/${owner}/${name}/blob/${repo.defaultBranch}/${entry.path}`,
          git_url: `${repoUrl(origin, repo)}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
          download_url: entry.mode === '40000' ? null : `${origin}/${owner}/${name}/raw/${repo.defaultBranch}/${entry.path}`,
        })),
      };
    }
    if (method === 'DELETE') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const result = forge.deleteFile(repo, {
        path,
        message: asString(body.message, 'Delete file'),
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      return { status: 200, body: { commit: { sha: result.commitSha, message: asString(body.message, 'Delete file') } } };
    }
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(repo, label, origin)) };
    }
    if (rest.length === 1 && method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const labelName = asString(body.name);
      if (labelName === '') return { status: 422, body: { message: 'name is required' } };
      const label = forge.createLabel(repo, {
        name: labelName,
        color: asString(body.color, 'ededed'),
        description: asString(body.description),
      });
      return { status: 201, body: labelJson(repo, label, origin) };
    }
    return notFound();
  }

  if (head === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const issues = forge.listIssues(repo, {
        state: query.get('state') ?? undefined,
        sort: query.get('sort') ?? undefined,
        direction: query.get('direction') ?? undefined,
      });
      const { page, headers } = paginate(issues, query, `/api/v3/repos/${owner}/${name}/issues`, origin);
      return { status: 200, body: page.map((issue) => issueJson(issue, repo, origin)), headers };
    }
    if (rest.length === 1 && method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = asString(body.title);
      if (title === '') return { status: 422, body: { message: 'title is required' } };
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels = rawLabels.map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? asString(entry.name) : '')).filter((entry) => entry !== '');
      const issue = forge.createIssue(repo, { title, body: asString(body.body), labels });
      return { status: 201, body: issueJson(issue, repo, origin) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      if (rest.length === 2 && method === 'GET') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound();
        return { status: 200, body: issueJson(issue, repo, origin) };
      }
      if (rest.length === 2 && method === 'PATCH') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const issue = forge.patchIssue(repo, number, {
          state: typeof body.state === 'string' ? body.state : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
        });
        return { status: 200, body: issueJson(issue, repo, origin) };
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound();
        return { status: 200, body: issue.comments.map((comment) => commentJson(repo, number, comment, origin)) };
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const text = asString(body.body);
        if (text === '') return { status: 422, body: { message: 'body is required' } };
        const comment = forge.addComment(repo, number, text);
        return { status: 201, body: commentJson(repo, number, comment, origin) };
      }
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const pulls = forge.listPulls(repo, query.get('state') ?? undefined);
      const { page, headers } = paginate(pulls, query, `/api/v3/repos/${owner}/${name}/pulls`, origin);
      return { status: 200, body: page.map((pull) => pullJson(pull, repo, origin)), headers };
    }
    if (rest.length === 1 && method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = asString(body.title);
      const headRef = asString(body.head);
      const baseRef = asString(body.base);
      if (title === '' || headRef === '' || baseRef === '') {
        return { status: 422, body: { message: 'title, head and base are required' } };
      }
      const pull = forge.createPull(repo, { title, body: asString(body.body), head: headRef, base: baseRef });
      return { status: 201, body: pullJson(pull, repo, origin) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      if (rest.length === 2 && method === 'GET') {
        const pull = forge.getPull(repo, number);
        if (pull === undefined) return notFound();
        return { status: 200, body: pullJson(pull, repo, origin) };
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = forge.getPull(repo, number);
        if (pull === undefined) return notFound();
        const files = forge.pullFiles(repo, pull);
        return {
          status: 200,
          body: files.map((file) => ({
            sha: file.status === 'removed' ? '' : (forge.refTip(repo, pull.headRef) ?? ''),
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            blob_url: `${origin}/${owner}/${name}/blob/${pull.headRef}/${file.filename}`,
            raw_url: `${origin}/${owner}/${name}/raw/${pull.headRef}/${file.filename}`,
            contents_url: `${repoUrl(origin, repo)}/contents/${file.filename}?ref=${pull.headRef}`,
            patch: '',
          })),
        };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const merged = forge.mergePull(repo, number);
        return { status: 200, body: { sha: merged.sha, merged: true, message: `Pull request #${number} merged` } };
      }
    }
    return notFound();
  }

  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (rest.length === 2 && method === 'GET') {
        const out: Array<Record<string, unknown>> = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          const object = getObject(forge.objects, sha);
          out.push({
            ref,
            node_id: '',
            url: `${repoUrl(origin, repo)}/git/refs/${ref.replace(/^refs\//, '')}`,
            object: { sha, type: object?.type ?? 'commit', url: `${repoUrl(origin, repo)}/git/${object?.type ?? 'commit'}s/${sha}` },
          });
        }
        return { status: 200, body: out };
      }
      if (rest.length === 2 && method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === '' || sha === '') return { status: 422, body: { message: 'ref and sha are required' } };
        forge.createRef(repo, ref, sha);
        const object = getObject(forge.objects, sha);
        return {
          status: 201,
          body: {
            ref,
            node_id: '',
            url: `${repoUrl(origin, repo)}/git/refs/${ref.replace(/^refs\//, '')}`,
            object: { sha, type: object?.type ?? 'commit', url: `${repoUrl(origin, repo)}/git/${object?.type ?? 'commit'}s/${sha}` },
          },
        };
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound();
        const object = getObject(forge.objects, sha);
        return {
          status: 200,
          body: {
            ref,
            node_id: '',
            url: `${repoUrl(origin, repo)}/git/refs/${ref.replace(/^refs\//, '')}`,
            object: { sha, type: object?.type ?? 'commit', url: `${repoUrl(origin, repo)}/git/${object?.type ?? 'commit'}s/${sha}` },
          },
        };
      }
    }
    return notFound();
  }

  return notFound();
}
