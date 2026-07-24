import { basename, dirname, normalizePath } from '../path.js';
import type { VFSAdapter, VFSListEntry, VFSStat } from '../types.js';

type DirEntries = AsyncIterable<[string, FileSystemHandle]>;

interface MovableHandle {
  move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void>;
}

/**
 * Shared implementation for the two handle-based browser backends: OPFS and
 * the File System Access API expose the same `FileSystemDirectoryHandle`
 * model, they differ only in how the root handle is obtained and in whether
 * permissions can expire.
 */
export class HandleAdapter implements VFSAdapter {
  readonly name: string;
  readonly root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle, name = root.name || 'handle') {
    this.root = root;
    this.name = name;
  }

  protected async dir(path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    let handle = this.root;
    for (const segment of normalizePath(path).split('/').filter(Boolean)) {
      try {
        handle = await handle.getDirectoryHandle(segment, { create });
      } catch {
        return null;
      }
    }
    return handle;
  }

  protected async file(path: string, create = false): Promise<FileSystemFileHandle | null> {
    const target = normalizePath(path);
    const parent = await this.dir(dirname(target), create);
    if (!parent) return null;
    try {
      return await parent.getFileHandle(basename(target), { create });
    } catch {
      return null;
    }
  }

  async list(path: string): Promise<VFSListEntry[]> {
    const dir = await this.dir(path);
    if (!dir) return [];
    const base = normalizePath(path);
    const out: VFSListEntry[] = [];
    for await (const [name, handle] of dir as unknown as DirEntries) {
      out.push({
        name,
        path: base ? `${base}/${name}` : name,
        kind: handle.kind === 'directory' ? 'directory' : 'file',
      });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const handle = await this.file(path);
    if (!handle) throw new Error(`ENOENT: ${path}`);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const handle = await this.file(path, true);
    if (!handle) throw new Error(`cannot write ${path}`);
    const writable = await handle.createWritable();
    try {
      await writable.write(data as unknown as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async delete(path: string): Promise<void> {
    const target = normalizePath(path);
    const parent = await this.dir(dirname(target));
    if (!parent) return;
    try {
      await parent.removeEntry(basename(target), { recursive: true });
    } catch {
      // already gone
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (from === to) return;

    const handle = await this.file(from);
    if (!handle) throw new Error(`ENOENT: ${oldPath}`);
    const targetDir = await this.dir(dirname(to), true);
    if (!targetDir) throw new Error(`cannot create ${dirname(to)}`);

    const movable = handle as FileSystemFileHandle & MovableHandle;
    if (typeof movable.move === 'function') {
      await movable.move(targetDir, basename(to));
      return;
    }
    // No native move (Safari, older Chrome): fall back to copy + delete. The
    // engine still sees a rename because intent was recorded by VFSNode.
    await this.write(to, await this.read(from));
    await this.delete(from);
  }

  async stat(path: string): Promise<VFSStat | null> {
    const target = normalizePath(path);
    if (target === '') return { kind: 'directory', size: 0, mtime: 0 };
    const parent = await this.dir(dirname(target));
    if (!parent) return null;
    const name = basename(target);
    try {
      const handle = await parent.getFileHandle(name);
      const file = await handle.getFile();
      return { kind: 'file', size: file.size, mtime: file.lastModified };
    } catch {
      // not a file — maybe a directory
    }
    try {
      await parent.getDirectoryHandle(name);
      return { kind: 'directory', size: 0, mtime: 0 };
    } catch {
      return null;
    }
  }
}
