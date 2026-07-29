import { describe, expect, it } from 'vitest';
import { sync, syncDryRun, syncUntilStable } from '../src/sync.js';
import { entryAt, files, get, peer, put } from './helpers.js';

describe('sync', () => {
  it('copies files both ways on a first encounter', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'from-a.md', 'A');
    await put(b, 'from-b.md', 'B');

    const result = await sync(a.node, b.node);

    expect(result.changed).toBe(true);
    expect(files(a)).toEqual({ 'from-a.md': 'A', 'from-b.md': 'B' });
    expect(files(b)).toEqual(files(a));
    expect(await a.node.state()).toBe(await b.node.state());
  });

  it('is a no-op when nothing changed', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello');

    await sync(a.node, b.node);
    expect((await sync(a.node, b.node)).changed).toBe(false);
  });

  /**
   * The point of the header-first layout: a quiet edge is one range read per
   * peer, and `entries` — which can run to megabytes — is never touched.
   */
  it('settles a quiet edge on the digests alone', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello');
    await sync(a.node, b.node);

    const before = await a.node.file();
    const second = await sync(a.node, b.node);

    expect(second.changed).toBe(false);
    expect(second.transferred).toEqual({ toA: 0, toB: 0 });
    expect(before.state).toBe((await b.node.file()).state);
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
    expect(result.transferred).toEqual({ toA: 0, toB: 0 }); // the bytes never moved
  });

  it('syncs an empty folder, which v1 silently dropped', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await a.node.mkdir('roms/megadrive');

    await sync(a.node, b.node);

    expect(await b.node.stat('roms/megadrive')).toMatchObject({ kind: 'directory' });
    expect((await b.node.live()).map((entry) => entry.path).sort()).toEqual([
      'roms',
      'roms/megadrive',
    ]);
  });

  it('resolves a real conflict by updated and keeps a copy of the loser', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.bin', 'shared');
    await sync(a.node, b.node);

    await put(a, 'notes.bin', 'from A');
    await a.node.commit(); // A records first, so B's version is the newer one
    await put(b, 'notes.bin', 'from B');

    const result = await sync(a.node, b.node);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe('b');
    expect(await get(a, 'notes.bin')).toBe('from B');

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

    const uuidsA = (await a.node.live()).map((entry) => entry.uuid);
    const uuidsB = (await b.node.live()).map((entry) => entry.uuid);
    expect(uuidsA).toEqual(uuidsB);
    expect(uuidsA).toHaveLength(1);
  });

  it('converges after repeated syncs', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');

    await sync(a.node, b.node);
    await sync(a.node, b.node);
    expect((await sync(a.node, b.node)).changed).toBe(false);
  });

  it('re-hashes what arrives, so a corrupted transfer cannot land as the newest version', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'the real thing');
    await a.node.commit(); // A's mirror is honest; only the wire will not be

    // Now the source lies about its bytes, which is what a truncated upload
    // looks like from the receiving end. `stat` still reports the real size, so
    // the mtime+size filter keeps A's own scan from noticing.
    const honest = a.fs.read.bind(a.fs);
    a.fs.read = async (path: string) =>
      path === 'notes.md' ? new TextEncoder().encode('truncat') : honest(path);

    await expect(sync(a.node, b.node)).rejects.toThrow(/arrived as/);
    a.fs.read = honest;
  });

  it('converges the store id and the text list on both peers', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const fileB = await b.node.file();
    fileB.text = [...fileB.text, 'gamelist'];
    await b.node.store.write(fileB);

    await sync(a.node, b.node);

    expect((await a.node.file()).storeId).toBe((await b.node.file()).storeId);
    expect((await a.node.file()).text).toContain('gamelist');
  });

  it('records how far it got with each peer', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');
    await sync(a.node, b.node);

    const mark = (await a.node.file()).peers['device-b'];
    expect(mark?.lastSync).toBeGreaterThan(0);
    expect(mark?.segment).toBe((await b.node.file()).log.segment);
    expect(mark?.digest).toBe((await b.node.file()).log.digest);
  });

  it('previews changes without writing anything', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello from A');

    const dry = await syncDryRun(a.node, b.node);

    expect(dry.changed).toBe(true);
    expect(dry.actions.toA).toEqual([]);
    expect(dry.actions.toB).toHaveLength(1);
    expect(dry.actions.toB[0]?.type).toBe('write');
    expect(dry.actions.toB[0]?.kind).toBe('file');
    expect(dry.actions.toB[0]?.path).toBe('notes.md');
    expect(files(b)).toEqual({});

    await sync(a.node, b.node);
    expect(files(b)).toEqual({ 'notes.md': 'hello from A' });
  });

  it('matches sync transfer counts on a simple preview', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'from-a.md', 'A');
    await put(b, 'from-b.md', 'B');

    const dry = await syncDryRun(a.node, b.node);
    const applied = await sync(a.node, b.node);

    expect(dry.transferred).toEqual(applied.transferred);
    expect(dry.conflicts).toHaveLength(applied.conflicts.length);
    expect(dry.merged).toBe(applied.merged);
  });

  it('can veto the merge before writes with approveMerge', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello from A');

    let called = 0;
    const result = await sync(a.node, b.node, {
      approveMerge: async (preview) => {
        called++;
        expect(preview.changed).toBe(true);
        expect(preview.actions.toB.some((action) => action.path === 'notes.md')).toBe(true);
        return false;
      },
    });

    expect(called).toBe(1);
    expect(result.approved).toBe(false);
    expect(files(b)).toEqual({});
  });

});

