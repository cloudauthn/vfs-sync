import { canonicalJSON, decodeText, encodeText, sha256 } from './hash.js';
import type { Hash, VFSEntry, VFSFile, VFSHeader } from './types.js';

/**
 * Codec for `.vfs/vfs.json` — the mirror of the working tree and the only file
 * a sync has to read to decide anything.
 *
 * Two properties are load-bearing and both come from the layout rather than
 * from the parser:
 *
 * - **the header comes first**, so a peer can pull `state`, `log` and `peers`
 *   out of a few hundred bytes with a range read and never touch `entries`;
 * - **one entry per line, in canonical order**, so the file diffs readably and
 *   two converged peers produce byte-identical output.
 */

/** Marks where the header ends and the entry list begins. */
const ENTRIES_KEY = '"entries": [';

/** How much of the file a header read asks for before it gives up and reads it all. */
export const HEADER_PROBE = 8 * 1024;

/**
 * Fields of an entry that take part in {@link stateDigest}.
 *
 * Deliberately not the whole entry. `native` is per-backend, `created` and the
 * `prev*` chain depend on which route a version arrived by, and tombstones are
 * pruned on each peer's own schedule — including any of them would make two
 * genuinely converged peers disagree.
 */
const DIGEST_FIELDS = ['uuid', 'kind', 'path', 'hash', 'size', 'updated'] as const;

/** Canonical field order for an entry, falsy optionals dropped. */
export function canonicalEntry(entry: VFSEntry): VFSEntry {
  const out: Record<string, unknown> = {
    uuid: entry.uuid,
    kind: entry.kind,
    path: entry.path,
    hash: entry.hash ?? null,
    size: entry.size,
    created: entry.created,
    updated: entry.updated,
    peer: entry.peer,
  };
  if (entry.deleted) out.deleted = true;
  if (entry.prev !== undefined) out.prev = entry.prev;
  if (entry.prev2) out.prev2 = entry.prev2;
  if (entry.prevPath) out.prevPath = entry.prevPath;
  if (entry.native) out.native = entry.native;
  // Node-local, and outside the digest — but it has to survive the round trip
  // or the mtime+size fast filter has nothing to compare against and every scan
  // re-reads every file.
  if (entry.mtime !== undefined) out.mtime = entry.mtime;
  if (entry.conflictOf) out.conflictOf = entry.conflictOf;
  if (entry.reason) out.reason = entry.reason;
  if (entry.base) out.base = entry.base;
  if (entry.held) out.held = entry.held;
  return out as unknown as VFSEntry;
}

/** By `path`, then by `uuid` — the order both peers independently produce. */
export function sortEntries(entries: VFSEntry[]): VFSEntry[] {
  return [...entries].sort(
    (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0),
  );
}

/**
 * Digest of the live entries over the converging fields only.
 *
 * One comparison answers "is there anything to sync?", so it has to be equal on
 * two peers whose folders agree even when their `.vfs` folders do not.
 */
export async function stateDigest(entries: VFSEntry[]): Promise<Hash> {
  const live = sortEntries(entries.filter((entry) => !entry.deleted));
  const shape = live.map((entry) => {
    const out: Record<string, unknown> = {};
    for (const field of DIGEST_FIELDS) out[field] = entry[field] ?? null;
    return out;
  });
  return sha256(encodeText(canonicalJSON(shape)));
}

/** Sorts the entries and refreshes `state`, ready to be written. */
export async function normalizeFile(file: VFSFile): Promise<VFSFile> {
  const entries = sortEntries(file.entries).map(canonicalEntry);
  return { ...file, entries, state: await stateDigest(entries) };
}

/**
 * Serialises with the header on top and one entry per line.
 *
 * Hand-rolled rather than `JSON.stringify(value, null, 2)`: the header/entries
 * split is a format guarantee that {@link parseHeader} relies on, and a pretty
 * printer would be free to lay the file out however it liked.
 */
export function encodeVFSFile(file: VFSFile): Uint8Array {
  const header: Array<[string, unknown]> = [
    ['version', 2],
    ['storeId', file.storeId],
    ['peer', file.peer],
    ['state', file.state],
    ['text', file.text],
    ['log', file.log],
    ['peers', file.peers],
    ['local', file.local],
  ];
  const lines = header.map(([key, value]) => `${JSON.stringify(key)}: ${canonicalJSON(value)},`);
  const entries = sortEntries(file.entries).map((entry) => canonicalJSON(canonicalEntry(entry)));
  return encodeText(`{\n${lines.join('\n')}\n${ENTRIES_KEY}\n${entries.join(',\n')}\n]}\n`);
}

export function decodeVFSFile(data: Uint8Array): VFSFile {
  const file = JSON.parse(decodeText(data)) as VFSFile;
  file.entries ??= [];
  file.peers ??= {};
  file.local ??= {};
  file.text ??= [];
  return file;
}

/**
 * Header out of however much of the file is in hand, or `null` when the prefix
 * stopped short of `entries` and the caller has to read more.
 */
export function parseHeader(data: Uint8Array): VFSHeader | null {
  const text = decodeText(data);
  const cut = text.indexOf(ENTRIES_KEY);
  if (cut === -1) return null;
  const header = JSON.parse(`${text.slice(0, cut)}"entries":[]}`) as VFSFile;
  header.peers ??= {};
  header.local ??= {};
  header.text ??= [];
  return headerOf(header);
}

/** Everything but the entry list — what a peer actually reads to decide. */
export function headerOf(file: VFSFile): VFSHeader {
  const { entries, ...rest } = file;
  void entries;
  return rest;
}

/** A fresh, empty store file. */
export function emptyFile(peer: string, storeId: string, segment: number, text: string[]): VFSFile {
  return {
    version: 2,
    storeId,
    peer,
    state: '',
    text,
    log: { segment, digest: ZERO_DIGEST, rows: 0, size: 0 },
    peers: {},
    local: {},
    entries: [],
  };
}

/** The XOR accumulator's identity: what an empty log digests to. */
export const ZERO_DIGEST = '0'.repeat(64);

/** Extensions that get a three-way merge out of the box (§4). */
export const DEFAULT_TEXT_EXTENSIONS = [
  'cue',
  'json',
  'log',
  'm3u',
  'md',
  'nfo',
  'srt',
  'txt',
  'xml',
];

/** Lowercased extension without the dot, or `''` when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
