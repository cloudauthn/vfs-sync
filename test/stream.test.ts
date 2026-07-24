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

    const [one] = (await streamed.headTree()).entries;
    const [two] = (await buffered.headTree()).entries;
    expect(one?.hash).toBe(await sha256(data));
    expect(two?.hash).toBe(one?.hash);
  });

  it('re-streams a blob that went missing from the object store', async () => {
    const adapter = new MemoryAdapter('a');
    const node = await VFSNode.open(adapter, { id: 'a', ...streaming });
    const data = payload(20_000);
    await node.write('f.bin', data);
    await node.commit();

    // Same mtime and size, so the next scan takes the cached-hash branch and
    // has to notice the object is gone and put it back.
    const hash = (await node.headTree()).entries[0]?.hash as string;
    await adapter.delete(`.vfs/objects/${hash.slice(0, 2)}/${hash}`);
    expect(await node.store.hasObject(hash)).toBe(false);

    await node.scan();
    expect(await node.store.hasObject(hash)).toBe(true);
    expect(await sha256(await collect(await node.store.getObjectStream(hash)))).toBe(hash);
  });

  it('falls back to buffered transfer when a peer cannot stream', async () => {
    const a = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const b = await VFSNode.open(plain(new MemoryAdapter('b')), { id: 'b', ...streaming });

    await a.write('f.bin', payload(10_000));
    await sync(a, b);
    expect(await sha256(await b.read('f.bin'))).toBe(await sha256(await a.read('f.bin')));
  });

  it('reads a range straight off a node, without loading the file', async () => {
    const node = await VFSNode.open(new MemoryAdapter('a'), { id: 'a' });
    // an ID3v2 header, filler, then an ID3v1 trailer
    const track = concat([encoder.encode('ID3\x04\x00'), payload(4000), encoder.encode('TAGtitle')]);
    await node.write('track.mp3', track);

    expect(decoder.decode(await node.readRange('track.mp3', { end: 3 }))).toBe('ID3');
    const size = (await node.stat('track.mp3'))?.size as number;
    expect(decoder.decode(await node.readRange('track.mp3', { start: size - 8 }))).toBe('TAGtitle');

    // and the same range as a stream
    const head = await collect(await node.readStream('track.mp3', { end: 3 }));
    expect(decoder.decode(head)).toBe('ID3');
    expect(await sha256(await collect(await node.readStream('track.mp3')))).toBe(await sha256(track));
  });

  it('writes a file through a stream and commits it', async () => {
    const node = await VFSNode.open(new MemoryAdapter('a'), { id: 'a', ...streaming });
    const writer = (await node.writeStream('generated.bin')).getWriter();
    for (let i = 0; i < 4; i++) await writer.write(payload(1000));
    await writer.close();

    await node.commit();
    const entry = (await node.headTree()).entries[0];
    expect(entry?.size).toBe(4000);
    expect(entry?.hash).toBe(await sha256(await node.read('generated.bin')));
  });
});

describe('object store integrity', () => {
  it('rejects a stream that does not hash to the promised address', async () => {
    const adapter = new MemoryAdapter('a');
    const node = await VFSNode.open(adapter, { id: 'a' });
    const lie = await sha256(encoder.encode('what was promised'));

    await expect(
      node.store.putObjectStreamAt(lie, chunked(encoder.encode('what actually arrived'))),
    ).rejects.toThrow(/arrived as/);

    // and it does not leave the bad bytes behind under a good name
    expect(await node.store.hasObject(lie)).toBe(false);
  });

  it('skips a blob it already has, and drains the source', async () => {
    const node = await VFSNode.open(new MemoryAdapter('a'), { id: 'a' });
    const data = encoder.encode('already here');
    const hash = await node.store.putObject(data);

    await node.store.putObjectStreamAt(hash, chunked(data));
    expect(await node.store.objectSize(hash)).toBe(data.byteLength);
  });

  it('leaves nothing behind when the write fails mid-stream', async () => {
    const node = await VFSNode.open(failingWrites(new MemoryAdapter('a')), { id: 'a' });
    const data = payload(9000);
    const hash = await sha256(data);

    await expect(node.store.putObjectStreamAt(hash, chunked(data))).rejects.toThrow('disk full');
    expect(await node.store.hasObject(hash)).toBe(false);
  });

  it('reports the size of a blob it does not have as zero', async () => {
    const node = await VFSNode.open(new MemoryAdapter('a'), { id: 'a' });
    expect(await node.store.objectSize('0'.repeat(64))).toBe(0);
    await expect(node.store.getObjectStream('0'.repeat(64))).rejects.toThrow(/missing object/);
  });
});
