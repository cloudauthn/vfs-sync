import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { syncUntilStable } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import type { MeshEdge } from '../src/sync.js';

/**
 * Phase 0 of the plan, and the reason it comes first.
 *
 * v1 traded a structural guarantee — the commit DAG — for a property of the
 * merge algorithm: run any sequence of edits through any order of edges and
 * every peer must land on the same tree. That class of property does not break
 * in the cases somebody writes by hand, so it gets a property test: random
 * operations, random edges, sync to a fixed point, and then the assertion that
 * `state` and the working folders agree everywhere.
 */

const encoder = new TextEncoder();

/** Deterministic PRNG, so a failure is reproducible from its seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

const NAMES = ['a.txt', 'b.txt', 'notes.md', 'roms/game.nfo', 'roms/game.bin', 'music/album.m3u'];

interface Peer {
  node: VFSNode;
  fs: MemoryAdapter;
}

async function world(
  seed: number,
  peers = 3,
  rotateAt?: number,
): Promise<{ peers: Peer[]; edges: MeshEdge[] }> {
  let clock = 1_700_000_000_000;
  const tick = () => (clock += 1000);
  const out: Peer[] = [];
  for (let i = 0; i < peers; i++) {
    const fs = new MemoryAdapter(`p${i}`, { clock: () => tick() });
    out.push({
      fs,
      node: await VFSNode.open(fs, {
        id: `p${i}`,
        now: () => tick(),
        ...(rotateAt !== undefined ? { rotateAt } : {}),
      }),
    });
  }
  const edges: MeshEdge[] = [];
  for (let i = 0; i < out.length; i++) {
    const left = out[i] as Peer;
    const right = out[(i + 1) % out.length] as Peer;
    if (out.length === 2 && i === 1) break;
    edges.push({ a: left.node, b: right.node });
  }
  void seed;
  return { peers: out, edges };
}

/** One random operation on one random peer. */
async function step(peers: Peer[], next: () => number, round: number): Promise<void> {
  const peer = peers[Math.floor(next() * peers.length)] as Peer;
  const name = NAMES[Math.floor(next() * NAMES.length)] as string;
  const roll = next();
  const live = Object.keys(peer.fs.snapshot());

  if (roll < 0.5) {
    await peer.node.write(name, encoder.encode(`r${round}-${peer.node.id}-${Math.floor(next() * 5)}`));
    return;
  }
  if (roll < 0.7 && live.length > 0) {
    const from = live[Math.floor(next() * live.length)] as string;
    const to = `moved/${Math.floor(next() * 4)}/${from.split('/').pop() as string}`;
    if (from !== to && !live.includes(to)) await peer.node.rename(from, to);
    return;
  }
  if (roll < 0.85 && live.length > 0) {
    await peer.node.delete(live[Math.floor(next() * live.length)] as string);
    return;
  }
  await peer.node.mkdir(`dirs/${Math.floor(next() * 3)}`);
}

describe('convergence', () => {
  for (const seed of [1, 2, 3, 7, 11, 23, 42, 99, 1234, 65_535]) {
    it(`reaches one state from a random history (seed ${seed})`, async () => {
      const next = rng(seed);
      const { peers, edges } = await world(seed);

      for (let round = 0; round < 12; round++) {
        const operations = 1 + Math.floor(next() * 3);
        for (let i = 0; i < operations; i++) await step(peers, next, round);
        // Sometimes sync in between, sometimes let divergence pile up.
        if (next() < 0.6) await syncUntilStable(edges, { maxRounds: 6 });
      }
      await syncUntilStable(edges, { maxRounds: 12 });

      const states = await Promise.all(peers.map((peer) => peer.node.state()));
      expect(new Set(states).size, `states: ${states.join(' ')}`).toBe(1);

      const snapshots = peers.map((peer) => peer.fs.snapshot());
      for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);

      // And the mirror actually mirrors: what `vfs.json` claims is on disk.
      for (const peer of peers) {
        const tracked = (await peer.node.live())
          .filter((entry) => entry.kind === 'file')
          .map((entry) => entry.path)
          .sort();
        expect(tracked).toEqual(Object.keys(peer.fs.snapshot()).sort());
      }
    });
  }

  /**
   * The same property with the log rotating constantly, which is where §10's
   * top risk lives: rotate without a snapshot, or prune `vfs.json` before
   * photographing it, and a deleted file comes back. A tiny threshold makes
   * every few operations cross a segment boundary.
   */
  for (const seed of [3, 17, 64, 512, 4096]) {
    it(`converges across rotations and tombstone pruning (seed ${seed})`, async () => {
      const next = rng(seed);
      const { peers, edges } = await world(seed, 3, 400);

      for (let round = 0; round < 14; round++) {
        for (let i = 0; i < 1 + Math.floor(next() * 3); i++) await step(peers, next, round);
        if (next() < 0.6) await syncUntilStable(edges, { maxRounds: 6 });
      }
      await syncUntilStable(edges, { maxRounds: 12 });

      const states = await Promise.all(peers.map((peer) => peer.node.state()));
      expect(new Set(states).size, `states: ${states.join(' ')}`).toBe(1);
      const snapshots = peers.map((peer) => peer.fs.snapshot());
      for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
      // The rotation actually happened, or the test proves nothing.
      expect((await peers[0]?.node.file())?.log.snapshot).toBeTypeOf('string');
    });
  }

  it('settles a two-peer mesh whatever order the edges run in', async () => {
    const next = rng(7);
    const { peers, edges } = await world(7, 2);
    for (let round = 0; round < 8; round++) {
      await step(peers, next, round);
      await step(peers, next, round);
    }
    await syncUntilStable(edges, { maxRounds: 12 });
    await syncUntilStable([{ a: edges[0]?.b as VFSNode, b: edges[0]?.a as VFSNode }], {
      maxRounds: 4,
    });

    expect(peers[1]?.fs.snapshot()).toEqual(peers[0]?.fs.snapshot());
    expect(await peers[1]?.node.state()).toBe(await peers[0]?.node.state());
  });
});
