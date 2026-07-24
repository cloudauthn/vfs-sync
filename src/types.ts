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
