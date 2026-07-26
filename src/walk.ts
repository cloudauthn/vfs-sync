import { CONTROL_DIR } from './store.js';
import type { VFSAdapter, VFSStat } from './types.js';

export interface WalkedFile {
  path: string;
  stat: VFSStat;
}

export interface WalkOptions {
  /** Extra paths/prefixes to skip. `.vfs` is always skipped. */
  ignore?: (path: string) => boolean;
  controlDir?: string;
}

/**
 * Recursive listing of every file under the adapter root, with the control
 * folder excluded — otherwise the engine would try to sync its own metadata.
 */
export async function walk(adapter: VFSAdapter, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const controlDir = options.controlDir ?? CONTROL_DIR;
  const ignore = options.ignore;
  const files: WalkedFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    for (const entry of await adapter.list(dir)) {
      if (entry.path === controlDir || entry.path.startsWith(`${controlDir}/`)) continue;
      if (ignore?.(entry.path)) continue;
      if (entry.kind === 'directory') {
        await visit(entry.path);
        continue;
      }
      // A listing that already carried the stat saves a call per file — on Drive
      // that is a round trip per file, which is most of what walking one costs.
      const stat = entry.stat ?? (await adapter.stat(entry.path));
      if (stat && stat.kind === 'file') files.push({ path: entry.path, stat });
    }
  };

  await visit('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
