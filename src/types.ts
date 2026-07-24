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
   * Backends with stable native identifiers (Google Drive `fileId`) implement
   * this so renames need no heuristic. OPFS/FSA/node leave it undefined and
   * the engine assigns synthetic ids instead.
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
   * makes "parse the ID3 tag of a 200 MB track" cost a few hundred bytes.
   */
  readRange?(path: string, range?: ByteRange): Promise<Uint8Array>;
  /** Streams a file, optionally only a range of it. */
  readStream?(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  /** Replaces a file's contents from a stream. Truncates on open. */
  writeStream?(path: string): Promise<WritableStream<Uint8Array>>;
}

/** One file as recorded in a tree snapshot. */
export interface TreeEntry {
  /** Identity that survives renames. Native id when available, else synthetic. */
  id: string;
  path: string;
  /** `null` for tombstones. */
  hash: Hash | null;
  size: number;
  /**
   * Logical modification time. It travels between peers unchanged so that
   * conflict resolution compares edit times, not write-to-disk times.
   */
  mtime: number;
  deleted?: boolean;
  renamedFrom?: string;
  /**
   * Peer that last changed this entry's content. Travels with the entry, so a
   * conflict three hops away is still credited to whoever made the edit rather
   * than to the neighbour that relayed it.
   */
  peer?: string;
}

/** Snapshot of a folder. Entries are sorted by id for a canonical encoding. */
export interface Tree {
  entries: TreeEntry[];
}

export interface Commit {
  tree: Hash;
  /** Empty for the root commit, two entries for a merge. */
  parents: Hash[];
  timestamp: number;
  peer: string;
}

export interface NodeConfig {
  id: string;
  head: Hash | null;
  /** Last commit exchanged with each peer, for diagnostics only. */
  peers: Record<string, { lastSync: number; head: Hash | null }>;
}

export interface CachedFile {
  hash: Hash;
  mtime: number;
  size: number;
  /**
   * Synthetic id assigned to this path. Persisted so that scanning twice
   * without committing in between does not mint a second id for the same file.
   */
  id?: string;
}

export interface PendingRename {
  from: string;
  to: string;
}

/** Local-only, never synced. Turns "did this change?" into a stat comparison. */
export interface HashCache {
  files: Record<string, CachedFile>;
  renames: PendingRename[];
}
