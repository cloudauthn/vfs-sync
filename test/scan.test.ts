import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { encoder, entryAt, files, get, peer, put } from './helpers.js';

describe('scan', () => {
  it('records every file and skips the control folder', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await put(a, 'docs/readme.md', 'world');

    const { entries } = await a.node.scan();
    const paths = entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(['docs', 'docs/readme.md', 'notes.md']);
    expect(entries.some((entry) => entry.path.startsWith('.vfs'))).toBe(false);
  });

  it('records directories, so an empty folder is a real entry', async () => {
    const a = await peer('a');
    await a.node.mkdir('roms/megadrive');

    const { entries } = await a.node.scan();
    expect(entries.map((entry) => [entry.path, entry.kind]).sort()).toEqual([
      ['roms', 'directory'],
      ['roms/megadrive', 'directory'],
    ]);
  });

  it('commits once and then reports no change', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');

    expect(await a.node.commit()).toBeTypeOf('string');
    expect(await a.node.commit()).toBeNull();
  });

  it('keeps uuids stable across edits', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'v1');
    await a.node.commit();
    const first = await entryAt(a, 'notes.md');

    await put(a, 'notes.md', 'v2');
    await a.node.commit();
    const second = await entryAt(a, 'notes.md');

    expect(second?.uuid).toBe(first?.uuid);
    expect(second?.hash).not.toBe(first?.hash);
    expect(second?.prev).toBe(first?.hash); // one step of history, inline
  });

  it('does not re-read files whose mtime and size are unchanged', async () => {
    const adapter = new MemoryAdapter('counting');
    let reads = 0;
    const original = adapter.read.bind(adapter);
    adapter.read = async (path: string) => {
      if (!path.startsWith('.vfs')) reads++;
      return original(path);
    };

    const node = await VFSNode.open(adapter, { id: 'counting' });
    await node.write('notes.bin', encoder.encode('hello'));
    await node.commit();
    const afterFirst = reads;

    await node.scan();
    expect(reads).toBe(afterFirst); // fast filter hit, content never re-read
  });

  it('writes a tombstone when a file disappears', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    const before = await entryAt(a, 'notes.md');

    await a.node.delete('notes.md');
    const { entries, rows } = await a.node.scan();

    const entry = entries.find((item) => item.path === 'notes.md');
    expect(entry?.deleted).toBe(true);
    expect(entry?.hash).toBeNull();
    expect(entry?.prev).toBe(before?.hash);
    expect(rows.map((row) => row.type)).toContain('delete');
  });

  it('keeps historical tombstones so a fresh peer learns about the delete', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    await a.node.delete('notes.md');
    await a.node.commit();

    await put(a, 'other.md', 'x');
    const { entries } = await a.node.scan();
    expect(entries.find((item) => item.path === 'notes.md')?.deleted).toBe(true);
  });

  it('carries the uuid through an explicit rename', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    const before = await entryAt(a, 'notes.md');

    await a.node.rename('notes.md', 'docs/notes.md');
    const { entries, rows } = await a.node.scan();

    const moved = entries.find((item) => item.path === 'docs/notes.md');
    expect(moved?.uuid).toBe(before?.uuid);
    expect(moved?.prevPath).toBe('notes.md');
    expect(rows.find((row) => row.uuid === before?.uuid)?.type).toBe('rename');
  });

  it('falls back to the hash heuristic for renames done outside the VFS', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    const before = await entryAt(a, 'notes.md');

    // straight to the adapter: no rename intent recorded
    await a.fs.rename('notes.md', 'moved.md');
    const { entries } = await a.node.scan();

    const moved = entries.find((item) => item.path === 'moved.md');
    expect(moved?.uuid).toBe(before?.uuid);
    expect(moved?.prevPath).toBe('notes.md');
  });

  /**
   * `updated` is a hybrid logical clock, not the disk mtime: it only moves when
   * something actually happened, so a peer's edit time survives the trip.
   */
  it('leaves updated alone when nothing changed', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    const first = await entryAt(a, 'notes.md');

    // A no-op rewrite of identical bytes bumps the filesystem mtime; the
    // logical date must not move, because nothing changed.
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    const second = await entryAt(a, 'notes.md');

    expect(second?.hash).toBe(first?.hash);
    expect(second?.updated).toBe(first?.updated);
  });

  it('never goes backwards, even against a clock that does', async () => {
    const fs = new MemoryAdapter('slow');
    let now = 5000;
    const node = await VFSNode.open(fs, { id: 'slow', now: () => now });
    await node.write('a.txt', encoder.encode('one'));
    await node.commit();
    const first = (await node.live())[0]?.updated as number;

    now = 10; // the clock ran backwards between writes
    await node.write('a.txt', encoder.encode('two'));
    await node.commit();

    expect((await node.live())[0]?.updated).toBeGreaterThan(first);
  });

  it('keeps the working file as the content, with no object store behind it', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();

    expect(await get(a, 'notes.md')).toBe('hello');
    expect(files(a)).toEqual({ 'notes.md': 'hello' });
    expect(await a.fs.stat('.vfs/objects')).toBeNull();
    expect(Object.keys(await a.fs.list('.vfs')).length).toBeGreaterThan(0);
  });

  it('lays down exactly two control files on the normal path', async () => {
    const a = await peer('a');
    await put(a, 'notes.bin', 'hello');
    await a.node.commit();

    const names = (await a.fs.list('.vfs')).map((entry) => entry.name).sort();
    expect(names).toEqual(['commits', 'vfs.json']);
  });
});
