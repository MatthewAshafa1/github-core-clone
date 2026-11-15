// pkt-line framing, the wire format of the smart-HTTP git protocols.
//
// A pkt-line is a 4-hex-digit length (the length itself included) followed by
// that many bytes of payload. The two control lines are flush ("0000") and
// delim ("0001"). Payloads here are small (a pack's sideband chunks are cut
// to fit), so whole bodies are decoded at once.

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  /** The payload for a data packet; empty for flush/delim. */
  payload: Buffer;
}

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = body.length + 4;
  if (size > 0xffff) throw new Error(`pkt-line of ${size} bytes exceeds the 65535 limit`);
  const head = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of lines (strings), flush and delim markers into one body. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(encodeFlush());
    else if (line === 'delim') parts.push(encodeDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export class PktError extends Error {}

/** Decode a whole buffer of pkt-lines. Throws PktError on malformed input. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new PktError(`truncated pkt-line header at ${offset}`);
    }
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new PktError(`bad pkt-line length ${JSON.stringify(head)} at ${offset}`);
    }
    const size = parseInt(head, 16);
    if (size === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) {
      throw new PktError(`pkt-line of ${size} bytes overruns the body at ${offset}`);
    }
    out.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + size)) });
    offset += size;
  }
  return out;
}
