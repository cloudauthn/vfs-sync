import { normalizePath } from '../path.js';
import { HandleAdapter } from './handle.js';

export interface OPFSAdapterOptions {
  /** Subfolder of the origin-private root to use as the adapter root. */
  path?: string;
  name?: string;
}

export function isOPFSAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/**
 * Origin Private File System backend. Always available offline, never prompts,
 * and — unlike the File System Access API — its handles never lose permission,
 * which makes it the natural home for a background sync loop.
 */
export class OPFSAdapter extends HandleAdapter {
  /** Resolves the origin-private root (optionally a subfolder of it). */
  static async open(options: OPFSAdapterOptions = {}): Promise<OPFSAdapter> {
    if (!isOPFSAvailable()) throw new Error('OPFS is not available in this environment');
    let root = await navigator.storage.getDirectory();
    const path = normalizePath(options.path ?? '');
    for (const segment of path.split('/').filter(Boolean)) {
      root = await root.getDirectoryHandle(segment, { create: true });
    }
    return new OPFSAdapter(root, options.name ?? (path || 'opfs'));
  }
}
