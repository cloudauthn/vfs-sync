export type {
  ByteRange,
  ConflictReason,
  EntryKind,
  Hash,
  LocalState,
  LogMark,
  LogOpType,
  LogRow,
  PeerMark,
  PendingConflict,
  VFSAdapter,
  VFSChange,
  VFSChangeFeed,
  VFSEntry,
  VFSFile,
  VFSHeader,
  VFSListEntry,
  VFSStat,
} from './types.js';

export { canonicalJSON, hashJSON, randomId, sha256, sha256Stream } from './hash.js';
export { Sha256 } from './sha256.js';
export {
  CHUNK_SIZE,
  STREAM_THRESHOLD,
  canStream,
  chunked,
  collect,
  concat,
  pump,
  readRange,
  readStream,
  writeStream,
} from './stream.js';
export { basename, dirname, joinPath, normalizePath, splitExtension } from './path.js';

export { CONTROL_DIR, ROTATE_AT, VFSStore } from './store.js';
export type { VFSStoreOptions } from './store.js';
export {
  DEFAULT_TEXT_EXTENSIONS,
  HEADER_PROBE,
  ZERO_DIGEST,
  canonicalEntry,
  decodeVFSFile,
  emptyFile,
  encodeVFSFile,
  extensionOf,
  normalizeFile,
  parseHeader,
  sortEntries,
  stateDigest,
} from './vfs-file.js';
export {
  canonicalRow,
  encodeRows,
  makeRow,
  missingRows,
  opId,
  parseRows,
  sortRows,
  unionRows,
  xorDigest,
  xorHex,
} from './log.js';
export { History } from './history.js';
export { MAX_TEXT_MERGE, diff3, splitLines } from './diff3.js';
export type { Diff3Result } from './diff3.js';

export { walk } from './walk.js';
export type { WalkOptions, WalkedFile } from './walk.js';

export { VFSNode } from './vfs-node.js';
export type { ContentHandle, ContentSource, ScanResult, VFSNodeOptions } from './vfs-node.js';

export { HELD_AT, defaultConflictName, mergeEntries, pairEntries, pickNewer } from './merge.js';
export type {
  ConflictCopyPolicy,
  ConflictKind,
  ConflictNameInfo,
  ConflictReport,
  MergeItem,
  MergeOptions,
  MergeResult,
  MergeSide,
  Side,
} from './merge.js';

export { sync, syncMesh, syncUntilStable } from './sync.js';
export type { MeshEdge, MeshResult, SyncOptions, SyncResult, TextConflictInfo } from './sync.js';

export { MemoryAdapter } from './adapters/memory.js';
export type { MemoryAdapterOptions } from './adapters/memory.js';
export { HandleAdapter } from './adapters/handle.js';
export { OPFSAdapter, isOPFSAvailable } from './adapters/opfs.js';
export type { OPFSAdapterOptions } from './adapters/opfs.js';
export { FSAAdapter, isFSAAvailable } from './adapters/fsa.js';
export { GDriveAdapter } from './adapters/gdrive.js';
export type { GDriveAdapterOptions, GDriveSpace, GDriveTokenProvider } from './adapters/gdrive.js';
export { ScopedAdapter } from './adapters/scoped.js';
