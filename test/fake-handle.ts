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

  /**
   * A real `File`, so the adapter's `slice()`/`stream()` paths run against the
   * genuine Blob semantics rather than a hand-rolled approximation of them.
   */
  async getFile(): Promise<File> {
    return new File([this.data.slice() as unknown as BlobPart], this.name, {
      lastModified: this.lastModified,
    });
  }

  /**
   * `keepExistingData` plus positional writes are what make a real append cheap
   * on OPFS and FSA, so the fake models both — otherwise the adapter's native
   * append path would never be exercised outside a browser.
   */
  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<{
    write(chunk: Uint8Array | { type: 'write'; position?: number; data: Uint8Array }): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
  }> {
    let buffer = options.keepExistingData ? this.data.slice() : new Uint8Array();
    let cursor = 0;
    let aborted = false;
    const put = (data: Uint8Array, position: number) => {
      const end = position + data.byteLength;
      if (end > buffer.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(data, position);
      cursor = end;
    };
    return {
      write: async (chunk) => {
        if (chunk instanceof Uint8Array) put(chunk.slice(), cursor);
        else put(chunk.data.slice(), chunk.position ?? cursor);
      },
      close: async () => {
        if (aborted) return;
        this.data = buffer;
        this.lastModified = this.parent.clock();
      },
      // A discarded writable leaves the file untouched, like the real thing.
      abort: async () => {
        aborted = true;
        buffer = new Uint8Array();
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
