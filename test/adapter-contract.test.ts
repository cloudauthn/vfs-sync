import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HandleAdapter } from '../src/adapters/handle.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { NodeFsAdapter } from '../src/adapters/node-fs.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import type { VFSAdapter } from '../src/types.js';
import { FakeDirectoryHandle } from './fake-handle.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const temporaries: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vfs-contract-'));
  temporaries.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

/**
 * Every backend has to behave the same way, or the engine's guarantees only
 * hold on whichever one happens to be under test.
 */
const backends: Array<{ name: string; make: () => Promise<VFSAdapter> }> = [
  { name: 'MemoryAdapter', make: async () => new MemoryAdapter('memory') },
  { name: 'NodeFsAdapter', make: async () => NodeFsAdapter.open(await tempDir(), 'node') },
  {
    name: 'HandleAdapter (native move)',
    make: async () => new HandleAdapter(new FakeDirectoryHandle('h') as never, 'handle'),
  },
  {
    name: 'HandleAdapter (copy+delete fallback)',
    make: async () =>
      new HandleAdapter(new FakeDirectoryHandle('h', { supportsMove: false }) as never, 'handle-nomove'),
  },
];

describe.each(backends)('$name', ({ make }) => {
  it('round-trips content', async () => {
    const adapter = await make();
    await adapter.write('notes.md', encoder.encode('hello'));
    expect(decoder.decode(await adapter.read('notes.md'))).toBe('hello');
  });

  it('creates intermediate directories on write', async () => {
    const adapter = await make();
    await adapter.write('a/b/c/deep.txt', encoder.encode('deep'));
    expect(decoder.decode(await adapter.read('a/b/c/deep.txt'))).toBe('deep');
    expect((await adapter.stat('a/b'))?.kind).toBe('directory');
  });

  it('overwrites in place', async () => {
    const adapter = await make();
    await adapter.write('f.txt', encoder.encode('first'));
    await adapter.write('f.txt', encoder.encode('second value'));
    expect(decoder.decode(await adapter.read('f.txt'))).toBe('second value');
    expect((await adapter.stat('f.txt'))?.size).toBe(12);
  });

  it('stats files, directories and the root', async () => {
    const adapter = await make();
    await adapter.write('dir/f.txt', encoder.encode('12345'));

    expect(await adapter.stat('dir/f.txt')).toMatchObject({ kind: 'file', size: 5 });
    expect(typeof (await adapter.stat('dir/f.txt'))?.mtime).toBe('number');
    expect((await adapter.stat('dir'))?.kind).toBe('directory');
    expect((await adapter.stat(''))?.kind).toBe('directory');
  });

  it('returns null when statting something that is not there', async () => {
    const adapter = await make();
    expect(await adapter.stat('nope.txt')).toBeNull();
    expect(await adapter.stat('no/such/dir')).toBeNull();
  });

  it('lists a directory shallowly, tagging kinds', async () => {
    const adapter = await make();
    await adapter.write('top.txt', encoder.encode('x'));
    await adapter.write('sub/inner.txt', encoder.encode('y'));

    const root = (await adapter.list('')).sort((a, b) => a.name.localeCompare(b.name));
    expect(root).toEqual([
      { name: 'sub', path: 'sub', kind: 'directory' },
      { name: 'top.txt', path: 'top.txt', kind: 'file' },
    ]);
    expect(await adapter.list('sub')).toEqual([
      { name: 'inner.txt', path: 'sub/inner.txt', kind: 'file' },
    ]);
  });

  it('lists a missing directory as empty rather than throwing', async () => {
    const adapter = await make();
    expect(await adapter.list('ghost')).toEqual([]);
  });

  it('deletes, and tolerates deleting what is already gone', async () => {
    const adapter = await make();
    await adapter.write('f.txt', encoder.encode('x'));
    await adapter.delete('f.txt');
    expect(await adapter.stat('f.txt')).toBeNull();
    await expect(adapter.delete('f.txt')).resolves.toBeUndefined();
  });

  it('renames, including into a directory that does not exist yet', async () => {
    const adapter = await make();
    await adapter.write('f.txt', encoder.encode('payload'));

    await adapter.rename('f.txt', 'archive/2026/f.txt');
    expect(await adapter.stat('f.txt')).toBeNull();
    expect(decoder.decode(await adapter.read('archive/2026/f.txt'))).toBe('payload');
  });

  it('throws when reading something that is not there', async () => {
    const adapter = await make();
    await expect(adapter.read('nope.txt')).rejects.toThrow();
  });

  it('normalises paths', async () => {
    const adapter = await make();
    await adapter.write('./dir//f.txt', encoder.encode('normalised'));
    expect(decoder.decode(await adapter.read('dir/f.txt'))).toBe('normalised');
  });

  it('drives a full sync as both sides of an edge', async () => {
    const local = await VFSNode.open(await make(), { id: 'local' });
    const remote = await VFSNode.open(new MemoryAdapter('peer'), { id: 'peer' });

    await local.write('notes.md', encoder.encode('from local'));
    await remote.write('todo.md', encoder.encode('from peer'));
    await sync(local, remote);

    expect(decoder.decode(await remote.read('notes.md'))).toBe('from local');
    expect(decoder.decode(await local.read('todo.md'))).toBe('from peer');

    await local.rename('notes.md', 'docs/notes.md');
    await local.delete('todo.md');
    await sync(local, remote);

    expect(decoder.decode(await remote.read('docs/notes.md'))).toBe('from local');
    expect(await remote.adapter.stat('todo.md')).toBeNull();
    expect(await local.head()).toBe(await remote.head());
  });
});

describe('cross-backend sync', () => {
  it('syncs a chain that mixes every backend', async () => {
    const memory = await VFSNode.open(new MemoryAdapter('memory'), { id: 'memory' });
    const disk = await VFSNode.open(await NodeFsAdapter.open(await tempDir(), 'disk'), { id: 'disk' });
    const handle = await VFSNode.open(
      new HandleAdapter(new FakeDirectoryHandle('opfs-like') as never, 'handle'),
      { id: 'handle' },
    );

    await memory.write('a.txt', encoder.encode('A'));
    await disk.write('b.txt', encoder.encode('B'));
    await handle.write('c.txt', encoder.encode('C'));

    // memory <-> disk <-> handle: the ends never talk to each other
    const edges = [
      { a: memory, b: disk },
      { a: disk, b: handle },
    ];
    for (let round = 0; round < 3; round++) for (const edge of edges) await sync(edge.a, edge.b);

    for (const node of [memory, disk, handle]) {
      expect(decoder.decode(await node.read('a.txt'))).toBe('A');
      expect(decoder.decode(await node.read('b.txt'))).toBe('B');
      expect(decoder.decode(await node.read('c.txt'))).toBe('C');
    }
    expect(await memory.head()).toBe(await handle.head());
  });
});
