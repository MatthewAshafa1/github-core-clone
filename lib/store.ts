// The forge's store: repositories, refs, git objects, issues, pull requests
// and labels, all in memory. One Forge instance serves the whole trial; its
// state is built only by the requests the suite sends, in the order they
// arrive, so two runs over the same requests leave the same state.
//
// The token's owner is the viewer of the kit's sealed scenario. The
// scenario is one constant seed, so the viewer is the same in every trial:
// login "adaiversen". Repositories belong to that login; the same name under
// any other owner is simply a repository that does not exist.

import {
  buildCommit,
  buildTree,
  closureOf,
  getObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type ObjectStore,
  type TreeEntry,
} from './gitcore.ts';
import { base64urlDecode, base64urlEncode, EPOCH_BASE_SEC, hashGitObject, isoAt, pathSegments, ZERO_OID } from './util.ts';

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: Viewer = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  nodeId: string;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface RepoRec {
  dbId: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: IssueRec[];
  pulls: PullRec[];
  nextNumber: number;
  seq: number;
}

// ---------------------------------------------------------------------------
// Relay global ids: opaque, stable across reads, never the plain number.
// ---------------------------------------------------------------------------

export function repoNodeId(owner: string, name: string): string {
  return base64urlEncode(`Repository:${owner}/${name}`);
}

export function issueNodeId(owner: string, repo: string, number: number): string {
  return base64urlEncode(`Issue:${owner}/${repo}:${number}`);
}

export function pullNodeId(owner: string, repo: string, number: number): string {
  return base64urlEncode(`PullRequest:${owner}/${repo}:${number}`);
}

export function commentNodeId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return base64urlEncode(`IssueComment:${owner}/${repo}:${issueNumber}:${commentId}`);
}

export interface DecodedNodeId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';
  owner: string;
  repo: string;
  number: number | null;
  commentId: number | null;
}

export function decodeNodeId(id: string): DecodedNodeId | null {
  const text = base64urlDecode(id);
  if (text === null) return null;
  const match = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^:]+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (match === null) return null;
  return {
    kind: match[1] as DecodedNodeId['kind'],
    owner: match[2] ?? '',
    repo: match[3] ?? '',
    number: match[4] === undefined ? null : Number(match[4]),
    commentId: match[5] === undefined ? null : Number(match[5]),
  };
}

// ---------------------------------------------------------------------------
// flat tree maps: path -> blob, for contents, merges and diffs
// ---------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

export function flatTreeAt(store: ObjectStore, treeOid: string): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = getObject(store, oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

interface FlatNode {
  files: Map<string, FlatEntry>;
  dirs: Map<string, FlatNode>;
}

export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  const root: FlatNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = pathSegments(path);
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: FlatNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashGitObject('tree', data);
    if (!store.has(oid)) store.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

function flatEqual(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid;
}

function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of oldText === null ? [] : linesOf(oldText)) {
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  }
  let additions = 0;
  for (const line of newText === null ? [] : linesOf(newText)) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------

export class Forge {
  readonly objects: ObjectStore = new Map<string, GitObject>();
  private readonly repos = new Map<string, RepoRec>();
  private seqCounter = 0;
  private dbIdCounter = 0;
  private globalIdCounter = 0;

  /** A creation stamp: a sequence number and a deterministic epoch second. */
  tick(): { seq: number; epoch: number } {
    this.seqCounter += 1;
    return { seq: this.seqCounter, epoch: EPOCH_BASE_SEC + this.seqCounter };
  }

  private stamp(): string {
    return isoAt(EPOCH_BASE_SEC + this.seqCounter);
  }

  private ident(epoch: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  }

