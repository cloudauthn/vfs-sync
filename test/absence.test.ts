import { describe, expect, it } from 'vitest';
import type { MemoryAdapter } from '../src/adapters/memory.js';
import { sync } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import type { VFSEntry } from '../src/types.js';
import { encoder, files, peer, put, tick } from './helpers.js';

/**
 * Phase 1: absence stops being evidence of deletion.
 *
 * `scan()` used to infer what was deleted from what the walk did not return,
 * and the walk does not return a path for three different reasons: the user
 * removed it, the current rule filters it, or this node never materialised the
 * bytes. Only the first is a delete. The other two produced a tombstone, and a
 * tombstone travels — so a rule added on one machine deleted the file on every
 * other one.
 *
 * The asymmetry is what makes it dangerous: the peer that adds the rule keeps
 * its bytes, because its own walk no longer touches that path. The peer that
 * loses data is the one that does not have the rule yet, which during any
 * staggered rollout is somebody.
 */

/**
 * Reopens a folder with an exclusion rule, which is how a rule arrives in
 * practice. The store caches the file it reads, so every assertion below goes
 * through the node that did the work — two nodes over one adapter do not share
 * that cache.
 */
async function rule(fs: MemoryAdapter, id: string, ignore: (path: string) => boolean): Promise<VFSNode> {
  return VFSNode.open(fs, { id, now: () => tick(), ignore });
}

async function entry(node: VFSNode, path: string): Promise<VFSEntry | undefined> {
  return (await node.entries()).find((item) => item.path === path);
}

