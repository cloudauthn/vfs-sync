import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { sync, syncUntilStable } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import { files, get, peer, put } from './helpers.js';
import type { Peer } from './helpers.js';

/** Commit timestamp shared by every peer below, and by `sync` itself. */
const FROZEN = 1_700_000_000_000;
const frozen = { now: () => FROZEN };

/**
 * A peer that commits on a stopped clock, so every commit carries the same
 * timestamp. Real peers hit this constantly — a sync commits both sides inside
 * the same millisecond — and it used to be the difference between a rename
 * arriving and being silently dropped.
 *
 * `mtime` is separate on purpose: filesystem clocks are per-peer, and a file
 * written by `applyTree` is stamped with the *receiving* peer's clock, which
 * can easily run ahead of the peer that made the edit.
 */
async function frozenPeer(name: string, mtime = FROZEN): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => mtime });
  const node = await VFSNode.open(fs, { id: name, now: () => FROZEN });
  return { node, fs };
}

describe('sync', () => {
  it('copies files both ways on a first encounter', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'from-a.md', 'A');
    await put(b, 'from-b.md', 'B');

    const result = await sync(a.node, b.node);

    expect(result.base).toBeNull(); // never met before
    expect(result.changed).toBe(true);
    expect(files(a)).toEqual({ 'from-a.md': 'A', 'from-b.md': 'B' });
    expect(files(b)).toEqual(files(a));
    expect(await a.node.head()).toBe(await b.node.head());
  });

  it('is a no-op when nothing changed', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello');

    await sync(a.node, b.node);
    const second = await sync(a.node, b.node);

    expect(second.changed).toBe(false);
    expect(second.base).not.toBeNull(); // the merge commit is now common ground
  });

  it('propagates an edit made after the first sync', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');
    await sync(a.node, b.node);

    await put(b, 'notes.md', 'v2');
    await sync(a.node, b.node);

    expect(await get(a, 'notes.md')).toBe('v2');
  });

  it('propagates a delete', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');
    await sync(a.node, b.node);

    await a.node.delete('notes.md');
    await sync(a.node, b.node);

    expect(files(b)).toEqual({});
  });

  it('propagates a rename without re-transferring content', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');
    await sync(a.node, b.node);

    await a.node.rename('notes.md', 'docs/notes.md');
    const result = await sync(a.node, b.node);

    expect(files(b)).toEqual({ 'docs/notes.md': 'v1' });
    expect(result.transferred).toEqual({ toA: 0, toB: 0 }); // blob already there
  });

  it('resolves a real conflict by mtime and keeps a copy of the loser', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'shared');
    await sync(a.node, b.node);

    await put(a, 'notes.md', 'from A');
    a.fs.setMtime('notes.md', 5_000);
    await put(b, 'notes.md', 'from B');
    b.fs.setMtime('notes.md', 9_000);

    const result = await sync(a.node, b.node);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe('b');
    expect(await get(a, 'notes.md')).toBe('from B');

    const copies = Object.entries(files(a)).filter(([path]) => path.includes('conflict'));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.[1]).toBe('from A');
    expect(files(b)).toEqual(files(a));
  });

  it('does not flag a conflict when both sides made the same edit', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'shared');
    await sync(a.node, b.node);

    await put(a, 'notes.md', 'same edit');
    await put(b, 'notes.md', 'same edit');
    const result = await sync(a.node, b.node);

    expect(result.conflicts).toHaveLength(0);
    expect(files(a)).toEqual({ 'notes.md': 'same edit' });
  });

  it('reconciles files the two peers discovered independently', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'identical');
    await put(b, 'notes.md', 'identical');

    const result = await sync(a.node, b.node);

    expect(result.conflicts).toHaveLength(0);
    expect(files(a)).toEqual({ 'notes.md': 'identical' });

    // one id won and is now canonical on both sides
    const idsA = (await a.node.headTree()).entries.map((e) => e.id);
    const idsB = (await b.node.headTree()).entries.map((e) => e.id);
    expect(idsA).toEqual(idsB);
    expect(idsA).toHaveLength(1);
  });

  it('converges after repeated syncs', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');

    await sync(a.node, b.node);
    await sync(a.node, b.node);
    const third = await sync(a.node, b.node);

    expect(third.changed).toBe(false);
    expect((await a.node.log()).length).toBeLessThanOrEqual(3);
  });
});

