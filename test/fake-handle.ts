/**
 * Minimal in-memory stand-in for `FileSystemDirectoryHandle`, covering the
 * subset of the API that `HandleAdapter` uses.
 *
 * This exercises the adapter's logic — path resolution, the `move()` fallback,
 * the stat probe order — in Node. It is *not* a substitute for running against
 * real OPFS: it cannot catch browser quirks, only regressions in our own code.
 */

class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class FakeFileHandle {
  readonly kind = 'file';
  name: string;
  data: Uint8Array;
  lastModified: number;
  parent: FakeDirectoryHandle;
  /** Present only when the fake is configured to support native moves. */
  move?: (parent: FakeDirectoryHandle, name: string) => Promise<void>;

  constructor(name: string, parent: FakeDirectoryHandle, clock: () => number, supportsMove: boolean) {
    this.name = name;
    this.parent = parent;
    this.data = new Uint8Array();
    this.lastModified = clock();
    if (supportsMove) this.move = (target, to) => fileMove(this, target, to);
  }

  async getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    const data = this.data;
    return {
      size: data.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    };
  }

  async createWritable(): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (chunk: Uint8Array) => {
        chunks.push(chunk.slice());
      },
      close: async () => {
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const merged = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.data = merged;
        this.lastModified = this.parent.clock();
      },
    };
  }
}

export interface FakeDirectoryOptions {
  /** Chrome ships `FileSystemFileHandle.move()`; Safari does not. */
  supportsMove?: boolean;
  clock?: () => number;
}

export class FakeDirectoryHandle {
  readonly kind = 'directory';
  name: string;
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  readonly clock: () => number;
  readonly supportsMove: boolean;

  constructor(name = '', options: FakeDirectoryOptions = {}) {
    this.name = name;
    this.supportsMove = options.supportsMove ?? true;
    let last = 0;
    this.clock = options.clock ?? (() => (last = Math.max(Date.now(), last + 1)));
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing;
    if (existing) throw new TypeError(`${name} is a file`);
    if (!options.create) throw new NotFoundError(name);
    const created = new FakeDirectoryHandle(name, {
      supportsMove: this.supportsMove,
      clock: this.clock,
    });
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) return existing;
    if (existing) throw new TypeError(`${name} is a directory`);
    if (!options.create) throw new NotFoundError(name);
    const created = new FakeFileHandle(name, this, this.clock, this.supportsMove);
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string, _options: { recursive?: boolean } = {}): Promise<void> {
    if (!this.children.has(name)) throw new NotFoundError(name);
    this.children.delete(name);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<
    [string, FakeDirectoryHandle | FakeFileHandle]
  > {
    for (const entry of [...this.children.entries()]) yield entry;
  }
}

async function fileMove(
  file: FakeFileHandle,
  parent: FakeDirectoryHandle,
  name: string,
): Promise<void> {
  file.parent.children.delete(file.name);
  file.name = name;
  file.parent = parent;
  parent.children.set(name, file);
}
