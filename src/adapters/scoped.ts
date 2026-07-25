import { joinPath, normalizePath } from '../path.js';
import type { ByteRange, VFSAdapter, VFSListEntry, VFSStat } from '../types.js';

/**
 * A view of another adapter rooted at one of its subfolders, so any folder of
 * any backend can host its own `.vfs` store. The handle-based backends can
 * re-root natively; this wrapper gives every other backend the same ability.
 *
 * The optional methods (`fileId`, streaming) are only present when the base
 * adapter has them, so capability checks like `canStream()` see the truth.
 */
export class ScopedAdapter implements VFSAdapter {
  readonly name: string;
  readonly base: VFSAdapter;
  readonly root: string;

  mkdir?: (path: string) => Promise<void>;
  fileId?: (path: string) => Promise<string | null>;
  readRange?: (path: string, range?: ByteRange) => Promise<Uint8Array>;
  readStream?: (path: string, range?: ByteRange) => Promise<ReadableStream<Uint8Array>>;
  writeStream?: (path: string) => Promise<WritableStream<Uint8Array>>;

  constructor(base: VFSAdapter, root: string, name?: string) {
    this.base = base;
    this.root = normalizePath(root);
    this.name = name ?? (this.root ? `${base.name}/${this.root}` : base.name);

    const mkdir = base.mkdir?.bind(base);
    if (mkdir) this.mkdir = (path) => mkdir(this.at(path));
    const fileId = base.fileId?.bind(base);
    if (fileId) this.fileId = (path) => fileId(this.at(path));
    const readRange = base.readRange?.bind(base);
    if (readRange) this.readRange = (path, range) => readRange(this.at(path), range);
    const readStream = base.readStream?.bind(base);
    if (readStream) this.readStream = (path, range) => readStream(this.at(path), range);
    const writeStream = base.writeStream?.bind(base);
    if (writeStream) this.writeStream = (path) => writeStream(this.at(path));
  }

  private at(path: string): string {
    return joinPath(this.root, path);
  }

  /** Base paths come back prefixed with the scope root; strip it. */
  private un(path: string): string {
    return this.root ? path.slice(this.root.length + 1) : path;
  }

  async list(path: string): Promise<VFSListEntry[]> {
    const entries = await this.base.list(this.at(path));
    return entries.map((entry) => ({ ...entry, path: this.un(entry.path) }));
  }

  read(path: string): Promise<Uint8Array> {
    return this.base.read(this.at(path));
  }

  write(path: string, data: Uint8Array): Promise<void> {
    return this.base.write(this.at(path), data);
  }

  delete(path: string): Promise<void> {
    return this.base.delete(this.at(path));
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.base.rename(this.at(oldPath), this.at(newPath));
  }

  stat(path: string): Promise<VFSStat | null> {
    return this.base.stat(this.at(path));
  }
}
