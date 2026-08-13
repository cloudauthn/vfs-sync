import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { sha256 } from '../src/hash.js';
import { sync } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import type { VFSEntry } from '../src/types.js';
import type { Peer } from './helpers.js';
import { encoder, files, peer, put, settle, tick } from './helpers.js';

/**
 * Phase 2: selective materialisation.
 *
 * A node can hold the entry without holding the bytes. The tree is complete on
 * every peer; the folder is not. Which content a node keeps is a predicate the
 * app supplies, and the engine stores nothing about it — so nothing about it
 * can travel, and no peer has to agree with any other.
 *
 * The load-bearing rule, and the one most of these tests are about: **the
 * policy governs what arrives, never what is already on disk.** Skipping a
 * write for content this node holds would leave the file at the old hash while
 * the tree records the new one, and `scan()`'s mtime filter would never look at
 * it again.
 */

/** A peer whose policy is fixed from the start — no reopening, no stale cache. */
async function picky(name: string, materialize: (entry: VFSEntry) => boolean): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, { id: name, now: () => tick(), materialize });
  return { node, fs };
}

async function entry(node: VFSNode, path: string): Promise<VFSEntry | undefined> {
  return (await node.entries()).find((item) => item.path === path);
}

const hashOf = (text: string): Promise<string> => sha256(encoder.encode(text));

describe('selective materialisation', () => {
  it('takes the entry and leaves the bytes', async () => {
    const a = await peer('a');
    const b = await picky('b', (item) => item.size < 20);
    await put(a, 'catalogue.txt', 'small enough');
    await put(a, 'master.wav', 'x'.repeat(200));
    await sync(a.node, b.node);

    expect(files(b)['catalogue.txt']).toBe('small enough');
    expect(files(b)['master.wav']).toBeUndefined();

    // The entry is complete: same hash, same size, no bytes behind it.
    const held = await entry(b.node, 'master.wav');
    expect(held?.deleted).toBeFalsy();
    expect(held?.hash).toBe(await hashOf('x'.repeat(200)));
    expect(held?.mtime).toBeUndefined();
  });

  it('does not tombstone what it never materialised', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'master.wav', 'heavy');
    await sync(a.node, b.node);

    const { rows } = await b.node.scan();
    await b.node.commit();
    expect(rows.filter((row) => row.type === 'delete')).toEqual([]);
    expect((await entry(b.node, 'master.wav'))?.deleted).toBeFalsy();

    // And the tombstone that was never written cannot travel back to A.
    await sync(a.node, b.node);
    expect(files(a)['master.wav']).toBe('heavy');
  });

  it('keeps bytes it already holds current when the policy turns against them', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'track.flac', 'v1');
    await sync(a.node, b.node);
    expect(files(b)['track.flac']).toBe('v1');

    // The policy arrives after the fact — a size threshold lowered, a device
    // running out of room. The bytes are already here, and a skipped write
    // would strand them at v1 while the tree says v2. Nothing would ever
    // disagree with itself about it: the mtime is untouched, so the next scan
    // takes the fast path and never re-reads the file.
    const declining = await VFSNode.open(b.fs, { id: 'b', now: () => tick(), materialize: () => false });
    await put(a, 'track.flac', 'v2');
    await a.node.commit();
    await sync(a.node, declining);

    expect(files(b)['track.flac']).toBe('v2');
    const recorded = await entry(declining, 'track.flac');
    expect(recorded?.hash).toBe(await hashOf('v2'));
    expect(recorded?.hash).toBe(await hashOf(files(b)['track.flac'] as string));
  });

  it('applies a deletion to an entry it never materialised', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'gone.txt', 'here for now');
    await sync(a.node, b.node);
    expect((await entry(b.node, 'gone.txt'))?.deleted).toBeFalsy();

    await a.node.delete('gone.txt');
    await a.node.commit();
    await sync(a.node, b.node);

    expect((await entry(b.node, 'gone.txt'))?.deleted).toBe(true);
  });

  it('records a rename it has no file to perform', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'before.txt', 'travelling');
    await sync(a.node, b.node);

    await a.node.rename('before.txt', 'after.txt');
    await a.node.commit();
    await sync(a.node, b.node);

    expect((await entry(b.node, 'after.txt'))?.deleted).toBeFalsy();
    expect(files(b)['after.txt']).toBeUndefined();
    expect(files(b)['before.txt']).toBeUndefined();
  });

  it('materialises on demand, and the entry becomes ordinary', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'master.wav', 'the actual bytes');
    await sync(a.node, b.node);
    expect(files(b)['master.wav']).toBeUndefined();
    const before = await b.node.store.logRows();

    await b.node.materialize('master.wav', a.node);

    expect(files(b)['master.wav']).toBe('the actual bytes');
    // The stamp is what makes it ordinary: reconciliation stops reading its
    // absence as "never here" and would now report a real deletion.
    const held = await entry(b.node, 'master.wav');
    expect(held?.mtime).toBeDefined();
    expect(held?.hash).toBe(await hashOf('the actual bytes'));

    // Which content a node stores is not an operation on the mesh, so it adds
    // nothing to the history A already sent over.
    expect(await b.node.store.logRows()).toEqual(before);
  });

  it('refuses content that does not hash to what the tree declares', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'master.wav', 'the actual bytes');
    await sync(a.node, b.node);

    // A's file changes underneath without being recorded, so what it serves no
    // longer matches the hash both peers agreed on.
    await a.node.write('master.wav', encoder.encode('truncated'));

    await expect(b.node.materialize('master.wav', a.node)).rejects.toThrow(/arrived as/);
    expect(files(b)['master.wav']).toBeUndefined();
  });

  it('names the peer that cannot serve it', async () => {
    const a = await peer('a');
    const b = await picky('b', () => false);
    await put(a, 'master.wav', 'bytes');
    await sync(a.node, b.node);
    await a.node.delete('master.wav');

    await expect(b.node.materialize('master.wav', a.node)).rejects.toThrow(/cannot serve/);
  });

  it('resolves a conflict copy the policy declined to materialise', async () => {
    const a = await peer('a');
    const b = await picky('b', (item) => !item.path.includes('conflict'));
    await put(a, 'game.bin', 'shared');
    await sync(a.node, b.node);

    await put(a, 'game.bin', 'a re-dump from A');
    await a.node.commit();
    await put(b, 'game.bin', 'a re-dump from B');
    await settle(a.node, b.node);

    // The copy is an ordinary entry — not `held`, nobody kept it back. B simply
    // declined the bytes. Removing a file that is not there proves nothing, so
    // the tombstone has to be stated or the conflict is immortal.
    const [pending] = await b.node.conflicts();
    expect(pending).toBeDefined();
    expect(files(b)[pending?.copyPath as string]).toBeUndefined();

    await b.node.resolve(pending?.uuid as string, 'mine');
    expect(await b.node.conflicts()).toHaveLength(0);

    await sync(a.node, b.node);
    expect(await a.node.conflicts()).toHaveLength(0);
  });
});

