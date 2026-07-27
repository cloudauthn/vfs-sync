import { canonicalJSON, decodeText, encodeText, sha256 } from './hash.js';
import { ZERO_DIGEST } from './vfs-file.js';
import type { Hash, LogRow } from './types.js';

/**
 * Codec and set algebra for `.vfs/commits` — one JSON object per line, no
 * enclosing brackets and no commas, so the file grows by *appending* and every
 * line parses on its own.
 *
 * Rows are immutable and identified, which is what makes merging two logs plain
 * set union: dedupe by `op` and the result is the same whichever order the rows
 * arrived in, and re-recording an operation is a no-op.
 */

/**
 * Identity of an operation. Computed by whoever originates it, from the facts
 * of the operation alone — never from the file it lands in or the order it
 * lands in. Two replicas that record the same operation produce the same `op`,
 * which is the whole basis of the dedup.
 */
export async function opId(row: Omit<LogRow, 'op' | 'batch'>): Promise<Hash> {
  return sha256(encodeText([row.peer, row.uuid, row.at, row.type, row.path, row.hash ?? ''].join('|')));
}

/** Fills in the `op` of a row whose facts are already decided. */
export async function makeRow(row: Omit<LogRow, 'op'>): Promise<LogRow> {
  return { op: await opId(row), ...row };
}

/** Canonical key order, falsy optionals dropped, so a row encodes byte-stably. */
export function canonicalRow(row: LogRow): LogRow {
  const out: Record<string, unknown> = {
    op: row.op,
    batch: row.batch,
    at: row.at,
    peer: row.peer,
    uuid: row.uuid,
    type: row.type,
    kind: row.kind,
    path: row.path,
  };
  if (row.hash !== undefined) out.hash = row.hash;
  if (row.size !== undefined) out.size = row.size;
  if (row.prev !== undefined) out.prev = row.prev;
  if (row.prev2) out.prev2 = row.prev2;
  if (row.prevPath) out.prevPath = row.prevPath;
  return out as unknown as LogRow;
}

export function encodeRows(rows: LogRow[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array();
  return encodeText(`${rows.map((row) => canonicalJSON(canonicalRow(row))).join('\n')}\n`);
}

/**
 * Parses whatever whole lines are in `data`.
 *
 * A trailing partial line is dropped rather than thrown on: the tail of the log
 * is read from a remembered offset, and a reader can legitimately arrive while
 * an append is half-landed.
 */
export function parseRows(data: Uint8Array): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of decodeText(data).split('\n')) {
    const text = line.trim();
    if (!text || !text.startsWith('{') || !text.endsWith('}')) continue;
    try {
      rows.push(JSON.parse(text) as LogRow);
    } catch {
      // a torn line: the next read from a clean offset will bring it whole
    }
  }
  return rows;
}

// -------------------------------------------------------------- set digest

/**
 * XOR of the `op` ids in a set. Order-independent and replica-independent, so
 * "do we hold the same operations?" is one comparison instead of a diff.
 *
 * The known weakness is that inserting an `op` twice cancels it out — which is
 * only safe because dedup by `op` is an invariant the merge needs anyway. If it
 * ever stops holding, a sum mod 2^256 is the drop-in replacement.
 */
export function xorDigest(rows: Iterable<LogRow>): Hash {
  let acc = ZERO_DIGEST;
  for (const row of rows) acc = xorHex(acc, row.op);
  return acc;
}

export function xorHex(left: Hash | undefined, right: Hash | undefined): Hash {
  let out = '';
  for (let i = 0; i < 64; i++) {
    // A row whose `op` is short or missing is a corrupt line, not a reason to
    // fail a sync: it folds in as zeroes and the digest simply disagrees.
    const a = Number.parseInt(left?.[i] ?? '0', 16) || 0;
    const b = Number.parseInt(right?.[i] ?? '0', 16) || 0;
    out += ((a ^ b) & 0xf).toString(16);
  }
  return out;
}

// ------------------------------------------------------------------- union

/**
 * Rows of `incoming` that `existing` does not already hold.
 *
 * Appending only the difference is what keeps a merge from re-uploading the
 * whole segment, which on Drive is what an append costs.
 */
export function missingRows(existing: Iterable<LogRow>, incoming: Iterable<LogRow>): LogRow[] {
  const held = new Set<Hash>();
  for (const row of existing) held.add(row.op);
  const out: LogRow[] = [];
  for (const row of incoming) {
    if (held.has(row.op)) continue;
    held.add(row.op);
    out.push(row);
  }
  return out;
}

/** Set union of two logs, deduplicated by `op`. Idempotent by construction. */
export function unionRows(...logs: Iterable<LogRow>[]): LogRow[] {
  const byOp = new Map<Hash, LogRow>();
  for (const log of logs) for (const row of log) if (!byOp.has(row.op)) byOp.set(row.op, row);
  return [...byOp.values()];
}

/**
 * Chronological order, with `op` as tiebreak.
 *
 * The file itself is in arrival order — that is what keeps offsets stable and
 * lets the tail be range-read — so whoever reads it puts the rows back in time
 * order in memory.
 */
export function sortRows(rows: LogRow[]): LogRow[] {
  return [...rows].sort((x, y) => x.at - y.at || (x.op < y.op ? -1 : x.op > y.op ? 1 : 0));
}
