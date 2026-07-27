import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync, syncUntilStable } from '../src/sync.js';
import type { VFSAdapter } from '../src/types.js';
import { decoder, encoder, peer, put } from './helpers.js';

describe('storeId', () => {
  it('mints one at init and keeps it on reopen', async () => {
    const fs = new MemoryAdapter('a');
    const first = await VFSNode.open(fs);
    const minted = (await first.file()).storeId;
    expect(minted).toBeTruthy();

    const again = await VFSNode.open(fs);
    expect((await again.file()).storeId).toBe(minted);
  });

  it('lives in the header of vfs.json, alongside the peer id', async () => {
    const fs = new MemoryAdapter('fresh');
    const node = await VFSNode.open(fs, { id: 'device-a' });
    const file = await node.file();

    expect(file.peer).toBe('device-a');
    expect(file.storeId).toBeTruthy();
    // v1's config.json is gone; the header carries what it used to.
    expect(await fs.stat('.vfs/config.json')).toBeNull();
    expect(decoder.decode(await fs.read('.vfs/vfs.json'))).toContain('"storeId"');
  });

  it('both sides of a sync adopt the smaller of their two ids', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'x.txt', 'x');
    const smaller = [(await a.node.file()).storeId, (await b.node.file()).storeId].sort().at(0);

    await sync(a.node, b.node);

    expect((await a.node.file()).storeId).toBe(smaller);
    expect((await b.node.file()).storeId).toBe(smaller);
  });

  it('settles on one id across a chain', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    await put(a, 'x.txt', 'x');

    await syncUntilStable([
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ]);

    const ids = await Promise.all([a, b, c].map(async (p) => (await p.node.file()).storeId));
    expect(new Set(ids).size).toBe(1);
  });
});

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
