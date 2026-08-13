import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { ConflictError } from '../src/sync.js';
import {
  sync as engineSync,
  syncMesh as engineSyncMesh,
  syncUntilStable as engineSyncUntilStable,
} from '../src/sync.js';
import type { ConflictAnswer, MeshEdge, MeshResult, SyncOptions, SyncResult } from '../src/sync.js';
import type { ByteRange, VFSAdapter, VFSEntry } from '../src/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Calls {
  list: string[];
  read: string[];
  stat: string[];
  write: string[];
  reset(): void;
}

/**
 * A pass-through adapter that tallies what it was asked for. On a remote backend
 * every one of these is a round trip, so the tallies are what `vfs.json` and the
 * explorer's caches exist to keep down.
 */
export function counting(base: VFSAdapter): { adapter: VFSAdapter; calls: Calls } {
  const calls: Calls = {
    list: [],
    read: [],
    stat: [],
    write: [],
    reset() {
      this.list.length = 0;
      this.read.length = 0;
      this.stat.length = 0;
      this.write.length = 0;
    },
  };
  const adapter: VFSAdapter = {
    name: base.name,
    list: (path) => {
      calls.list.push(path);
      return base.list(path);
    },
    read: (path) => {
      calls.read.push(path);
      return base.read(path);
    },
    stat: (path) => {
      calls.stat.push(path);
      return base.stat(path);
    },
    write: (path, data) => {
      calls.write.push(path);
      return base.write(path, data);
    },
    delete: (path) => base.delete(path),
    rename: (from, to) => base.rename(from, to),
    mkdir: (path) => base.mkdir?.(path) ?? Promise.resolve(),
    readRange: (path, range?: ByteRange) => {
      calls.read.push(path);
      return base.readRange?.(path, range) ?? base.read(path);
    },
  };
  return { adapter, calls };
}

export interface Peer {
  node: VFSNode;
  fs: MemoryAdapter;
}

let clock = 1_700_000_000_000;

/**
 * Strictly increasing timestamps.
 *
 * v2 stamps entries with a hybrid logical clock — `max(now, highest seen + 1)`
 * — so ordering two edits is a matter of *when each peer recorded them*, not of
 * their filesystem mtimes. Driving `now` is therefore how a test scripts "A
 * edited before B", and `setMtime` no longer has anything to do with it.
 */
export function tick(step = 1000): number {
  clock += step;
  return clock;
}

/** Reads the clock without moving it. */
export function at(): number {
  return clock;
}

/**
 * `sync` on the same clock as the nodes.
 *
 * Not a convenience. `sync()` defaults `now` to `Date.now()` while `peer()`
 * hands its nodes {@link tick}, and the two scales are three years apart — so
 * every peer mark landed in the future relative to every entry, and
 * `pruneTombstones` (which keeps a tombstone when `updated >= floor`) dropped
 * every one of them the moment it was written. The suite was exercising the
 * pruned-tombstone path everywhere, and `delete-edit` could not happen at all:
 * the merge saw an absence where there was a deletion.
 *
 * One clock, and time in a test is only what the test advances.
 */
export function sync(a: VFSNode, b: VFSNode, options: SyncOptions = {}): Promise<SyncResult> {
  return engineSync(a, b, { now: () => tick(), ...options });
}

export function syncMesh(edges: MeshEdge[], options: SyncOptions = {}): Promise<MeshResult[]> {
  return engineSyncMesh(edges, { now: () => tick(), ...options });
}

export function syncUntilStable(
  edges: MeshEdge[],
  options: SyncOptions & { maxRounds?: number } = {},
): Promise<MeshResult[][]> {
  return engineSyncUntilStable(edges, { now: () => tick(), ...options });
}

export async function peer(
  name: string,
  options: {
    rotateAt?: number;
    text?: (path: string) => boolean;
    materialize?: (entry: VFSEntry) => boolean;
  } = {},
): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, {
    id: name,
    now: () => tick(),
    ...(options.rotateAt !== undefined ? { rotateAt: options.rotateAt } : {}),
    ...(options.text ? { text: options.text } : {}),
    ...(options.materialize ? { materialize: options.materialize } : {}),
  });
  return { node, fs };
}

export async function put(p: Peer, path: string, text: string): Promise<void> {
  await p.node.write(path, encoder.encode(text));
}

export async function get(p: Peer, path: string): Promise<string> {
  return decoder.decode(await p.node.read(path));
}

export function files(p: Peer): Record<string, string> {
  return p.fs.snapshot();
}

/** Live entries as `path -> hash`, the shape most assertions want. */
export async function tracked(p: Peer): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const entry of await p.node.live()) out[entry.path] = entry.hash;
  return out;
}

export async function entryAt(p: Peer, path: string): Promise<VFSEntry | undefined> {
  return (await p.node.live()).find((entry) => entry.path === path);
}

/**
 * One sync, answering whatever it reports as needing a person.
 *
 * `sync()` writes nothing at all while a conflict is waiting for a decision, so
 * any test that wants the far side of a conflict has to answer it first. This is
 * the shape the API now has — look, decide, sync again — with `'both'` standing
 * in for the user who keeps the two versions.
 */
export async function settle(
  a: VFSNode,
  b: VFSNode,
  answer: ConflictAnswer = { action: 'keep-both' },
  options: SyncOptions = {},
): Promise<SyncResult> {
  try {
    return await sync(a, b, options);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const decisions = error.conflicts.map((conflict) => ({ id: conflict.id, ...answer }));
    return sync(a, b, { ...options, decisions });
  }
}

/**
 * Drives a mesh to a standstill, answering conflicts as they come up.
 *
 * `syncUntilStable` cannot do this on its own any more, and deliberately so: an
 * edge with a pending decision writes nothing, so a mesh left to itself stops at
 * the first conflict. Something has to decide, and in a test that something is
 * `choice`.
 */
export async function stabilise(
  edges: Array<{ a: VFSNode; b: VFSNode }>,
  options: { rounds?: number; answer?: ConflictAnswer } = {},
): Promise<void> {
  const rounds = options.rounds ?? 12;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (const edge of edges) {
      const result = await settle(edge.a, edge.b, options.answer ?? { action: 'keep-both' });
      if (result.changed && result.applied) moved = true;
    }
    if (!moved) break;
  }
}

export { decoder, encoder };
