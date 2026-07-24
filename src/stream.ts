import type { ByteRange, VFSAdapter } from './types.js';

/**
 * Capability-aware wrappers over the optional streaming methods of
 * {@link VFSAdapter}. Every function here works against any adapter: when the
 * backend implements the method it is used directly, otherwise the behaviour is
 * emulated on top of `read()`/`write()`. Callers never branch — they call
 * `readRange(adapter, …)` and get the cheap path where one exists.
 */

/** Chunk size for the emulated paths and for MemoryAdapter. */
export const CHUNK_SIZE = 64 * 1024;

/**
 * Blobs at or above this size take the streaming path through the engine
 * instead of being held whole. Below it, one-shot reads and the native
 * `crypto.subtle` digest are faster, and the memory does not matter.
 */
export const STREAM_THRESHOLD = 4 * 1024 * 1024;

/**
 * True when the adapter can both read and write without materialising a whole
 * file. Emulated streams still work, they just have no memory advantage — so
 * the engine only routes big blobs through streaming when this holds.
 */
export function canStream(adapter: VFSAdapter): boolean {
  return typeof adapter.readStream === 'function' && typeof adapter.writeStream === 'function';
}

/** Reads `[start, end)`. Falls back to reading everything and slicing. */
export async function readRange(
  adapter: VFSAdapter,
  path: string,
  range: ByteRange = {},
): Promise<Uint8Array> {
  if (adapter.readRange) return adapter.readRange(path, range);
  const data = await adapter.read(path);
  return data.slice(range.start ?? 0, range.end ?? data.byteLength);
}

/** Streams a file, or a range of it. Falls back to one chunk per CHUNK_SIZE. */
export async function readStream(
  adapter: VFSAdapter,
  path: string,
  range: ByteRange = {},
): Promise<ReadableStream<Uint8Array>> {
  if (adapter.readStream) return adapter.readStream(path, range);
  return chunked(await readRange(adapter, path, range));
}

/** Writes a file from a stream. Falls back to buffering, then a single write. */
export async function writeStream(
  adapter: VFSAdapter,
  path: string,
): Promise<WritableStream<Uint8Array>> {
  if (adapter.writeStream) return adapter.writeStream(path);
  const chunks: Uint8Array[] = [];
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
    close: async () => {
      await adapter.write(path, concat(chunks));
    },
  });
}

/** A readable over bytes already in hand. */
export function chunked(data: Uint8Array, size = CHUNK_SIZE): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(offset, Math.min(offset + size, data.byteLength)));
      offset += size;
    },
  });
}

/**
 * Drains `source` into `target`, one chunk at a time so neither side ever holds
 * more than a chunk. `onChunk` sees every byte on the way past — that is where
 * the running digest is fed from.
 *
 * `pipeTo()` would do the same, but not on every adapter: a wrapped
 * `FileSystemWritableFileStream` is not always a real WritableStream.
 */
export async function pump(
  source: ReadableStream<Uint8Array>,
  target: WritableStream<Uint8Array>,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = source.getReader();
  const writer = target.getWriter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      onChunk?.(value);
      await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {
      // the write side is already broken; the original error is what matters
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Reads a stream to the end. Only for content known to fit in memory. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
