import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { dirname, normalizePath } from '../path.js';
import type { VFSAdapter, VFSListEntry, VFSStat } from '../types.js';

/**
 * Node.js filesystem backend. Useful for CLI tooling and server-side peers,
 * and it is what makes the engine testable against a real filesystem rather
 * than only against the in-memory adapter.
 */
export class NodeFsAdapter implements VFSAdapter {
  readonly name: string;
  readonly root: string;

  constructor(root: string, name = nodePath.basename(root)) {
    this.root = nodePath.resolve(root);
    this.name = name;
  }

  /** Creates the folder if it does not exist yet. */
  static async open(root: string, name?: string): Promise<NodeFsAdapter> {
    await fs.mkdir(root, { recursive: true });
    return new NodeFsAdapter(root, name);
  }

  private resolve(path: string): string {
    const relative = normalizePath(path);
    return relative ? nodePath.join(this.root, relative) : this.root;
  }

  async list(path: string): Promise<VFSListEntry[]> {
    const base = normalizePath(path);
    let entries;
    try {
      entries = await fs.readdir(this.resolve(base), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.map((entry) => ({
      name: entry.name,
      path: base ? `${base}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
    }));
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.resolve(path)));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const target = this.resolve(path);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async delete(path: string): Promise<void> {
    await fs.rm(this.resolve(path), { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const target = normalizePath(newPath);
    await fs.mkdir(this.resolve(dirname(target)), { recursive: true });
    await fs.rename(this.resolve(oldPath), this.resolve(target));
  }

  async stat(path: string): Promise<VFSStat | null> {
    try {
      const stat = await fs.stat(this.resolve(path));
      return {
        kind: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        // ms precision: sub-millisecond values would not survive JSON round
        // trips identically on every platform
        mtime: Math.floor(stat.mtimeMs),
      };
    } catch {
      return null;
    }
  }
}
