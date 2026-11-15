// Git objects and packfiles, built on node:zlib and node:crypto only.
//
// Objects are content-addressed: an object's id is the SHA-1 of
// "<type> <size>\0<bytes>". A packfile is the "PACK" header, one entry per
// object (a type/size varint plus a zlib stream, plain or delta-compressed),
// and a 20-byte trailer that is the SHA-1 of everything before it.

import { deflateSync, inflateSync } from 'node:zlib';
import { hashGitObject, sha1Hex, ZERO_OID } from './util.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const TYPE_CODES: Readonly<Record<ObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

export function typeOfCode(code: number): ObjectType | null {
  if (code === 1) return 'commit';
  if (code === 2) return 'tree';
  if (code === 3) return 'blob';
  if (code === 4) return 'tag';
  return null;
}

/** The id of an object already in memory. */
export function objectId(object: GitObject): string {
  return hashGitObject(object.type, object.data);
}

// ---------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: ParsedCommit): Buffer {
  let head = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) head += `parent ${parent}\n`;
  head += `author ${commit.author}\n`;
  head += `committer ${commit.committer}\n`;
  return Buffer.from(`${head}\n${commit.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git orders tree entries by name, with a directory sorting as if its name
  // ended in "/".
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries, in git's canonical order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(tag: ParsedTag): Buffer {
  const head = `object ${tag.object}\ntype ${tag.type}\ntag ${tag.tag}\ntagger ${tag.tagger}\n`;
  return Buffer.from(`${head}\n${tag.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function encodePackHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a packfile of plain (non-delta) objects, sorted by id for stability. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const x = objectId(a);
    const y = objectId(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const object of sorted) {
    parts.push(encodePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = sha1Hex(body);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

/** The length of the zlib stream starting at `start`: the shortest prefix
 *  that inflates. A truncated stream throws, a longer slice is accepted, so
 *  the predicate is monotone and a binary search finds the exact end. */
function zlibStreamLength(buffer: Buffer, start: number): number {
  let low = 1;
  let high = buffer.length - start;
  if (high <= 0) throw new Error('pack entry has no zlib data');
  const ok = (length: number): boolean => {
    try {
      inflateSync(buffer.subarray(start, start + length));
      return true;
    } catch {
      return false;
    }
  };
  if (!ok(high)) throw new Error('pack entry zlib stream is truncated');
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

interface PackEntry {
  offset: number;
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset |= delta[offset++] << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) copySize |= delta[offset++] << (bit * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert runs past the end');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (produced !== targetSize) {
    throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  }
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  version: number;
}

/**
 * Read a packfile, resolving any delta entries. `resolveBase` supplies an
 * object the pack itself does not hold (a thin pack's base); it is only
 * consulted for REF_DELTA entries whose base is absent from the pack.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const first = pack[offset++];
    const code = (first >> 4) & 0x07;
    // Size varint: the first byte's low nibble holds bits 0..3, later bytes
    // hold 7 bits each, MSB set meaning "another byte follows".
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    let cursor = offset;
    while (byte & 0x80) {
      byte = pack[cursor++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    offset = cursor;
    let type: PackEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      type = 'ofs-delta';
      byte = pack[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (code === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      const found = typeOfCode(code);
      if (found === null) throw new Error(`pack entry has unknown type code ${code}`);
      type = found;
    }
    const length = zlibStreamLength(pack, offset);
    const data = inflateSync(pack.subarray(offset, offset + length));
    if (data.length !== size) {
      throw new Error(`pack entry inflated to ${data.length} bytes, header says ${size}`);
    }
    offset += length;
    entries.push({ offset: entryOffset, type, data, baseOffset, baseOid });
  }
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (entry: PackEntry): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('pack delta cycle');
    resolving.add(entry.offset);
    let result: GitObject;
    if (entry.type === 'ofs-delta') {
      deltaCount += 1;
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveEntry(baseEntry);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      deltaCount += 1;
      const baseOid = entry.baseOid ?? '';
      let base = objects.get(baseOid);
      if (base === undefined) {
        const baseEntry = entries.find((candidate) => objectId(resolveEntry(candidate)) === baseOid);
        base = baseEntry === undefined ? options.resolveBase?.(baseOid) : resolveEntry(baseEntry);
      }
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is not available`);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: entry.type, data: entry.data };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, result);
    objects.set(objectId(result), result);
    return result;
  };
  for (const entry of entries) resolveEntry(entry);
  return { objects, deltaCount, declaredCount, version };
}

// ---------------------------------------------------------------------------
// reachability over a store
// ---------------------------------------------------------------------------

export type ObjectStore = Map<string, GitObject>;

export function getObject(store: ObjectStore, oid: string): GitObject | undefined {
  return store.get(oid);
}

/**
 * Every object reachable from `tips`: commits and their parents, trees and
 * their entries, tag targets, blobs. Parent traversal stops at commits in
 * `stopParents` (a shallow boundary: the commit itself and its tree are
 * included, its ancestors are not).
 */
export function closureOf(store: ObjectStore, tips: Iterable<string>, stopParents?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      if (stopParents?.has(oid) !== true) {
        for (const parent of parsed.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target === ancestor) return true;
      stack.push(target);
    }
  }
  return false;
}

/** Peel a tag (or a chain of tags) to the commit it names, if it is one. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** A commit's ancestors in breadth-first order (nearest first). */
export function ancestorsOf(store: ObjectStore, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    out.push(oid);
    const object = store.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return out;
}

/** The nearest common ancestor of two tips (a merge-base), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const aAncestors = new Set(ancestorsOf(store, a));
  for (const oid of ancestorsOf(store, b)) {
    if (aAncestors.has(oid)) return oid;
  }
  return null;
}
