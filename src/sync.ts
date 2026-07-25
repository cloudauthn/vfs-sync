import { EMPTY_TREE, type KnownCommit, type VFSStore } from './store.js';
import { canStream } from './stream.js';
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
  /** Most recent commit both heads descend from, `null` on a first encounter. */
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
  await unifyStoreIds(a, b);

  const aHead = await a.head();
  const bHead = await b.head();

  // 1. common ancestor: the newest commit both heads descend from
  const aKnown = await a.store.known();
  const bKnown = await b.store.known();
  const graph = new Map([...aKnown, ...bKnown]);
  const base = mergeBase(graph, (hash) => aKnown.has(hash) && bKnown.has(hash), aHead, bHead);

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
  // A blob only streams if *both* ends can: the slower peer sets the terms.
  const threshold = Math.min(a.streamThreshold, b.streamThreshold);
  for (const entry of tree.entries) {
    if (!entry.hash) continue;
    const big = entry.size >= threshold;
    if (await copyObject(b.store, a.store, entry.hash, big)) transferred.toA++;
    else if (await copyObject(a.store, b.store, entry.hash, big)) transferred.toB++;
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
    const at = now();
    await a.store.finalizeSync(head, b.id, head, at);
    await b.store.finalizeSync(head, a.id, head, at);
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
  await a.store.finalizeSync(head, b.id, head, commit.timestamp);

  await b.store.putCommitAt(head, commit);
  await b.applyTree(tree);
  await b.store.finalizeSync(head, a.id, head, commit.timestamp);

  return { base, head, changed: true, conflicts, transferred };
}

/**
 * Two folders that sync are the same dataset, so their `storeId`s converge:
 * both adopt the lexicographically smaller of the two. Deterministic on both
 * sides and transitive across edges, so a whole mesh settles on one id.
 */
async function unifyStoreIds(a: VFSNode, b: VFSNode): Promise<void> {
  const aConfig = await a.store.readConfig();
  const bConfig = await b.store.readConfig();
  const ids = [aConfig.storeId, bConfig.storeId].filter((id): id is string => !!id).sort();
  const shared = ids[0];
  if (!shared) return;
  if (aConfig.storeId !== shared) {
    aConfig.storeId = shared;
    await a.store.writeConfig(aConfig);
  }
  if (bConfig.storeId !== shared) {
    bConfig.storeId = shared;
    await b.store.writeConfig(bConfig);
  }
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

/**
 * Every commit reachable from `head` through parent links, `head` included. A
 * commit missing from the index ends that branch of the walk instead of
 * throwing: an incomplete index can only make the base older, never wrong.
 */
function ancestorsOf(graph: Map<Hash, KnownCommit>, head: Hash): Set<Hash> {
  const seen = new Set<Hash>([head]);
  const stack: Hash[] = [head];
  while (stack.length > 0) {
    const entry = graph.get(stack.pop() as Hash);
    if (!entry) continue;
    for (const parent of entry.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return seen;
}

/**
 * Newest commit both heads descend from.
 *
 * Ancestry has to be walked rather than inferred from timestamps. Two peers
 * commit inside the same millisecond routinely, and "newest commit both peers
 * know about" is not the same thing as "newest commit both peers descend from":
 * after one sync each peer knows the other's first commit, which is an ancestor
 * of neither head. Using one of those as the base means resolving changes
 * against a tree this pair never shared — the entry is simply absent from it, so
 * `mergeTrees` has no ancestor path to compare against and a rename decays into
 * an mtime coin-flip.
 *
 * `shared` keeps candidates to commits both peers have on disk, since the base
 * tree has to be readable locally.
 */
function mergeBase(
  graph: Map<Hash, KnownCommit>,
  shared: (hash: Hash) => boolean,
  aHead: Hash | null,
  bHead: Hash | null,
): Hash | null {
  if (!aHead || !bHead) return null;

  const inB = ancestorsOf(graph, bHead);
  const common = [...ancestorsOf(graph, aHead)].filter((hash) => inB.has(hash) && shared(hash));
  if (common.length <= 1) return common[0] ?? null;

  // A candidate that another candidate descends from carries no information the
  // descendant does not already carry. What survives is the frontier.
  const redundant = new Set<Hash>();
  for (const candidate of common) {
    for (const parent of graph.get(candidate)?.parents ?? []) {
      for (const hash of ancestorsOf(graph, parent)) redundant.add(hash);
    }
  }
  const frontier = common.filter((hash) => !redundant.has(hash));

  // Criss-cross histories can leave more than one candidate on the frontier.
  // Any of them is a valid base; the ordering only has to be one both peers
  // compute identically, so an edge merges the same way whichever side
  // initiates it. (A frontier can only come back empty if the index contains a
  // parent cycle, which means it is corrupt — fall back rather than fail.)
  const pool = frontier.length > 0 ? frontier : common;
  return (
    [...pool].sort(
      (x, y) => (graph.get(y)?.timestamp ?? 0) - (graph.get(x)?.timestamp ?? 0) || (x < y ? -1 : 1),
    )[0] ?? null
  );
}

async function treeOf(store: VFSStore, commitHash: Hash): Promise<Tree> {
  return store.getTree((await store.getCommit(commitHash)).tree);
}

async function commitTree(store: VFSStore, commitHash: Hash): Promise<Hash> {
  return (await store.getCommit(commitHash)).tree;
}

/**
 * Which of two commits both peers adopt when their content already agrees.
 *
 * A descendant beats its own ancestor — it contains that history already, so
 * taking the ancestor would throw commits away. Otherwise newest wins, with the
 * hash as tiebreak: a rule applied to the same inputs on both sides, so both
 * reach the same answer without another round trip.
 */
async function newerCommit(node: VFSNode, left: Hash, right: Hash): Promise<Hash> {
  const known = await node.store.known();
  if (ancestorsOf(known, left).has(right)) return left;
  if (ancestorsOf(known, right).has(left)) return right;
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

async function copyObject(
  from: VFSStore,
  to: VFSStore,
  hash: Hash,
  stream = false,
): Promise<boolean> {
  if (await to.hasObject(hash)) return false;
  if (!(await from.hasObject(hash))) return false;
  if (stream && canStream(from.adapter) && canStream(to.adapter)) {
    // Verified on arrival, so a truncated transfer cannot land as a valid
    // object — putObjectStreamAt re-hashes what it wrote.
    await to.putObjectStreamAt(hash, await from.getObjectStream(hash));
  } else {
    await to.putObjectAt(hash, await from.getObject(hash));
  }
  return true;
}
