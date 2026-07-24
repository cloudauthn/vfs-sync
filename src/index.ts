export type {
  CachedFile,
  Commit,
  EntryKind,
  Hash,
  HashCache,
  NodeConfig,
  PendingRename,
  Tree,
  TreeEntry,
  VFSAdapter,
  VFSListEntry,
  VFSStat,
} from './types.js';

export { canonicalJSON, hashJSON, randomId, sha256 } from './hash.js';
export { basename, dirname, joinPath, normalizePath, splitExtension } from './path.js';
export { CONTROL_DIR, EMPTY_TREE, VFSStore, canonicalTree } from './store.js';
export type { KnownCommit } from './store.js';
export { walk } from './walk.js';
export type { WalkOptions, WalkedFile } from './walk.js';

export { VFSNode } from './vfs-node.js';
export type { CommitOptions, VFSNodeOptions } from './vfs-node.js';

export { defaultConflictName, mergeTrees, pairEntries } from './merge.js';
export type {
  ConflictCopyPolicy,
  ConflictKind,
  ConflictNameInfo,
  ConflictReport,
  MergeItem,
  MergeOptions,
  MergeResult,
  Side,
} from './merge.js';

export { sync, syncMesh, syncUntilStable } from './sync.js';
export type { MeshEdge, MeshResult, SyncOptions, SyncResult } from './sync.js';

export { MemoryAdapter } from './adapters/memory.js';
export type { MemoryAdapterOptions } from './adapters/memory.js';
export { HandleAdapter } from './adapters/handle.js';
export { OPFSAdapter, isOPFSAvailable } from './adapters/opfs.js';
export type { OPFSAdapterOptions } from './adapters/opfs.js';
export { FSAAdapter, isFSAAvailable } from './adapters/fsa.js';
