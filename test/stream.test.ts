import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { NodeFsAdapter } from '../src/adapters/node-fs.js';
import { sha256 } from '../src/hash.js';
import {
  CHUNK_SIZE,
  canStream,
  chunked,
  collect,
  concat,
  pump,
  readRange,
  readStream,
  writeStream,
} from '../src/stream.js';
import { sync } from '../src/sync.js';
import type { VFSAdapter } from '../src/types.js';
import { VFSNode } from '../src/vfs-node.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const temporaries: string[] = [];

afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vfs-stream-'));
  temporaries.push(dir);
  return dir;
}

function payload(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 131 + 17) & 0xff;
  return data;
}

/**
 * An adapter with every optional method stripped — the lowest common
 * denominator a third-party backend can be, used to prove the fallbacks.
 */
function plain(adapter: VFSAdapter): VFSAdapter {
  return {
    name: adapter.name,
    list: (path) => adapter.list(path),
    read: (path) => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    delete: (path) => adapter.delete(path),
    rename: (from, to) => adapter.rename(from, to),
    stat: (path) => adapter.stat(path),
  };
}

/** Streams fine on the way out, fails on the way in. */
function failingWrites(base: VFSAdapter): VFSAdapter {
  const adapter = plain(base);
  adapter.readStream = (path, range) => readStream(base, path, range);
  adapter.writeStream = async () =>
    new WritableStream<Uint8Array>({
      write() {
        throw new Error('disk full');
      },
    });
  return adapter;
}

describe('stream helpers', () => {
  it('reports which adapters can stream natively', () => {
    expect(canStream(new MemoryAdapter('m'))).toBe(true);
    expect(canStream(plain(new MemoryAdapter('m')))).toBe(false);
  });

  it('emulates readRange, readStream and writeStream on a bare adapter', async () => {
    const adapter = plain(new MemoryAdapter('bare'));
    await adapter.write('f.txt', encoder.encode('0123456789'));

    expect(decoder.decode(await readRange(adapter, 'f.txt', { start: 2, end: 5 }))).toBe('234');
    expect(decoder.decode(await collect(await readStream(adapter, 'f.txt')))).toBe('0123456789');

    const target = await writeStream(adapter, 'out.txt');
    const writer = target.getWriter();
    await writer.write(encoder.encode('streamed '));
    await writer.write(encoder.encode('in two'));
    await writer.close();
    expect(decoder.decode(await adapter.read('out.txt'))).toBe('streamed in two');
  });

  it('splits into chunks and puts them back together', async () => {
    const data = payload(CHUNK_SIZE * 2 + 13);
    const chunks: number[] = [];
    const reader = chunked(data).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.byteLength);
    }
    expect(chunks).toEqual([CHUNK_SIZE, CHUNK_SIZE, 13]);
    expect(await sha256(await collect(chunked(data, 1000)))).toBe(await sha256(data));
  });

  it('concatenates zero, one and many chunks', () => {
    expect(concat([])).toHaveLength(0);
    const single = new Uint8Array([1, 2]);
    expect(concat([single])).toBe(single);
    expect([...concat([new Uint8Array([1]), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
  });

  it('reports the chunk count on the way past, and aborts the target on failure', async () => {
    const adapter = new MemoryAdapter('m');
    let seen = 0;
    await pump(chunked(payload(5000), 1000), await writeStream(adapter, 'x.bin'), () => seen++);
    expect(seen).toBe(5);

    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error('source blew up'));
      },
    });
    await expect(pump(failing, await writeStream(adapter, 'y.bin'))).rejects.toThrow('source blew up');
  });
});

describe('streaming through the engine', () => {
  /**
   * `streamThreshold: 1` forces every blob down the streaming path, so the
   * engine's big-file behaviour is exercised without moving megabytes.
   */
  const streaming = { streamThreshold: 1 };

  it('syncs binary payloads byte-exactly with every blob streamed', async () => {
    const a = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const b = await VFSNode.open(await NodeFsAdapter.open(await tempDir(), 'b'), {
      id: 'b',
      ...streaming,
    });

    const data = payload(300_000);
    await a.write('movie.bin', data);
    const result = await sync(a, b);

    expect(result.changed).toBe(true);
    const landed = await b.read('movie.bin');
    expect(landed.byteLength).toBe(data.byteLength);
    expect(await sha256(landed)).toBe(await sha256(data));
  });

  it('gives a streamed blob the same content address as a buffered one', async () => {
    const data = payload(50_000);
    const streamed = await VFSNode.open(new MemoryAdapter('s'), { id: 's', ...streaming });
    const buffered = await VFSNode.open(new MemoryAdapter('b'), { id: 'b' });

    await streamed.write('same.bin', data);
    await buffered.write('same.bin', data);
    await streamed.commit();
    await buffered.commit();

    const [one] = await streamed.live();
    const [two] = await buffered.live();
    expect(one?.hash).toBe(await sha256(data));
    expect(two?.hash).toBe(one?.hash);
  });

  /**
   * v2 has no object store to go missing from: the working file *is* the
   * content. What replaces `putObjectStreamAt`'s address check is an explicit
   * re-hash of everything that lands, and it has to hold on the streaming path
   * too — that is where a truncated transfer actually happens.
   */
  it('rejects a streamed transfer that does not hash to what vfs.json promised', async () => {
    const a = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const b = await VFSNode.open(new MemoryAdapter('b'), { id: 'b', ...streaming });
    await a.write('movie.bin', payload(30_000));
    await a.commit();

    // The source starts fine and then stops short, which is what a dropped
    // connection looks like from the receiving end. `stat` keeps reporting the
    // real size, so A's own mtime+size filter never notices.
    const honest = a.adapter.readStream?.bind(a.adapter);
    a.adapter.readStream = async (path: string) =>
      path === 'movie.bin' ? chunked(payload(29_000)) : (honest as NonNullable<typeof honest>)(path);

    await expect(sync(a, b)).rejects.toThrow(/arrived as/);
    expect(await b.adapter.stat('movie.bin')).toBeNull();
  });

  it('falls back to buffered transfer when a peer cannot stream', async () => {
    const a = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const b = await VFSNode.open(plain(new MemoryAdapter('b')), { id: 'b', ...streaming });

    await a.write('f.bin', payload(10_000));
    await sync(a, b);
    expect(await sha256(await b.read('f.bin'))).toBe(await sha256(await a.read('f.bin')));
  });

  it('leaves nothing behind when the write fails mid-stream', async () => {
    const a = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const b = await VFSNode.open(failingWrites(new MemoryAdapter('b')), { id: 'b', ...streaming });

    await a.write('f.bin', payload(9000));
    await expect(sync(a, b)).rejects.toThrow('disk full');
    expect(await b.adapter.stat('f.bin')).toBeNull();
  });
});
