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
    peerId: entry.peerId,
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
    // From the file, not a literal: a migrated file written back out claiming
    // its old version would be migrated again on every read.
    ['version', file.version],
    // `canonicalJSON(undefined)` is `'null'` at top level, so an unaffiliated
    // folder writes an explicit `null` for free — and that `null` is what tells
    // "never synced" apart from "written by an engine that had no syncId".
    ['syncId', file.syncId],
    // Only once there is something in it: an empty list is the ordinary case
    // and a key that says nothing is a key every reader has to skip.
    ...(file.absorbed && file.absorbed.length > 0
      ? ([['absorbed', file.absorbed]] as Array<[string, unknown]>)
      : []),
    ['peerId', file.peerId],
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

/** The version this engine writes. Reading goes back as far as {@link FORMAT_CHANGES}. */
export const CURRENT_VERSION = 3;

/** A file as it came off disk, before any migration has interpreted it. */
type RawFile = Record<string, unknown>;

/**
 * One step in the format's history, and whether it can be reconciled.
 *
 * Three kinds, not two, and the distinction decides whether a change is safe to
 * release in one go:
 *
 * | kind | new engine reads old | **old engine reads new** |
 * | --- | --- | --- |
 * | `additive` | yes, nothing to do | **yes** — new fields it ignores |
 * | `migratable` | yes, via `migrate` | **no** |
 * | `breaking` | no | no |
 *
 * The second column is the one that matters, because on shared storage the old
 * engine *is* going to read what the new one writes. A `migratable` step is not
 * safe to roll out all at once even when its `migrate` is perfect: migration
 * solves reading forward, not the engine behind surviving.
 */
export type FormatChange =
  | { version: number; kind: 'additive'; note: string }
  | { version: number; kind: 'migratable'; note: string; migrate: (file: RawFile) => RawFile }
  | { version: number; kind: 'breaking'; note: string };

export const FORMAT_CHANGES: FormatChange[] = [
  {
    version: 3,
    kind: 'migratable',
    note: 'peer -> peerId in the header and entries; storeId retired into syncId',
    migrate: (file) => {
      const peers = (file.peers ?? {}) as Record<string, unknown>;
      const entries = (file.entries ?? []) as RawFile[];
      const { peer, storeId, ...rest } = file;
      return {
        ...rest,
        version: 3,
        peerId: peer,
        // Seeded, never minted. In v2 `storeId` converged on the smaller and was
        // transitive, so a mesh already shared one value and every peer derives
        // the same `syncId` without coordinating. Minting a fresh one per folder
        // would split a legitimate mesh into `foreign-mesh` on first contact.
        //
        // An empty `peers` means nobody has ever been met, so there is no
        // affiliation to preserve. That heuristic lives here, runs once per
        // folder, and disappears with the file it migrated.
        syncId: Object.keys(peers).length > 0 ? (storeId ?? null) : null,
        entries: entries.map((entry) => {
          const { peer: wrote, ...fields } = entry;
          return { ...fields, peerId: wrote };
        }),
      };
    },
  },
];

/**
 * Brings a file up to {@link CURRENT_VERSION}, one declared step at a time.
 *
 * `vfs.json` is small, singular and rewritten on every commit, so it migrates
 * **eagerly**, here, on read. The log cannot: closed segments are immutable and
 * cached forever, so they migrate in the reader instead. The rule that falls out
 * and is worth stating: *what is mutable migrates eagerly, what is immutable
 * migrates in the reader.*
 */
export function migrateFile(file: RawFile): RawFile {
  let out = file;
  const from = typeof out.version === 'number' ? out.version : 0;
  for (const change of FORMAT_CHANGES) {
    if (change.version <= from) continue;
    if (change.kind !== 'migratable') break;
    out = change.migrate(out);
  }
  return out;
}

/**
 * Whether this engine can interpret `version`, and if not, why.
 *
 * Only the newer engine can answer: an older one cannot diagnose a version it
 * does not know exists. That asymmetry is why the check belongs to whoever has
 * the table.
 */
export function readable(version: number): boolean {
  if (version > CURRENT_VERSION) return false;
  return FORMAT_CHANGES.every((change) => change.version <= version || change.kind === 'migratable');
}

export function decodeVFSFile(data: Uint8Array): VFSFile {
  const file = migrateFile(JSON.parse(decodeText(data)) as RawFile) as unknown as VFSFile;
  file.entries ??= [];
  file.peers ??= {};
  file.local ??= {};
  file.text ??= [];
  file.absorbed ??= [];
  file.syncId ??= null;
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
  header.absorbed ??= [];
  return headerOf(header);
}

/** Everything but the entry list — what a peer actually reads to decide. */
export function headerOf(file: VFSFile): VFSHeader {
  const { entries, ...rest } = file;
  void entries;
  return rest;
}

/** A fresh, empty store file. */
export function emptyFile(peerId: string, segment: number, text: string[]): VFSFile {
  return {
    version: CURRENT_VERSION,
    // Affiliation records a sync that happened. A folder nobody has met yet
    // has none, and says so.
    syncId: null,
    absorbed: [],
    peerId,
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
