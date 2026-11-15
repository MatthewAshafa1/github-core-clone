// Small shared helpers: hashing, base64url ids, and the deterministic clock
// the forge stamps its records with (a sequence, not the wall clock, so two
// runs over the same requests leave identical state).

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_PATTERN.test(value);
}

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <bytes>\0<bytes>"). */
export function hashGitObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function base64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function base64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** A fixed base instant; records stamp base + sequence seconds, never now. */
export const EPOCH_BASE_SEC = 1_700_000_000;

export function isoAt(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Split a path like "a/b/c.txt" into its segments, dropping empties. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}
