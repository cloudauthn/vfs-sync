/** Hex-encoded SHA-256 digest. */
export type Hash = string;

export type EntryKind = 'file' | 'directory';

export interface VFSStat {
  kind: EntryKind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

export interface VFSListEntry {
  name: string;
  /** Path relative to the adapter root, POSIX separators, no leading slash. */
  path: string;
  kind: EntryKind;
  /**
   * The entry's stat, when the listing already carried it. Optional and purely
   * an optimisation: a backend whose directory listing comes back with sizes and
   * times attaches them here, and a consumer that would otherwise `stat()` every
   * entry can skip the call. Drive is the reason it exists — its file list
   * returns `size` and `modifiedTime` for every child in the one request, so a
   * walk that re-stats each file pays a whole round trip per file for data it
   * already has. When present it must equal what {@link VFSAdapter.stat} would
   * return; when absent, nothing may be assumed.
   */
  stat?: VFSStat;
}

/**
 * Half-open byte range `[start, end)`, like `Blob.slice()` and unlike node's
 * inclusive `createReadStream({ end })` — the adapters do that conversion.
 */
export interface ByteRange {
  /** Defaults to 0. */
  start?: number;
  /** Exclusive. Defaults to the end of the file. */
  end?: number;
}

/** One change reported by a backend that can enumerate them ({@link VFSAdapter.changes}). */
export interface VFSChange {
  /** Backend-native id of the file that changed. */
  native: string;
  /** Path, when the backend can still resolve one. Absent for removals. */
  path?: string;
  removed?: boolean;
  stat?: VFSStat;
}

export interface VFSChangeFeed {
  changes: VFSChange[];
  /** Token to pass next time. */
  token: string;
  /**
   * True when the backend could not honour the token (Drive's `410 Gone`) and
   * the caller has to fall back to a full walk. `token` is then a fresh one.
   */
  reset?: boolean;
}

/**
 * The single interface every backend implements. Paths are relative to the
 * adapter root, use `/` as separator and never start with `/`.
 */
export interface VFSAdapter {
  /** Human-readable label, used in logs and conflict-copy names. */
  readonly name: string;
  /** Shallow listing of a directory. `''` is the root. Missing dir -> `[]`. */
  list(path: string): Promise<VFSListEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  /** First-class operation: it is how rename intent gets captured. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** `null` when the path does not exist. */
  stat(path: string): Promise<VFSStat | null>;
  /**
   * Creates an empty directory (and its ancestors). Optional, but v2 records
   * directories as entries of their own, so a backend without it cannot
   * reproduce an empty folder — the engine degrades to creating the folder when
   * its first file lands.
   */
  mkdir?(path: string): Promise<void>;
  /**
   * Backends with stable native identifiers (Google Drive `fileId`) implement
   * this so renames need no heuristic, and so a change feed keyed by id can be
   * mapped back onto an entry. OPFS/FSA/node leave it undefined and the engine
   * relies on its own uuids instead.
   */
  fileId?(path: string): Promise<string | null>;

  // ------------------------------------------------------------- streaming
  //
  // All three are optional. The helpers in `stream.ts` emulate whatever a
  // backend leaves out on top of read()/write(), so an adapter that implements
  // none of them still works — it just holds whole files in memory. Implement
  // them when the backend can do better, which OPFS, FSA and node all can.

  /**
   * Reads `[start, end)` without touching the rest of the file. This is what
   * makes "read the header of `vfs.json`" cost a few hundred bytes, and what
   * lets the tail of the commit log be read from a known offset.
   */
  readRange?(path: string, range?: ByteRange): Promise<Uint8Array>;
  /** Streams a file, optionally only a range of it. */
  readStream?(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  /** Replaces a file's contents from a stream. Truncates on open. */
  writeStream?(path: string): Promise<WritableStream<Uint8Array>>;

  // --------------------------------------------------------------- v2 extras
  //
  // Same philosophy as the streaming trio: implement where the backend does it
  // better, otherwise `store.ts` emulates it.

  /**
   * Appends to a file, creating it when absent. Native on node (`'a'`) and on
   * OPFS/FSA (`createWritable({ keepExistingData: true })` + seek); on Drive
   * there is no append, so the emulation reads, concatenates and writes.
   */
  append?(path: string, data: Uint8Array): Promise<void>;
  /**
   * Conditional write: only lands if the file still carries `tag` (the `etag`
   * from a previous {@link VFSAdapter.tag} or write). Returns the new tag, or
   * `null` when the precondition failed and nothing was written. Turns the
   * check-then-act of appending to a shared log into a real atomic operation.
   */
  writeIf?(path: string, data: Uint8Array, tag: string | null): Promise<string | null>;
  /** Current version tag of a file, for {@link VFSAdapter.writeIf}. */
  tag?(path: string): Promise<string | null>;
  /**
   * Changes since `token`. Pass `null` to obtain a starting token without
   * enumerating anything. Without it the engine falls back to walking.
   */
  changes?(token: string | null): Promise<VFSChangeFeed>;
}

// ---------------------------------------------------------------- entries

export type ConflictReason = 'binary' | 'block' | 'delete-edit' | 'kind';

/**
 * One row of `vfs.json`: the mirror of a single path in the working folder.
 *
 * v2 has no object store, so an entry *is* the metadata — the bytes are the
 * working file itself. `prev`/`prevPath` carry one step of history inline,
 * which is what replaces the commit graph: they answer "does this version
 * descend from that one?" without a DAG to walk.
 */
export interface VFSEntry {
  /** Logical identity, stable across renames. */
  uuid: string;
  kind: EntryKind;
  path: string;
  /** `null` for directories and tombstones. */
  hash: Hash | null;
  size: number;
  created: number;
  /**
   * Hybrid logical clock: `max(now, highest updated in the store + 1)`. Ordered
   * between peers as soon as they have met once, unlike a raw wall clock.
   */
  updated: number;
  /** Peer that last changed this entry. Travels with it, so credit survives relays. */
  peer: string;
  deleted?: true;
  /** Hash this version descends from. */
  prev?: Hash | null;
  /** Second parent, set only on an auto-merged text version. */
  prev2?: Hash;
  /** Path this version was moved from. */
  prevPath?: string;
  /** Backend-native id (Drive `fileId`), when the backend has one. */
  native?: string;
  /**
   * Disk `mtime` observed when `hash` was computed — the other half of the
   * mtime+size filter of v1 §4, which is what keeps a scan from re-reading a
   * 700 MB ROM because something touched it.
   *
   * Node-local like `native`: it means nothing on another peer, takes no part
   * in {@link VFSFile.state}, and is dropped and re-stamped when a merged entry
   * is adopted.
   */
  mtime?: number;

