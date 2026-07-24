import { EMPTY_TREE, type VFSStore } from './store.js';
import { mergeTrees } from './merge.js';
import type { ConflictCopyPolicy, ConflictNameInfo, ConflictReport } from './merge.js';
import type { Commit, Hash, Tree } from './types.js';
import type { VFSNode } from './vfs-node.js';

export interface SyncOptions {
  conflictCopies?: ConflictCopyPolicy;
  conflictName?: (info: ConflictNameInfo) => string;
  now?: () => number;
}

export interface SyncResult {
  /** Most recent commit both peers already knew, `null` on a first encounter. */
  base: Hash | null;
  /** The commit both peers point at once the sync finishes. */
  head: Hash | null;
  /** False when both folders were already identical. */
  changed: boolean;
  conflicts: ConflictReport[];
  /** Blob copies performed in each direction. */
  transferred: { toA: number; toB: number };
}

/**
 * Syncs one edge of the mesh. Both peers end up on the same merge commit with
 * identical content; nothing is assumed about who else either of them talks to,
 * which is what lets changes travel along chains (A <-> B <-> C) one edge at a
 * time.
 */
export async function sync(a: VFSNode, b: VFSNode, options: SyncOptions = {}): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());

  await a.commit();
  await b.commit();

  const aHead = await a.head();
  const bHead = await b.head();

  // 1. common ancestor: a set intersection over the known-commits index
  const aKnown = await a.store.known();
  const bKnown = await b.store.known();
  let base: Hash | null = null;
  let baseTimestamp = -Infinity;
  for (const [hash, entry] of aKnown) {
    if (!bKnown.has(hash)) continue;
    if (entry.timestamp > baseTimestamp || (entry.timestamp === baseTimestamp && hash < (base ?? ''))) {
      base = hash;
      baseTimestamp = entry.timestamp;
    }
  }

  // 2. exchange the commits each side is missing, so both keep a complete index
  await copyCommits(a, b, [...aKnown.keys()].filter((h) => !bKnown.has(h)));
  await copyCommits(b, a, [...bKnown.keys()].filter((h) => !aKnown.has(h)));

  const baseTree = base ? await treeOf(a.store, base) : EMPTY_TREE;
  const aTree = await a.headTree();
  const bTree = await b.headTree();

  // 3. merge
  const { tree, conflicts } = mergeTrees(baseTree, aTree, bTree, {
    peerA: a.id,
    peerB: b.id,
    ...(options.conflictCopies !== undefined ? { conflictCopies: options.conflictCopies } : {}),
    ...(options.conflictName ? { conflictName: options.conflictName } : {}),
  });

  // 4. move the blobs the merged tree needs to whichever side lacks them
  const transferred = { toA: 0, toB: 0 };
  for (const entry of tree.entries) {
    if (!entry.hash) continue;
    if (await copyObject(b.store, a.store, entry.hash)) transferred.toA++;
    else if (await copyObject(a.store, b.store, entry.hash)) transferred.toB++;
  }

  const treeHash = await a.store.putTree(tree);
  await b.store.putTree(tree);

  const aTreeHash = aHead ? await commitTree(a.store, aHead) : null;
  const bTreeHash = bHead ? await commitTree(b.store, bHead) : null;

  if (aHead === null && bHead === null && tree.entries.length === 0) {
    return { base, head: null, changed: false, conflicts, transferred };
  }

  // 5. content already agrees — only the history differs
  if (aTreeHash === treeHash && bTreeHash === treeHash) {
    if (aHead === bHead) {
      return { base, head: aHead, changed: false, conflicts, transferred };
    }
    // Committing a merge here would be pointless work, and in a chain it would
    // never settle: every pass would mint a commit for the next pass to merge.
    // Both peers instead adopt the same existing commit, chosen by a rule they
    // can both apply without talking: newest first, hash as tiebreak.
    const head = await newerCommit(a, aHead as Hash, bHead as Hash);
    await a.store.setHead(head);
    await b.store.setHead(head);
    await a.store.recordPeer(b.id, head, now());
    await b.store.recordPeer(a.id, head, now());
    return { base, head, changed: true, conflicts, transferred };
  }

  // 6. one merge commit, byte-identical on both peers, so both converge on the
  //    same hash without another round trip
  const parents = [aHead, bHead].filter((h): h is Hash => h !== null).sort();
  const commit: Commit = {
    tree: treeHash,
    parents: [...new Set(parents)],
    timestamp: now(),
    peer: a.id,
  };
  const head = await a.store.putCommit(commit);

  await a.applyTree(tree);
  await a.store.setHead(head);
  await a.store.recordPeer(b.id, head, commit.timestamp);

  await b.store.putCommitAt(head, commit);
  await b.applyTree(tree);
  await b.store.setHead(head);
  await b.store.recordPeer(a.id, head, commit.timestamp);

  return { base, head, changed: true, conflicts, transferred };
}

export interface MeshEdge {
  a: VFSNode;
  b: VFSNode;
}

export interface MeshResult {
  edge: MeshEdge;
  result: SyncResult;
}

/**
 * Runs every edge once, in order. Repeat until nothing changes to let updates
 * propagate down a chain — each pass moves a change one hop further.
 */
export async function syncMesh(edges: MeshEdge[], options: SyncOptions = {}): Promise<MeshResult[]> {
  const results: MeshResult[] = [];
  for (const edge of edges) {
    results.push({ edge, result: await sync(edge.a, edge.b, options) });
  }
  return results;
}

/** Repeats `syncMesh` until the mesh reaches a fixed point (or `maxRounds`). */
export async function syncUntilStable(
  edges: MeshEdge[],
  options: SyncOptions & { maxRounds?: number } = {},
): Promise<MeshResult[][]> {
  const maxRounds = options.maxRounds ?? 10;
  const rounds: MeshResult[][] = [];
  for (let round = 0; round < maxRounds; round++) {
    const results = await syncMesh(edges, options);
    rounds.push(results);
    if (!results.some((r) => r.result.changed)) break;
  }
  return rounds;
}

async function treeOf(store: VFSStore, commitHash: Hash): Promise<Tree> {
  return store.getTree((await store.getCommit(commitHash)).tree);
}

async function commitTree(store: VFSStore, commitHash: Hash): Promise<Hash> {
  return (await store.getCommit(commitHash)).tree;
}

/** Deterministic on both peers: newest timestamp, hash as tiebreak. */
async function newerCommit(node: VFSNode, left: Hash, right: Hash): Promise<Hash> {
  const known = await node.store.known();
  const leftAt = known.get(left)?.timestamp ?? (await node.store.getCommit(left)).timestamp;
  const rightAt = known.get(right)?.timestamp ?? (await node.store.getCommit(right)).timestamp;
  if (leftAt !== rightAt) return leftAt > rightAt ? left : right;
  return left > right ? left : right;
}

async function copyCommits(from: VFSNode, to: VFSNode, hashes: Hash[]): Promise<void> {
  for (const hash of hashes) {
    const commit = await from.store.getCommit(hash);
    // the tree travels with the commit: the ancestor negotiation needs to be
    // able to read any commit in the index, blobs stay on demand
    await copyObject(from.store, to.store, commit.tree);
    await to.store.putCommitAt(hash, commit);
  }
}

async function copyObject(from: VFSStore, to: VFSStore, hash: Hash): Promise<boolean> {
  if (await to.hasObject(hash)) return false;
  if (!(await from.hasObject(hash))) return false;
  await to.putObjectAt(hash, await from.getObject(hash));
  return true;
}
