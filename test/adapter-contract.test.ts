import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HandleAdapter } from '../src/adapters/handle.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { NodeFsAdapter } from '../src/adapters/node-fs.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { makeFakeDrive } from './fake-drive.js';
import { VFSNode } from '../src/vfs-node.js';
import { sha256 } from '../src/hash.js';
import { collect, readRange, readStream, writeStream } from '../src/stream.js';
import { sync } from '../src/sync.js';
import type { VFSAdapter, VFSListEntry } from '../src/types.js';
import { FakeDirectoryHandle } from './fake-handle.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const temporaries: string[] = [];

/** The required part of a listing — `stat` is optional per backend. */
function named(entries: VFSListEntry[]): Array<Omit<VFSListEntry, 'stat'>> {
  return entries.map(({ name, path, kind }) => ({ name, path, kind }));
}

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
  {
    name: 'ScopedAdapter (memory base)',
    make: async () => new ScopedAdapter(new MemoryAdapter('base'), 'scope/root'),
  },
  {
    name: 'GDriveAdapter (fake Drive)',
    make: async () => new GDriveAdapter({ token: 'test-token', fetch: makeFakeDrive().fetch }),
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
    expect(named(root)).toEqual([
      { name: 'sub', path: 'sub', kind: 'directory' },
      { name: 'top.txt', path: 'top.txt', kind: 'file' },
    ]);
    expect(named(await adapter.list('sub'))).toEqual([
      { name: 'inner.txt', path: 'sub/inner.txt', kind: 'file' },
    ]);
  });

  it('a listed stat, where the backend gets one for free, agrees with stat()', async () => {
    const adapter = await make();
    await adapter.write('top.txt', encoder.encode('12345'));
    await adapter.write('sub/inner.txt', encoder.encode('y'));

    const entries = [...(await adapter.list('')), ...(await adapter.list('sub'))];
    expect(entries.length).toBe(3);
    for (const entry of entries) {
      // Optional by design: a backend whose listing does not carry sizes and
      // times omits it, and the consumer stats. Carrying a wrong one is the bug.
      if (!entry.stat) continue;
      expect(entry.stat).toEqual(await adapter.stat(entry.path));
    }
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

  // ------------------------------------------------------------- streaming
  //
  // Every backend has to answer these the same way whether it implements the
  // streaming methods natively or gets them emulated by stream.ts.

  it('round-trips binary content that is not valid UTF-8', async () => {
    const adapter = await make();
    // a lone 0xff, an unpaired surrogate's bytes, and every byte value
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = 255 - i;
    await adapter.write('blob.bin', bytes);
    expect([...(await adapter.read('blob.bin'))]).toEqual([...bytes]);
    expect((await adapter.stat('blob.bin'))?.size).toBe(256);
  });

  it('reads a byte range without touching the rest', async () => {
    const adapter = await make();
    await adapter.write('track.mp3', encoder.encode('ID3xxxxxxxxxxTAGtrailer'));

    expect(decoder.decode(await readRange(adapter, 'track.mp3', { end: 3 }))).toBe('ID3');
    expect(decoder.decode(await readRange(adapter, 'track.mp3', { start: 13, end: 16 }))).toBe('TAG');
    expect(decoder.decode(await readRange(adapter, 'track.mp3', { start: 16 }))).toBe('trailer');
    expect(decoder.decode(await readRange(adapter, 'track.mp3'))).toBe('ID3xxxxxxxxxxTAGtrailer');
  });

  it('clamps ranges that run past either end', async () => {
    const adapter = await make();
    await adapter.write('short.txt', encoder.encode('abc'));
    expect(decoder.decode(await readRange(adapter, 'short.txt', { start: 1, end: 99 }))).toBe('bc');
    expect(await readRange(adapter, 'short.txt', { start: 99 })).toHaveLength(0);
    expect(await readRange(adapter, 'short.txt', { start: 2, end: 2 })).toHaveLength(0);
  });

  it('streams a file in and out, in chunks, byte-exact', async () => {
    const adapter = await make();
    // larger than CHUNK_SIZE so the emulated and native paths both split it
    const source = new Uint8Array(200_000);
    for (let i = 0; i < source.length; i++) source[i] = (i * 7) & 0xff;

    const target = await writeStream(adapter, 'big.bin');
    const writer = target.getWriter();
    for (let offset = 0; offset < source.length; offset += 8192) {
      await writer.write(source.subarray(offset, offset + 8192));
    }
    await writer.close();

    expect((await adapter.stat('big.bin'))?.size).toBe(source.length);
    const read = await collect(await readStream(adapter, 'big.bin'));
    expect(read.byteLength).toBe(source.length);
    expect(await sha256(read)).toBe(await sha256(source));
  });

  it('streams a range', async () => {
    const adapter = await make();
    await adapter.write('ranged.txt', encoder.encode('0123456789'));
    expect(decoder.decode(await collect(await readStream(adapter, 'ranged.txt', { start: 2, end: 5 })))).toBe(
      '234',
    );
    expect(await collect(await readStream(adapter, 'ranged.txt', { start: 4, end: 4 }))).toHaveLength(0);
  });

  it('survives an aborted write stream', async () => {
    const adapter = await make();
    const target = await writeStream(adapter, 'aborted.bin');
    const writer = target.getWriter();
    await writer.write(encoder.encode('partial'));
    // What an abort leaves on disk is backend-specific — a buffered backend
    // keeps the old bytes, one that opened the file has already truncated it.
    // What has to hold everywhere is that it does not throw and does not wedge
    // the adapter.
    await expect(writer.abort(new Error('cancelled'))).resolves.toBeUndefined();

    await adapter.write('after.txt', encoder.encode('still working'));
    expect(decoder.decode(await adapter.read('after.txt'))).toBe('still working');
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