  // ------------------------------------------------- pending conflict copy
  /** uuid of the entry in dispute. Present only on a conflict copy. */
  conflictOf?: string;
  reason?: ConflictReason;
  /** Hash of the ancestor, when whoever detected the conflict had it. */
  base?: Hash;
  /** Peer holding the bytes, for a copy too big to travel. */
  held?: string;
}

export type LogOpType = 'write' | 'rename' | 'delete';

/** One line of `.vfs/commits`: an immutable, replica-independent operation. */
export interface LogRow {
  /** `sha256(peer|uuid|at|type|path|hash)` — the dedup key that makes union idempotent. */
  op: Hash;
  /** Groups the operations of one save or one merge, so the UI can narrate them. */
  batch: string;
  at: number;
  peer: string;
  uuid: string;
  type: LogOpType;
  kind: EntryKind;
  path: string;
  hash?: Hash | null;
  size?: number;
  prev?: Hash | null;
  prev2?: Hash;
  prevPath?: string;
}

/** Where a peer's log reading got to, and what it had seen. */
export interface PeerMark {
  lastSync: number;
  /** Segment the offset refers to; a different one means the peer rotated. */
  segment: number;
  offset: number;
  digest: Hash;
  /** `state` digest of that peer at `lastSync`. */
  state?: Hash;
}

/** Header markers for the append-only log. */
export interface LogMark {
  /** Timestamp identifying the active segment. */
  segment: number;
  /** XOR of every `op` in the active segment: same set or not, in one compare. */
  digest: Hash;
  rows: number;
  size: number;
  /** File name of the cumulative snapshot taken when the current segment opened. */
  snapshot?: string;
  /** Closed segments, oldest first. */
  archives?: number[];
}

/** Node-local markers. Travels in the file but is ignored by whoever reads it. */
export interface LocalState {
  driveChangeToken?: string;
  /** When the mirror was last checked against the disk. */
  verifiedAt?: number;
  pendingRenames?: Array<{ from: string; to: string }>;
}

/** The whole of `.vfs/vfs.json`. Header first, `entries` last. */
export interface VFSFile {
  version: 2;
  /** Identity of the dataset; converges on the lexicographically smaller. */
  storeId: string;
  /** Identity of this node. */
  peer: string;
  /** Digest of the live entries over the converging fields. */
  state: Hash;
  /** Extensions that get a three-way text merge. Converges by union. */
  text: string[];
  log: LogMark;
  peers: Record<string, PeerMark>;
  local: LocalState;
  entries: VFSEntry[];
}

/** Everything but `entries` — what a `readRange` of the head of the file yields. */
export type VFSHeader = Omit<VFSFile, 'entries'>;

/** A conflict waiting for a person, as surfaced by `node.conflicts()`. */
export interface PendingConflict {
  /** uuid of the conflict copy itself — what `resolve()` takes. */
  uuid: string;
  /** uuid of the entry in dispute. */
  of: string;
  reason: ConflictReason;
  /** Where the disputed file lives now (the winner). */
  path: string;
  /** Where the losing copy was parked. */
  copyPath: string;
  /** Peer that wrote the losing version. */
  peer: string;
  /** Set when the copy's bytes stayed on the peer that made it. */
  held?: string;
  /** Hash of the common ancestor, when it was known. */
  base?: Hash;
  mine: { hash: Hash | null; size: number; updated: number };
  theirs: { hash: Hash | null; size: number; updated: number };
}