  // -- repositories ----------------------------------------------------------

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(input: { name: string; isPrivate: boolean; description: string; defaultBranch?: string }): RepoRec {
    const name = input.name;
    if (this.repos.has(this.key(VIEWER.login, name))) {
      throw new ForgeError(422, `Repository ${VIEWER.login}/${name} already exists`);
    }
    this.dbIdCounter += 1;
    const stamp = this.tick();
    const repo: RepoRec = {
      dbId: this.dbIdCounter,
      nodeId: repoNodeId(VIEWER.login, name),
      owner: VIEWER.login,
      name,
      description: input.description,
      isPrivate: input.isPrivate,
      defaultBranch: input.defaultBranch ?? 'main',
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      seq: stamp.seq,
    };
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  // -- refs ------------------------------------------------------------------

  refTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  resolveRef(repo: RepoRec, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    if (this.objects.has(ref)) return ref;
    return undefined;
  }

  listBranches(repo: RepoRec): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  createRef(repo: RepoRec, ref: string, sha: string): void {
    if (repo.refs.has(ref)) throw new ForgeError(422, `Reference ${ref} already exists`);
    if (!this.objects.has(sha)) throw new ForgeError(422, `Object ${sha} does not exist`);
    repo.refs.set(ref, sha);
  }

  // -- contents --------------------------------------------------------------

  private putObject(object: GitObject): string {
    const oid = hashGitObject(object.type, object.data);
    if (!this.objects.has(oid)) this.objects.set(oid, object);
    return oid;
  }

  private commitTree(
    repo: RepoRec,
    branch: string,
    flat: ReadonlyMap<string, FlatEntry>,
    message: string,
    parents: string[],
  ): string {
    const treeOid = treeFromFlat(this.objects, flat);
    const stamp = this.tick();
    const ident = this.ident(stamp.epoch);
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    const oid = this.putObject({ type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  commitFile(
    repo: RepoRec,
    input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; blobSha: string; created: boolean } {
    const branch = input.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let flat = new Map<string, FlatEntry>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const tipObject = getObject(this.objects, tip);
      if (tipObject?.type === 'commit') {
        flat = flatTreeAt(this.objects, parseCommit(tipObject.data).tree);
        parents.push(tip);
      }
    } else if (branch !== repo.defaultBranch) {
      throw new ForgeError(422, `Branch ${branch} does not exist`);
    }
    const existing = flat.get(input.path);
    if (existing !== undefined) {
      if (input.sha === undefined) throw new ForgeError(422, 'sha was not supplied');
      if (input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        throw new ForgeError(409, 'sha does not match the current file');
      }
    }
    const blobSha = this.putObject({ type: 'blob', data: input.content });
    flat.set(input.path, { oid: blobSha, mode: '100644' });
    const commitSha = this.commitTree(repo, branch, flat, input.message, parents);
    return { commitSha, blobSha, created: existing === undefined };
  }

  deleteFile(
    repo: RepoRec,
    input: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } {
    const branch = input.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) throw new ForgeError(404, 'Not Found');
    const tipObject = getObject(this.objects, tip);
    if (tipObject?.type !== 'commit') throw new ForgeError(404, 'Not Found');
    const flat = flatTreeAt(this.objects, parseCommit(tipObject.data).tree);
    const existing = flat.get(input.path);
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (input.sha !== undefined && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      throw new ForgeError(409, 'sha does not match the current file');
    }
    flat.delete(input.path);
    const commitSha = this.commitTree(repo, branch, flat, input.message, [tip]);
    return { commitSha };
  }

  readPathAt(
    repo: RepoRec,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; oid: string; content: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const tip = this.resolveRef(repo, ref ?? repo.defaultBranch);
    if (tip === undefined) return null;
    const tipObject = getObject(this.objects, tip);
    if (tipObject?.type !== 'commit') return null;
    const flat = flatTreeAt(this.objects, parseCommit(tipObject.data).tree);
    const cleaned = path.replace(/^\/+|\/+$/g, '');
    if (cleaned === '') {
      return { kind: 'dir', entries: this.dirEntries(flat, '') };
    }
    const file = flat.get(cleaned);
    if (file !== undefined) {
      const blob = getObject(this.objects, file.oid);
      if (blob === undefined) return null;
      return { kind: 'file', oid: file.oid, content: blob.data };
    }
    const entries = this.dirEntries(flat, cleaned);
    if (entries.length === 0) return null;
    return { kind: 'dir', entries };
  }

  private dirEntries(
    flat: ReadonlyMap<string, FlatEntry>,
    dir: string,
  ): Array<{ name: string; path: string; oid: string; mode: string }> {
    const prefix = dir === '' ? '' : `${dir}/`;
    const files = new Map<string, { oid: string; mode: string }>();
    const dirs = new Map<string, string>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.set(rest, entry);
      } else {
        const name = rest.slice(0, slash);
        if (!dirs.has(name)) {
          // The directory's tree id: rebuild it from the flat map below.
          dirs.set(name, '');
        }
      }
    }
    const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
    for (const [name, entry] of files) {
      entries.push({ name, path: `${prefix}${name}`, oid: entry.oid, mode: entry.mode });
    }
    for (const name of dirs.keys()) {
      const sub = new Map<string, FlatEntry>();
      for (const [path, entry] of flat) {
        if (path.startsWith(`${prefix}${name}/`)) sub.set(path.slice(prefix.length + name.length + 1), entry);
      }
      entries.push({ name, path: `${prefix}${name}`, oid: treeFromFlat(this.objects, sub), mode: '40000' });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  listCommits(repo: RepoRec, ref: string | undefined): Array<{ sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }> {
    const tip = this.resolveRef(repo, ref ?? repo.defaultBranch);
    if (tip === undefined) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = getObject(this.objects, oid);
      if (object?.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      out.push({ sha: oid, message: parsed.message, author: parsed.author, committer: parsed.committer, parents: parsed.parents, tree: parsed.tree });
      for (const parent of parsed.parents) queue.push(parent);
    }
    return out;
  }

  // -- labels ------------------------------------------------------------------

  createLabel(repo: RepoRec, input: { name: string; color: string; description: string }): Label {
    if (repo.labels.has(input.name)) throw new ForgeError(422, `Label ${input.name} already exists`);
    const label: Label = { name: input.name, color: input.color, description: input.description };
    repo.labels.set(input.name, label);
    return label;
  }

  // -- issues ------------------------------------------------------------------

  createIssue(repo: RepoRec, input: { title: string; body: string; labels: readonly string[] }): IssueRec {
    const labels: Label[] = [];
    for (const name of input.labels) {
      const label = repo.labels.get(name);
      if (label === undefined) throw new ForgeError(422, `Label ${name} does not exist`);
      labels.push(label);
    }
    this.globalIdCounter += 1;
    const stamp = this.tick();
    const number = repo.nextNumber++;
    const issue: IssueRec = {
      id: this.globalIdCounter,
      number,
      nodeId: issueNodeId(repo.owner, repo.name, number),
      title: input.title,
      body: input.body,
      state: 'open',
      labels,
      seq: stamp.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: RepoRec, number: number): IssueRec | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(
    repo: RepoRec,
    query: { state?: string; sort?: string; direction?: string },
  ): IssueRec[] {
    const state = query.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = query.direction ?? 'desc';
    list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return list;
  }

  patchIssue(repo: RepoRec, number: number, patch: { state?: string; title?: string; body?: string }): IssueRec {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) throw new ForgeError(404, 'Not Found');
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    return issue;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) throw new ForgeError(404, 'Not Found');
    this.globalIdCounter += 1;
    const stamp = this.tick();
    const comment: CommentRec = {
      id: this.globalIdCounter,
      nodeId: commentNodeId(repo.owner, repo.name, issueNumber, this.globalIdCounter),
      body,
      seq: stamp.seq,
    };
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests -----------------------------------------------------------

  createPull(repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec {
    const headSha = this.refTip(repo, input.head);
    const baseSha = this.refTip(repo, input.base);
    if (headSha === undefined) throw new ForgeError(422, `Head branch ${input.head} does not exist`);
    if (baseSha === undefined) throw new ForgeError(422, `Base branch ${input.base} does not exist`);
    const duplicate = repo.pulls.find(
      (pull) => pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base,
    );
    if (duplicate !== undefined) {
      throw new ForgeError(422, 'A pull request already exists for this head and base');
    }
    this.globalIdCounter += 1;
    const stamp = this.tick();
    const number = repo.nextNumber++;
    const pull: PullRec = {
      id: this.globalIdCounter,
      number,
      nodeId: pullNodeId(repo.owner, repo.name, number),
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      seq: stamp.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: RepoRec, number: number): PullRec | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: RepoRec, state: string | undefined): PullRec[] {
    const wanted = state ?? 'open';
    const list = repo.pulls.filter((pull) => wanted === 'all' || pull.state === wanted);
    return [...list].sort((a, b) => b.seq - a.seq);
  }

  pullBase(repo: RepoRec, pull: PullRec): string | null {
    const head = this.refTip(repo, pull.headRef) ?? pull.headSha;
    const base = this.refTip(repo, pull.baseRef) ?? pull.baseSha;
    return mergeBase(this.objects, head, base);
  }

  private flatAtCommit(oid: string | null): Map<string, FlatEntry> {
    if (oid === null || oid === ZERO_OID) return new Map();
    const object = getObject(this.objects, oid);
    if (object?.type !== 'commit') return new Map();
    return flatTreeAt(this.objects, parseCommit(object.data).tree);
  }

  /** The three-way merge of a pull request: the merged tree, or the conflicts. */
  mergePlan(repo: RepoRec, pull: PullRec): { flat: Map<string, FlatEntry>; conflicts: string[] } {
    const headSha = this.refTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = this.refTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = this.pullBase(repo, pull);
    const baseFlat = this.flatAtCommit(base);
    const headFlat = this.flatAtCommit(headSha);
    const tipFlat = this.flatAtCommit(baseSha);
    const merged = new Map<string, FlatEntry>();
    const conflicts: string[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const bv = baseFlat.get(path);
      const hv = headFlat.get(path);
      const tv = tipFlat.get(path);
      if (flatEqual(hv, bv)) {
        if (tv !== undefined) merged.set(path, tv);
      } else if (flatEqual(tv, bv)) {
        if (hv !== undefined) merged.set(path, hv);
      } else if (flatEqual(hv, tv)) {
        if (hv !== undefined) merged.set(path, hv);
      } else {
        conflicts.push(path);
      }
    }
    return { flat: merged, conflicts };
  }

  mergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergePlan(repo, pull).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  mergePull(repo: RepoRec, number: number): { sha: string } {
    const pull = this.getPull(repo, number);
    if (pull === undefined) throw new ForgeError(404, 'Not Found');
    if (pull.state !== 'open') throw new ForgeError(405, 'Pull request is already closed');
    const plan = this.mergePlan(repo, pull);
    if (plan.conflicts.length > 0) {
      throw new ForgeError(405, `Merge conflict in ${plan.conflicts.join(', ')}`);
    }
    const baseSha = this.refTip(repo, pull.baseRef) ?? pull.baseSha;
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.commitTree(repo, pull.baseRef, plan.flat, message, [baseSha]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.stamp();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headSha = this.refTip(repo, pull.headRef) ?? pull.headSha;
    const base = this.pullBase(repo, pull);
    const baseFlat = this.flatAtCommit(base);
    const headFlat = this.flatAtCommit(headSha);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const bv = baseFlat.get(path);
      const hv = headFlat.get(path);
      if (bv !== undefined && hv !== undefined && bv.oid === hv.oid) continue;
      const oldText = bv === undefined ? null : getObject(this.objects, bv.oid)?.data.toString('utf8') ?? null;
      const newText = hv === undefined ? null : getObject(this.objects, hv.oid)?.data.toString('utf8') ?? null;
      const counts = lineCounts(oldText, newText);
      const status = bv === undefined ? 'added' : hv === undefined ? 'removed' : 'modified';
      files.push({
        filename: path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return files;
  }

  /** Fast-forward test for a receive-pack update, peeling tags to commits. */
  fastForward(oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    const oldCommit = peelToCommit(this.objects, oldOid);
    const newCommit = peelToCommit(this.objects, newOid);
    if (oldCommit === null || newCommit === null) return true;
    return isAncestor(this.objects, oldCommit, newCommit);
  }

  /** Objects reachable from a ref, for fetch planning. */
  reachable(tips: Iterable<string>, stopParents?: ReadonlySet<string>): Set<string> {
    return closureOf(this.objects, tips, stopParents);
  }
}