describe('absence is not evidence of deletion', () => {
  it('does not delete on the peer without the rule yet — the regression', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'notes.tmp', 'live and tracked');
    await put(a, 'keep.md', 'unrelated');
    await sync(a.node, b.node);
    expect(files(b)['notes.tmp']).toBe('live and tracked');

    // A now applies the rule. B has not received it — that is the normal state
    // while a shared `.vfsignore` propagates.
    const ruled = await rule(a.fs, 'a', (path) => path.endsWith('.tmp'));
    await ruled.commit();
    await sync(ruled, b.node);

    expect(files(b)['notes.tmp']).toBe('live and tracked');
    expect((await entry(b.node, 'notes.tmp'))?.deleted).toBeFalsy();
    expect(files(a)['notes.tmp']).toBe('live and tracked');
  });

  it('keeps the entry live when both peers ignore it', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'notes.tmp', 'tracked before the rule');
    await sync(a.node, b.node);

    const tmp = (path: string) => path.endsWith('.tmp');
    const ruledA = await rule(a.fs, 'a', tmp);
    const ruledB = await rule(b.fs, 'b', tmp);
    await ruledA.commit();
    await ruledB.commit();
    await sync(ruledA, ruledB);

    expect((await entry(ruledA, 'notes.tmp'))?.deleted).toBeFalsy();
    expect((await entry(ruledB, 'notes.tmp'))?.deleted).toBeFalsy();
    // Preserving is the absence of an operation, so it writes no history.
    const rows = await ruledA.store.logRows();
    expect(rows.filter((row) => row.type === 'delete')).toEqual([]);
  });

  it('covers a subtree the walk pruned at the directory', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, '.cache/deep/blob.bin', 'nested');
    await sync(a.node, b.node);

    // The predicate names the directory only. The walk never descends, so the
    // child does not come back either — and testing the leaf alone would read
    // it as vanished.
    const ruled = await rule(a.fs, 'a', (path) => path === '.cache');
    await ruled.commit();
    await sync(ruled, b.node);

    expect(files(b)['.cache/deep/blob.bin']).toBe('nested');
    expect((await entry(b.node, '.cache/deep/blob.bin'))?.deleted).toBeFalsy();
  });

  it('still tombstones a real deletion', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'notes.md', 'hello');
    await sync(a.node, b.node);

    await a.node.delete('notes.md');
    await a.node.commit();
    await sync(a.node, b.node);

    expect(files(b)['notes.md']).toBeUndefined();
    expect((await entry(a.node, 'notes.md'))?.deleted).toBe(true);
    expect((await entry(b.node, 'notes.md'))?.deleted).toBe(true);
  });

  it('leaves an entry whose bytes never landed here alone', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'notes.md', 'hello');
    await sync(a.node, b.node);

    // A peer holding the entry without the content. The mark the scan reads is
    // `mtime`: deleted on every adopt, and only ever re-set from a real stat of
    // the disk, so its absence means "this node has never seen the file".
    const file = await b.node.file();
    file.entries = file.entries.map((item) =>
      item.path === 'notes.md' ? { ...item, mtime: undefined } : item,
    );
    await b.node.store.write(file);
    await b.fs.delete('notes.md');

    await b.node.commit();
    expect((await entry(b.node, 'notes.md'))?.deleted).toBeFalsy();

    // And the mesh does not lose it either.
    await sync(a.node, b.node);
    expect(files(a)['notes.md']).toBe('hello');
  });

  it('does not let a preserved entry steal a rename', async () => {
    const a = await peer('a');
    await put(a, 'notes.tmp', 'same bytes');
    await a.node.commit();
    const before = await entry(a.node, 'notes.tmp');

    // The rule arrives, and the same content appears under a path it does not
    // cover — both seen by one scan. `copy.txt` is a new file, not a move of
    // the preserved entry: a move would carry that entry away from the path it
    // is holding, which is the whole point of holding it.
    const ruled = await rule(a.fs, 'a', (path) => path.endsWith('.tmp'));
    await ruled.write('copy.txt', encoder.encode('same bytes'));
    await ruled.commit();

    const fresh = await entry(ruled, 'copy.txt');
    expect(fresh?.uuid).not.toBe(before?.uuid);
    expect(fresh?.prevPath).toBeUndefined();
    expect((await entry(ruled, 'notes.tmp'))?.deleted).toBeFalsy();
  });

  it('resolves a conflict copy whose bytes never travelled', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'game.bin', 'shared');
    await sync(a.node, b.node);

    await put(a, 'game.bin', 'a re-dump from A');
    await a.node.commit();
    await put(b, 'game.bin', 'a re-dump from B');
    await sync(a.node, b.node, { heldAt: 8 });

    // B keeps its own side. The copy it is dropping is held on A, so there is
    // no file here whose removal a scan could read as the deletion — B has to
    // record it outright.
    const [pending] = await b.node.conflicts();
    await b.node.resolve(pending?.uuid as string, 'mine');
    expect(await b.node.conflicts()).toHaveLength(0);

    await sync(a.node, b.node);
    expect(await a.node.conflicts()).toHaveLength(0);
  });

  it('serves content from any path the peer holds it at, not just the first', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'one.txt', 'duplicated');
    await put(a, 'two.txt', 'duplicated');
    await a.node.commit();

    // A holds the entry for `one.txt` without the bytes. Entries like that used
    // to be tombstoned away before anyone could ask them for content; now they
    // persist, so the lookup has to cope — the same bytes are on disk at
    // `two.txt`, and stopping at the first path A claims to hold them at would
    // leave B without either file.
    const file = await a.node.file();
    file.entries = file.entries.map((item) =>
      item.path === 'one.txt' ? { ...item, mtime: undefined } : item,
    );
    await a.node.store.write(file);
    await a.fs.delete('one.txt');

    await sync(a.node, b.node);
    expect(files(b)['two.txt']).toBe('duplicated');
  });
});

/**
 * A bug the change above uncovered. It has the shape they all had: the engine
 * failed to put something on disk, and the next scan declared the file deleted
 * rather than noticing the failure. The mesh then agreed on the deletion, and
 * the convergence property still held — on having lost the file.
 */
describe('what the false tombstone was hiding', () => {
  it('renames a file out of a directory before removing the directory', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'roms/game.bin', 'a rom');
    await sync(a.node, b.node);

    // `roms` empties out and disappears; the file lands elsewhere. B has to
    // move the file out before it removes the folder, or the recursive delete
    // takes the file with it.
    await a.node.rename('roms/game.bin', 'moved/game.bin');
    await a.node.commit();
    await sync(a.node, b.node);

    expect(files(b)['moved/game.bin']).toBe('a rom');
    expect(files(b)['roms/game.bin']).toBeUndefined();
  });
});
