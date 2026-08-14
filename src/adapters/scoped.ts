import { joinPath, normalizePath } from '../path.js';
import type {
  ByteRange,
  VFSAdapter,
  VFSChangeFeed,
  VFSListEntry,
  VFSStat,
} from '../types.js';

/**
 * Follows a chain of views down to the adapter that really holds the bytes,
 * carrying the path down with it.
 *
 * `copyFrom` receives whatever adapter the engine was handed, and the topology
 * the native fast path exists for has a view on *both* sides — two scoped
 * folders in one Drive. A concrete adapter cannot resolve a path it is given
 * through a wrapper, so every implementation opens by unscoping its source.
 */
export function unscope(
  adapter: VFSAdapter,
  path: string,
): { adapter: VFSAdapter; path: string } {
  let held = adapter;
  let at = normalizePath(path);
  while (held instanceof ScopedAdapter) {
    at = joinPath(held.root, at);
    held = held.base;
  }
  return { adapter: held, path: at };
}

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
  append?: (path: string, data: Uint8Array) => Promise<void>;
  writeIf?: (path: string, data: Uint8Array, tag: string | null) => Promise<string | null>;
  tag?: (path: string) => Promise<string | null>;
  changes?: (token: string | null) => Promise<VFSChangeFeed>;
  backendId?: () => Promise<string | null>;
  copyFrom?: (source: VFSAdapter, from: string, to: string) => Promise<number | null>;

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
    const append = base.append?.bind(base);
    if (append) this.append = (path, data) => append(this.at(path), data);
    const writeIf = base.writeIf?.bind(base);
    if (writeIf) this.writeIf = (path, data, tag) => writeIf(this.at(path), data, tag);
    const tag = base.tag?.bind(base);
    if (tag) this.tag = (path) => tag(this.at(path));
    // A view is not a backend: two scopes over one Drive are one Drive, which is
    // the whole point of the fast path. Only the destination is re-rooted here —
    // the base unscopes the source itself, and nested views recurse.
    const backendId = base.backendId?.bind(base);
    if (backendId) this.backendId = () => backendId();
    const copyFrom = base.copyFrom?.bind(base);
    if (copyFrom) this.copyFrom = (source, from, to) => copyFrom(source, from, this.at(to));
    // The change feed is account-wide on every backend that has one, so it is
    // forwarded whole and filtered by the caller against the paths it knows.
    const changes = base.changes?.bind(base);
    if (changes) {
      this.changes = async (token) => {
        const feed = await changes(token);
        return {
          ...feed,
          changes: feed.changes
            .filter((change) => !change.path || this.inside(change.path))
            .map((change) => (change.path ? { ...change, path: this.un(change.path) } : change)),
        };
      };
    }
  }

  private inside(path: string): boolean {
    return !this.root || path === this.root || path.startsWith(`${this.root}/`);
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