describe('common ancestor', () => {
  /**
   * The base has to be an actual ancestor of both heads. "Newest commit both
   * peers have heard of" is a different set: after one sync each peer knows the
   * other's first commit, and those are ancestors of neither head. Picking one
   * hands mergeTrees a tree in which the renamed file never existed, so the
   * location decision falls through to an mtime tie-break and the rename dies.
   */
  it('picks the commit both heads descend from, not the newest one both have seen', async () => {
    // The candidates' hashes order differently per file name, and the old rule
    // broke timestamp ties on hash — so a single name would have caught this
    // only sometimes. Every suffix has to hold.
    for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const local = await frozenPeer('local');
      // the receiving peer's filesystem runs ahead of the one making the edits
      const remote = await frozenPeer('remote', FROZEN + 5000);

      await put(local, `notes-${suffix}.md`, 'from local');
      await put(remote, `todo-${suffix}.md`, 'from remote');
      const first = await sync(local.node, remote.node, frozen);

      await local.node.rename(`notes-${suffix}.md`, `docs/notes-${suffix}.md`);
      const second = await sync(local.node, remote.node, frozen);

      expect(second.base, `base for ${suffix}`).toBe(first.head);
      expect(files(remote), `files for ${suffix}`).toEqual({
        [`docs/notes-${suffix}.md`]: 'from local',
        [`todo-${suffix}.md`]: 'from remote',
      });
    }
  });

  it('survives a delete alongside the rename', async () => {
    const local = await frozenPeer('local');
    const remote = await frozenPeer('remote', FROZEN + 5000);

    await put(local, 'notes.md', 'from local');
    await put(remote, 'todo.md', 'from remote');
    await sync(local.node, remote.node, frozen);

    await local.node.rename('notes.md', 'docs/notes.md');
    await local.node.delete('todo.md');
    await sync(local.node, remote.node, frozen);

    expect(files(remote)).toEqual({ 'docs/notes.md': 'from local' });
    expect(await local.node.head()).toBe(await remote.node.head());
  });

  it('adopts the descendant when the trees agree but the history does not', async () => {
    const a = await frozenPeer('device-a');
    const b = await frozenPeer('device-b');
    await put(a, 'notes.md', 'shared');
    await sync(a.node, b.node, frozen);
    const shared = await a.node.head();

    // an empty commit: same tree, new history, identical timestamp
    const descendant = await b.node.commit({ force: true });
    expect(descendant).not.toBe(shared);

    const result = await sync(a.node, b.node, frozen);

    // taking `shared` here would drop the descendant's commit on the floor
    expect(result.head).toBe(descendant);
    expect(await a.node.head()).toBe(descendant);
    expect(await b.node.head()).toBe(descendant);
  });

  it('has no base the first time two peers meet', async () => {
    const a = await frozenPeer('device-a');
    const b = await frozenPeer('device-b');
    await put(a, 'a.md', 'A');
    await put(b, 'b.md', 'B');
    expect((await sync(a.node, b.node, frozen)).base).toBeNull();
  });

  it('has no base when the peers share history but one has never committed', async () => {
    const a = await frozenPeer('device-a');
    const b = await frozenPeer('device-b');
    await put(a, 'a.md', 'A');
    const result = await sync(a.node, b.node, frozen);
    expect(result.base).toBeNull();
    expect(files(b)).toEqual({ 'a.md': 'A' });
  });
});

describe('chains', () => {
  it('carries a change from A to C through B', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');
    const edges = [
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ];

    await put(a, 'notes.md', 'from A');
    await syncUntilStable(edges);

    expect(files(c)).toEqual({ 'notes.md': 'from A' });
    expect(await a.node.head()).toBe(await c.node.head());
  });

  it('reaches the same state from edits made at both ends', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');
    const edges = [
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ];

    await put(a, 'a.md', 'A');
    await put(c, 'c.md', 'C');
    await syncUntilStable(edges);

    expect(files(a)).toEqual({ 'a.md': 'A', 'c.md': 'C' });
    expect(files(b)).toEqual(files(a));
    expect(files(c)).toEqual(files(a));
  });

  it('settles a conflict identically across the whole chain', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');
    const edges = [
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ];

    await put(a, 'notes.md', 'base');
    await syncUntilStable(edges);

    await put(a, 'notes.md', 'edited on A');
    a.fs.setMtime('notes.md', 1_000);
    await put(c, 'notes.md', 'edited on C');
    c.fs.setMtime('notes.md', 2_000);

    await syncUntilStable(edges);

    expect(await get(a, 'notes.md')).toBe('edited on C');
    expect(files(a)).toEqual(files(b));
    expect(files(b)).toEqual(files(c));

    // The conflict is detected on the B<->C edge, where B is merely relaying
    // A's edit — the copy must still be credited to A, who actually wrote it.
    const copies = Object.keys(files(a)).filter((path) => path.includes('conflict'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^notes \(conflict device-a [0-9a-f]{8}\)\.md$/);
    expect(files(a)[copies[0] as string]).toBe('edited on A');
  });
});
