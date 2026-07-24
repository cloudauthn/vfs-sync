import { isInside, normalizePath } from '../path.js';
import { chunked, concat } from '../stream.js';
import type { ByteRange, VFSAdapter, VFSListEntry, VFSStat } from '../types.js';

export interface MemoryAdapterOptions {
  /**
   * Defaults to a monotonic wall clock: every write gets a strictly greater
   * `mtime` than the last, which keeps ordering unambiguous in tests and demos.
   */
  clock?: () => number;
  /** Initial contents. Values are decoded as UTF-8 when given as strings. */
  files?: Record<string, string | Uint8Array>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** In-memory backend — the reference implementation, and what tests run on. */
export class MemoryAdapter implements VFSAdapter {
  readonly name: string;

  private readonly entries = new Map<string, { data: Uint8Array; mtime: number }>();
  private readonly clock: () => number;
  private last = 0;

  constructor(name = 'memory', options: MemoryAdapterOptions = {}) {
    this.name = name;
    this.clock =
      options.clock ??
      (() => {
        this.last = Math.max(Date.now(), this.last + 1);
        return this.last;
      });
    for (const [path, value] of Object.entries(options.files ?? {})) {
      this.entries.set(normalizePath(path), {
        data: typeof value === 'string' ? encoder.encode(value) : value,
        mtime: this.clock(),
      });
    }
  }

  async list(path: string): Promise<VFSListEntry[]> {
    const dir = normalizePath(path);
    const seen = new Map<string, VFSListEntry>();
    for (const key of this.entries.keys()) {
      if (!isInside(key, dir) || key === dir) continue;
      const rest = dir ? key.slice(dir.length + 1) : key;
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const child = dir ? `${dir}/${name}` : name;
      if (!seen.has(child)) {
        seen.set(child, { name, path: child, kind: slash === -1 ? 'file' : 'directory' });
      }
    }
    return [...seen.values()];
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) throw new Error(`ENOENT: ${path}`);
    return entry.data.slice();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.entries.set(normalizePath(path), { data: data.slice(), mtime: this.clock() });
  }

  async delete(path: string): Promise<void> {
    const target = normalizePath(path);
    for (const key of [...this.entries.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) this.entries.delete(key);
    }
  }

  // Streaming here can never save memory — the file *is* memory. It exists so
  // that the engine's streaming paths are exercised by the adapter the tests
  // run on, and so range reads stay cheap.

  async readRange(path: string, range: ByteRange = {}): Promise<Uint8Array> {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) throw new Error(`ENOENT: ${path}`);
    return entry.data.slice(range.start ?? 0, range.end ?? entry.data.byteLength);
  }

  async readStream(path: string, range: ByteRange = {}): Promise<ReadableStream<Uint8Array>> {
    return chunked(await this.readRange(path, range));
  }

  async writeStream(path: string): Promise<WritableStream<Uint8Array>> {
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        chunks.push(chunk.slice());
      },
      close: async () => {
        await this.write(path, concat(chunks));
      },
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    const entry = this.entries.get(from);
    if (entry) {
      this.entries.delete(from);
      this.entries.set(to, entry);
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(`${from}/`)) continue;
      const moved = this.entries.get(key) as { data: Uint8Array; mtime: number };
      this.entries.delete(key);
      this.entries.set(`${to}${key.slice(from.length)}`, moved);
    }
  }

  async stat(path: string): Promise<VFSStat | null> {
    const target = normalizePath(path);
    const entry = this.entries.get(target);
    if (entry) return { kind: 'file', size: entry.data.byteLength, mtime: entry.mtime };
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${target}/`)) return { kind: 'directory', size: 0, mtime: 0 };
    }
    return target === '' ? { kind: 'directory', size: 0, mtime: 0 } : null;
  }

  // ------------------------------------------------------------- test aids

  /** Forces an `mtime`, to script clock skew or simultaneous edits. */
  setMtime(path: string, mtime: number): void {
    const entry = this.entries.get(normalizePath(path));
    if (entry) entry.mtime = mtime;
  }

  /** Working-folder contents as text, control folder excluded. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, entry] of this.entries) {
      if (path === '.vfs' || path.startsWith('.vfs/')) continue;
      out[path] = decoder.decode(entry.data);
    }
    return out;
  }
}
