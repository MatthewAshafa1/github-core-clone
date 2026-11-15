// git smart HTTP: info/refs advertisements, upload-pack (protocol v2 with
// a v0 fallback) and receive-pack v0.
//
// The wire rules that matter here:
// - v2 is chosen by the `Git-Protocol: version=2` request header. The v2
//   advertisement is "version 2" plus capability lines; the v0 one opens
//   with "# service=git-upload-pack" and carries the ref list, with the
//   capabilities after a NUL on the first line (or on a `capabilities^{}`
//   pseudo-ref when the repository has no refs at all).
// - A fetch answers, in order, an acknowledgments section, a shallow-info
//   section when a depth was asked for, and a packfile section whose bytes
//   travel as sideband band-1 packets. The pack itself is plain objects
//   only: no deltas, which the client never needs to resolve.
// - A push answers a report-status stream inside sideband band 1:
//   "unpack ok", then one "ok <ref>" or "ng <ref> <reason>" per command.
//   A non-fast-forward update is refused per ref with the reason
//   "non-fast-forward" and the ref does not move; the other refs in the
//   same command list still apply.

import {
  closureOf,
  getObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { decodePktLines, encodeDelim, encodeFlush, encodePktLine, encodePktLines, PktError } from './pktline.ts';
import { Forge, type RepoRec } from './store.ts';
import { isOid, ZERO_OID } from './util.ts';

export interface GitRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
const AGENT = 'forge/1.0';

function json404(message = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function header(headers: GitRequest['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** All refs of a repository, sorted, with peeled tags resolved. */
function listRefs(forge: Forge, repo: RepoRec): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = getObject(forge.objects, oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(forge.objects, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

function v0Advertisement(
  forge: Forge,
  repo: RepoRec,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(forge, repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (defaultTip !== undefined) {
      lines.push(`${defaultTip} HEAD\0${caps}\n`);
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      if (first) first = false;
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(forge: Forge, owner: string, name: string, service: string | undefined, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  if (service === 'git-upload-pack') {
    const protocol = header(req.headers, 'git-protocol') ?? '';
    if (protocol.includes('version=2')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(forge, repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(forge, repo, 'git-receive-pack') };
  }
  return json404();
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function treeClosure(forge: Forge, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = getObject(forge.objects, oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

function planFetch(
  forge: Forge,
  wants: string[],
  haves: string[],
  shallowSet: Set<string>,
  depth: number | null,
): FetchPlan {
  const held = closureOf(forge.objects, haves, shallowSet);
  // Walk commits from the wants, tracking distance; a commit at distance
  // >= depth is cut, never sent and never expanded.
  const distance = new Map<string, number>();
  const cut = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const sendTags = new Set<string>();
  const sendDirect = new Set<string>();
  const visit = (oid: string, dist: number): void => {
    const known = distance.get(oid);
    if (known !== undefined && known <= dist) return;
    distance.set(oid, dist);
    queue.push({ oid, dist });
  };
  for (const want of wants) {
    const object = getObject(forge.objects, want);
    if (object === undefined) continue;
    if (object.type === 'commit') visit(want, 0);
    else if (object.type === 'tag') {
      sendTags.add(want);
      const target = parseTag(object.data).object;
      const targetObject = getObject(forge.objects, target);
      if (targetObject?.type === 'commit') visit(target, 0);
      else if (targetObject !== undefined) sendDirect.add(target);
    } else {
      sendDirect.add(want);
    }
  }
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; dist: number };
    if ((distance.get(item.oid) ?? 0) < item.dist) continue;
    if (depth !== null && item.dist >= depth) {
      cut.add(item.oid);
      continue;
    }
    const object = getObject(forge.objects, item.oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) visit(parent, item.dist + 1);
  }
  const included = new Set<string>();
  for (const [oid] of distance) if (!cut.has(oid)) included.add(oid);
  const send = new Set<string>();
  for (const oid of included) {
    send.add(oid);
    const object = getObject(forge.objects, oid);
    if (object?.type === 'commit') treeClosure(forge, parseCommit(object.data).tree, send);
  }
  for (const oid of sendTags) send.add(oid);
  for (const oid of sendDirect) send.add(oid);
  for (const oid of held) send.delete(oid);
  // The new shallow boundary: the deepest commits sent, whose parents were cut.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of included) {
      if ((distance.get(oid) ?? 0) !== depth - 1) continue;
      const object = getObject(forge.objects, oid);
      if (object?.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
  }
  // An old boundary is no longer shallow once it (or its parent) is sent.
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    if (included.has(boundary)) {
      unshallow.push(boundary);
      continue;
    }
    const object = getObject(forge.objects, boundary);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (included.has(parent)) {
          unshallow.push(boundary);
          break;
        }
      }
    }
  }
  // Acknowledge the haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    for (const want of wants) {
      if (have === want || isAncestor(forge.objects, have, want)) {
        acks.push(have);
        break;
      }
    }
  }
  return { send, shallow, unshallow, acks };
}

/** Split a pack into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) {
    chunks.push(encodePktLine(Buffer.from([1])));
  }
  return chunks;
}

function packOf(forge: Forge, send: ReadonlySet<string>): Buffer {
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = getObject(forge.objects, oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

function fetchV2(forge: Forge, repo: RepoRec, args: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(forge, wants, haves, new Set(shallow), depth);
  const pack = packOf(forge, plan.send);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(encodeDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodeDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(encodeFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(forge: Forge, repo: RepoRec, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  if (wants.length === 0) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodeFlush() };
  }
  const plan = planFetch(forge, wants, haves, new Set(shallow), depth);
  const pack = packOf(forge, plan.send);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(encodeFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function lsRefsV2(forge: Forge, repo: RepoRec, args: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (defaultTip !== undefined) {
      out.push(`${defaultTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of listRefs(forge, repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodePktLines(out) };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(forge: Forge, owner: string, name: string, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  let packets;
  try {
    packets = decodePktLines(req.body);
  } catch (err) {
    if (err instanceof PktError) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message: 'malformed pkt-line' })}\n`, 'utf8') };
    }
    throw err;
  }
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  if (dataLines.length > 0 && (dataLines[0] as string).startsWith('command=')) {
    const command = (dataLines[0] as string).replace(/\n$/, '');
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    const argsStart = delimAt === -1 ? 1 : delimAt + 1;
    const args = packets
      .slice(argsStart)
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'));
    if (command === 'command=ls-refs') return lsRefsV2(forge, repo, args);
    if (command === 'command=fetch') return fetchV2(forge, repo, args);
    return json404();
  }
  return fetchV0(forge, repo, dataLines);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(forge: Forge, owner: string, name: string, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return json404();
  // Parse pkt-lines from the front of the body only, up to the first flush:
  // everything after that flush is the raw pack, not pkt-lines, and must
  // never be fed to the pkt-line decoder.
  const commands: PushCommand[] = [];
  let capabilities = '';
  let packStart = req.body.length;
  try {
    let offset = 0;
    for (;;) {
      if (offset + 4 > req.body.length) throw new PktError('truncated pkt-line header');
      const head = req.body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new PktError(`bad pkt-line length ${JSON.stringify(head)}`);
      const size = parseInt(head, 16);
      if (size === 0) {
        packStart = offset + 4;
        break;
      }
      if (size === 1) {
        offset += 4;
        continue;
      }
      if (size < 4 || offset + size > req.body.length) throw new PktError('pkt-line overruns the body');
      const text = req.body.subarray(offset + 4, offset + size).toString('utf8');
      const nul = text.indexOf('\0');
      const commandPart = nul === -1 ? text : text.slice(0, nul);
      if (nul !== -1 && capabilities === '') capabilities = text.slice(nul + 1);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(commandPart);
      if (match !== null) {
        commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      }
      offset += size;
    }
  } catch (err) {
    if (err instanceof PktError) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message: 'malformed pkt-line' })}\n`, 'utf8') };
    }
    throw err;
  }
  const report: string[] = [];
  let unpackOk = true;
  const packBytes = req.body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!forge.objects.has(oid)) forge.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      report.push('unpack error\n');
      for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
      return sendReport(capabilities, report);
    }
  }
  report.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!isOid(command.oldOid) || !isOid(command.newOid) || !command.ref.startsWith('refs/')) {
      report.push(`ng ${command.ref} bad command\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        report.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} old ref mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!forge.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      report.push(`ng ${command.ref} ref does not exist\n`);
    } else if (command.oldOid !== current) {
      report.push(`ng ${command.ref} old ref mismatch\n`);
    } else if (!forge.fastForward(command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  }
  return sendReport(capabilities, report);
}

function sendReport(capabilities: string, lines: string[]): GitResponse {
  const inner = encodePktLines([...lines, 'flush']);
  if (capabilities.includes('side-band-64k')) {
    const parts: Buffer[] = [];
    // The report is itself pkt-framed inside band 1; split it across
    // sideband packets the way a pack is split.
    const body = inner;
    const maxData = 65515;
    for (let offset = 0; offset < body.length; offset += maxData) {
      const slice = body.subarray(offset, Math.min(body.length, offset + maxData));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(encodeFlush());
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat([inner, encodeFlush()]) };
}
