import { HandleAdapter } from './handle.js';

type PermissionMode = 'read' | 'readwrite';

interface PermissionCapableHandle {
  queryPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: PermissionMode;
  startIn?: string | FileSystemHandle;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
  }
}

export function isFSAAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * File System Access API backend — a real folder on the user's disk.
 *
 * The important difference from OPFS is that permission is revocable and does
 * not survive a page reload: a stored handle has to be re-authorised with a
 * user gesture before it can be read again. Call {@link ensurePermission}
 * before a sync run and surface the `false` case in your UI.
 */
export class FSAAdapter extends HandleAdapter {
  /** Prompts for a folder. Must be called from a user gesture. */
  static async pick(options: DirectoryPickerOptions = {}): Promise<FSAAdapter> {
    if (!isFSAAvailable()) {
      throw new Error('The File System Access API is not available in this browser');
    }
    const picker = window.showDirectoryPicker as NonNullable<Window['showDirectoryPicker']>;
    const handle = await picker({ mode: 'readwrite', ...options });
    return new FSAAdapter(handle);
  }

  /** Wraps a handle restored from IndexedDB. */
  static fromHandle(handle: FileSystemDirectoryHandle, name?: string): FSAAdapter {
    return new FSAAdapter(handle, name);
  }

  /** True if already granted, without prompting. */
  async hasPermission(mode: PermissionMode = 'readwrite'): Promise<boolean> {
    const handle = this.root as FileSystemDirectoryHandle & PermissionCapableHandle;
    if (!handle.queryPermission) return true;
    return (await handle.queryPermission({ mode })) === 'granted';
  }

  /**
   * Re-requests permission if needed. The prompt requires a user gesture, so
   * call this from a click handler rather than from a background timer.
   */
  async ensurePermission(mode: PermissionMode = 'readwrite'): Promise<boolean> {
    if (await this.hasPermission(mode)) return true;
    const handle = this.root as FileSystemDirectoryHandle & PermissionCapableHandle;
    if (!handle.requestPermission) return true;
    return (await handle.requestPermission({ mode })) === 'granted';
  }
}