describe('dematerialize', () => {
  it('frees the bytes, keeps the entry, and tells the mesh nothing', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'master.wav', 'heavy content');
    await sync(a.node, b.node);
    const before = await b.node.state();

    await b.node.dematerialize('master.wav', a.node);

    expect(files(b)['master.wav']).toBeUndefined();
    const held = await entry(b.node, 'master.wav');
    expect(held?.deleted).toBeFalsy();
    expect(held?.hash).toBe(await hashOf('heavy content'));
    expect(held?.mtime).toBeUndefined();

    // `mtime` is outside the digest, so releasing bytes is not a change anyone
    // else can see — and there is no row for it either.
    expect(await b.node.state()).toBe(before);
    const rows = await b.node.store.logRows();
    expect(rows.filter((row) => row.type === 'delete')).toEqual([]);
  });

  it('leaves the freed entry alone on the next scan', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'master.wav', 'heavy content');
    await sync(a.node, b.node);
    await b.node.dematerialize('master.wav', a.node);

    const { rows } = await b.node.scan();
    await b.node.commit();
    expect(rows.filter((row) => row.type === 'delete')).toEqual([]);
    expect((await entry(b.node, 'master.wav'))?.deleted).toBeFalsy();

    // And the tombstone that was never written cannot travel to A.
    await sync(a.node, b.node);
    expect(files(a)['master.wav']).toBe('heavy content');
    expect((await entry(a.node, 'master.wav'))?.deleted).toBeFalsy();
  });

  it('stays freed when the policy declines it', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'master.wav', 'heavy content');
    await sync(a.node, b.node);
    expect(files(b)['master.wav']).toBe('heavy content');

    // Unpinning is two moves, and either alone is incomplete: the policy does
    // not free what is already here, and freeing without the policy is undone
    // on the next sync.
    const unpinned = await VFSNode.open(b.fs, { id: 'b', now: () => tick(), materialize: () => false });
    await unpinned.dematerialize('master.wav', a.node);
    await sync(a.node, unpinned);

    expect(files(b)['master.wav']).toBeUndefined();
    expect((await entry(unpinned, 'master.wav'))?.deleted).toBeFalsy();
  });

  it('heals in the safe direction when interrupted', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'master.wav', 'heavy content');
    await sync(a.node, b.node);

    // The crash window: the header says the bytes are gone, the file is still
    // there. Written the other way round this is the deletion-by-inference the
    // engine exists to not do.
    const file = await b.node.file();
    file.entries = file.entries.map((item) =>
      item.path === 'master.wav' ? { ...item, mtime: undefined } : item,
    );
    await b.node.store.write(file);

    const { rows } = await b.node.scan();
    await b.node.commit();

    expect(files(b)['master.wav']).toBe('heavy content');
    expect((await entry(b.node, 'master.wav'))?.mtime).toBeDefined();
    // Healing is not an edit: no row, and nothing that could win a tiebreak.
    expect(rows).toEqual([]);
  });

  it('refuses to drop the last copy', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'only.txt', 'the one copy');
    await sync(a.node, b.node);
    await a.node.delete('only.txt');

    await expect(b.node.dematerialize('only.txt', a.node)).rejects.toThrow(/would leave no copy/);
    expect(files(b)['only.txt']).toBe('the one copy');
    expect((await entry(b.node, 'only.txt'))?.mtime).toBeDefined();
  });

  it('lets a policy that still wants the entry fetch it back', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'master.wav', 'heavy content');
    await sync(a.node, b.node);
    await b.node.dematerialize('master.wav', a.node);
    expect(files(b)['master.wav']).toBeUndefined();

    // B's policy never declined this file — dematerialising was a manual move
    // against a standing decision, and the standing decision wins next time.
    await sync(a.node, b.node);
    expect(files(b)['master.wav']).toBe('heavy content');
  });
});