describe('the pruned tombstone', () => {
  /**
   * The one place where the log is not an optimisation but correctness. C has
   * been offline since before the delete; A has already pruned the tombstone
   * out of `vfs.json`. Only the log (or the cumulative snapshot behind it) can
   * prove the file is gone rather than new.
   */
  it('is still a delete once the log has to answer for it', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');

    await put(a, 'notes.md', 'v1');
    await syncUntilStable([
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ]);
    expect(files(c)).toEqual({ 'notes.md': 'v1' });

    // C goes offline. A deletes, and A and B agree on it.
    await a.node.delete('notes.md');
    await sync(a.node, b.node);

    // Prune the tombstone out of A's mirror — the log still carries the row.
    const file = await a.node.file();
    file.entries = file.entries.filter((entry) => !entry.deleted);
    await a.node.store.write(file);
    expect((await a.node.file()).entries).toHaveLength(0);

    // C comes back with the file still alive.
    await sync(a.node, c.node);
    expect(files(c)).toEqual({});
  });

  it('survives the rotation that made the pruning safe', async () => {
    const a = await peer('device-a', { rotateAt: 200 });
    const c = await peer('device-c', { rotateAt: 200 });

    await put(a, 'notes.md', 'v1');
    await sync(a.node, c.node);

    await a.node.delete('notes.md');
    await a.node.commit();
    // Rotate past the segment that holds the delete, then prune the tombstone:
    // only the cumulative snapshot is left to prove it.
    for (let i = 0; i < 8; i++) {
      await put(a, `filler-${i}.txt`, `x${i}`);
      await a.node.commit();
    }
    const file = await a.node.file();
    expect(file.log.snapshot).toBeTypeOf('string');
    file.entries = file.entries.filter((entry) => !entry.deleted);
    await a.node.store.write(file);
    a.node.store.invalidate();

    await sync(a.node, c.node);
    expect(files(c)['notes.md']).toBeUndefined();
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
    expect(await a.node.state()).toBe(await c.node.state());
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

    await put(a, 'notes.bin', 'base');
    await syncUntilStable(edges);

    await put(a, 'notes.bin', 'edited on A');
    await a.node.commit();
    await put(c, 'notes.bin', 'edited on C');
    await c.node.commit();

    await syncUntilStable(edges);

    expect(await get(a, 'notes.bin')).toBe('edited on C');
    expect(files(a)).toEqual(files(b));
    expect(files(b)).toEqual(files(c));

    // The conflict surfaces on the B<->C edge, where B is only relaying A's
    // edit — the copy still has to be credited to whoever wrote it.
    const copies = Object.keys(files(a)).filter((path) => path.includes('conflict'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^notes \(conflict device-a [0-9a-f]{8}\)\.bin$/);
    expect(files(a)[copies[0] as string]).toBe('edited on A');
  });

  it('does not re-raise a settled conflict on the next pass', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');
    const edges = [
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ];

    await put(a, 'notes.bin', 'base');
    await syncUntilStable(edges);
    await put(a, 'notes.bin', 'from A');
    await a.node.commit();
    await put(c, 'notes.bin', 'from C');
    await syncUntilStable(edges);

    const again = await syncUntilStable(edges, { maxRounds: 3 });
    expect(again.flat().flatMap((item) => item.result.conflicts)).toHaveLength(0);
  });

  it('follows a rename chain a lagging peer never saw', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'v1');
    await sync(a.node, b.node);

    // B goes quiet while A moves the file twice.
    await a.node.rename('notes.md', 'one/notes.md');
    await a.node.commit();
    await a.node.rename('one/notes.md', 'two/notes.md');
    const result = await sync(a.node, b.node);

    expect(files(b)).toEqual({ 'two/notes.md': 'v1' });
    expect(result.conflicts).toHaveLength(0);
    expect((await entryAt(b, 'two/notes.md'))?.prevPath).toBe('one/notes.md');
  });
});

describe('degenerate syncs', () => {
  it('does nothing when both peers are empty', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');

    // The first pass still converges the two store ids, which is a real change;
    // there is nothing left to do after that.
    const result = await sync(a.node, b.node);
    expect(result).toMatchObject({ conflicts: [], transferred: { toA: 0, toB: 0 } });
    expect(await a.node.live()).toEqual([]);
    expect((await sync(a.node, b.node)).changed).toBe(false);
  });

  it('syncs a peer with itself as a no-op', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'v1');

    const result = await sync(a.node, a.node);
    expect(result.conflicts).toHaveLength(0);
    expect(await get(a, 'notes.md')).toBe('v1');
  });

  it('reports content transfers in the direction they happened', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'one.txt', 'A1');
    await put(a, 'two.txt', 'A2');

    expect((await sync(a.node, b.node)).transferred).toEqual({ toA: 0, toB: 2 });
  });
});
