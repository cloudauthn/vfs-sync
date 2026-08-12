import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import type { VFSAdapter } from '../src/types.js';
import { decoder, encoder, peer } from './helpers.js';

describe('ScopedAdapter', () => {
  it('maps paths into the base and listing paths back out', async () => {
    const base = new MemoryAdapter('base');
    const scoped = new ScopedAdapter(base, 'nested/root');
    await scoped.write('docs/a.md', encoder.encode('hi'));

    expect(decoder.decode(await base.read('nested/root/docs/a.md'))).toBe('hi');
    expect((await scoped.list('docs')).map((entry) => entry.path)).toEqual(['docs/a.md']);
    expect((await scoped.stat('docs/a.md'))?.kind).toBe('file');
  });

  it('only advertises the optional methods its base has', () => {
    const full = new ScopedAdapter(new MemoryAdapter('m'), 'x');
    expect(typeof full.readStream).toBe('function');
    expect(typeof full.mkdir).toBe('function');

    const bare: VFSAdapter = {
      name: 'bare',
      list: async () => [],
      read: async () => new Uint8Array(),
      write: async () => undefined,
      delete: async () => undefined,
      rename: async () => undefined,
      stat: async () => null,
    };
    const scoped = new ScopedAdapter(bare, 'x');
    expect(scoped.readStream).toBeUndefined();
    expect(scoped.mkdir).toBeUndefined();
  });

  it('hosts a vFS store in a subfolder that syncs like any root', async () => {
    const host = new MemoryAdapter('host');
    const inner = await VFSNode.open(new ScopedAdapter(host, 'projects/notes'), { id: 'inner' });
    await inner.write('n.md', encoder.encode('note'));

    const other = await peer('other');
    await sync(inner, other.node);

    expect(other.fs.snapshot()).toEqual({ 'n.md': 'note' });
    expect((await host.stat('projects/notes/.vfs/vfs.json'))?.kind).toBe('file');
    expect(await host.stat('.vfs')).toBeNull();
  });
});

describe('MemoryAdapter.mkdir', () => {
  it('creates empty directories that list, stat and delete', async () => {
    const fs = new MemoryAdapter('m');
    await fs.mkdir('a/b');

    expect((await fs.stat('a'))?.kind).toBe('directory');
    expect((await fs.stat('a/b'))?.kind).toBe('directory');
    expect(await fs.list('')).toEqual([{ name: 'a', path: 'a', kind: 'directory' }]);
    expect(await fs.list('a')).toEqual([{ name: 'b', path: 'a/b', kind: 'directory' }]);

    await fs.delete('a');
    expect(await fs.stat('a')).toBeNull();
    expect(await fs.list('')).toEqual([]);
  });
});
