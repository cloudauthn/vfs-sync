import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { files, get, peer, put, tick } from './helpers.js';

describe('scan', () => {
  it('records every file and skips the control folder', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await put(a, 'docs/readme.md', 'world');

    const tree = await a.node.scan();
    expect(tree.entries.map((e) => e.path).sort()).toEqual(['docs/readme.md', 'notes.md']);
    expect(tree.entries.some((e) => e.path.startsWith('.vfs'))).toBe(false);
  });

  it('commits once and then reports no change', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');

    expect(await a.node.commit()).toBeTypeOf('string');
    expect(await a.node.commit()).toBeNull();
  });

  it('keeps file ids stable across edits', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'v1');
    const first = (await a.node.scan()).entries[0];
    await a.node.commit();

    await put(a, 'notes.md', 'v2');
    const second = (await a.node.scan()).entries[0];

    expect(second?.id).toBe(first?.id);
    expect(second?.hash).not.toBe(first?.hash);
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
    await node.write('notes.md', new TextEncoder().encode('hello'));
    await node.commit();
    const afterFirst = reads;

    await node.scan();
    expect(reads).toBe(afterFirst); // fast filter hit, content never re-read
  });

  it('writes a tombstone when a file disappears', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();

    await a.node.delete('notes.md');
    const tree = await a.node.scan();

    const entry = tree.entries.find((e) => e.path === 'notes.md');
    expect(entry?.deleted).toBe(true);
    expect(entry?.hash).toBeNull();
  });

  it('keeps historical tombstones so a fresh peer learns about the delete', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    await a.node.commit();
    await a.node.delete('notes.md');
    await a.node.commit();

    await put(a, 'other.md', 'x');
    const tree = await a.node.scan();

    expect(tree.entries.find((e) => e.path === 'notes.md')?.deleted).toBe(true);
  });

  it('carries the id through an explicit rename', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    const before = (await a.node.scan()).entries[0];
    await a.node.commit();

    await a.node.rename('notes.md', 'docs/notes.md');
    const tree = await a.node.scan();

    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.id).toBe(before?.id);
    expect(tree.entries[0]?.path).toBe('docs/notes.md');
    expect(tree.entries[0]?.renamedFrom).toBe('notes.md');
  });

  it('falls back to the hash heuristic for renames done outside the VFS', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    const before = (await a.node.scan()).entries[0];
    await a.node.commit();

    // straight to the adapter: no rename intent recorded
    await a.fs.rename('notes.md', 'moved.md');
    const tree = await a.node.scan();

    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.id).toBe(before?.id);
    expect(tree.entries[0]?.renamedFrom).toBe('notes.md');
  });

  it('carries the logical mtime of unchanged content forward', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    a.fs.setMtime('notes.md', 1234);
    const first = (await a.node.scan()).entries[0];
    await a.node.commit();

    expect(first?.mtime).toBe(1234);

    // a no-op rewrite of identical bytes bumps the filesystem mtime, but the
    // logical mtime must not move — nothing actually changed
    await put(a, 'notes.md', 'hello');
    a.fs.setMtime('notes.md', 9999);
    const second = (await a.node.scan()).entries[0];

    expect(second?.hash).toBe(first?.hash);
    expect(second?.mtime).toBe(1234);
  });

  it('round-trips content through the object store', async () => {
    const a = await peer('a');
    await put(a, 'notes.md', 'hello');
    const tree = await a.node.scan();
    const hash = tree.entries[0]?.hash as string;

    expect(new TextDecoder().decode(await a.node.store.getObject(hash))).toBe('hello');
    expect(await get(a, 'notes.md')).toBe('hello');
    expect(files(a)).toEqual({ 'notes.md': 'hello' });
    expect(tick()).toBeGreaterThan(0);
  });
});
