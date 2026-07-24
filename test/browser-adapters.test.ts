import { afterEach, describe, expect, it } from 'vitest';
import { FSAAdapter, isFSAAvailable } from '../src/adapters/fsa.js';
import { OPFSAdapter, isOPFSAvailable } from '../src/adapters/opfs.js';
import { VFSNode } from '../src/vfs-node.js';
import { FakeDirectoryHandle } from './fake-handle.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The two browser adapters are thin: they resolve a root handle and hand it to
 * HandleAdapter. Stubbing the globals lets us test that resolution — and the
 * FSA permission dance — without a browser. Behaviour of real OPFS itself is
 * the browser's business, not ours.
 */
function stub(name: 'navigator' | 'window', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function unstub(name: 'navigator' | 'window'): void {
  Reflect.deleteProperty(globalThis, name);
}

describe('OPFSAdapter', () => {
  afterEach(() => unstub('navigator'));

  it('reports unavailability instead of throwing on access', () => {
    stub('navigator', {});
    expect(isOPFSAvailable()).toBe(false);
  });

  it('refuses to open where OPFS is missing, with an actionable message', async () => {
    stub('navigator', {});
    await expect(OPFSAdapter.open()).rejects.toThrow(/not available/);
  });

  it('uses the origin-private root when no path is given', async () => {
    const root = new FakeDirectoryHandle('opfs-root');
    stub('navigator', { storage: { getDirectory: async () => root } });

    expect(isOPFSAvailable()).toBe(true);
    const adapter = await OPFSAdapter.open();

    expect(adapter.name).toBe('opfs');
    expect(adapter.root).toBe(root as never);
  });

  it('creates and descends into a subfolder of the root', async () => {
    const root = new FakeDirectoryHandle('opfs-root');
    stub('navigator', { storage: { getDirectory: async () => root } });

    const adapter = await OPFSAdapter.open({ path: 'apps/notes' });
    await adapter.write('a.txt', encoder.encode('scoped'));

    expect(adapter.name).toBe('apps/notes');
    // written inside the subfolder, not at the origin-private root
    const apps = await root.getDirectoryHandle('apps');
    const notes = await apps.getDirectoryHandle('notes');
    expect([...notes.children.keys()]).toEqual(['a.txt']);
    expect(decoder.decode(await adapter.read('a.txt'))).toBe('scoped');
  });

  it('accepts an explicit label', async () => {
    stub('navigator', { storage: { getDirectory: async () => new FakeDirectoryHandle('r') } });
    expect((await OPFSAdapter.open({ path: 'x', name: 'device-a' })).name).toBe('device-a');
  });

  it('works as a sync peer', async () => {
    stub('navigator', { storage: { getDirectory: async () => new FakeDirectoryHandle('r') } });
    const node = await VFSNode.open(await OPFSAdapter.open({ path: 'peer' }), { id: 'peer' });

    await node.write('notes.md', encoder.encode('hello'));
    expect(await node.commit()).toBeTypeOf('string');
    expect((await node.headTree()).entries[0]?.path).toBe('notes.md');
  });
});

describe('FSAAdapter', () => {
  afterEach(() => unstub('window'));

  it('reports unavailability when the picker is missing', () => {
    stub('window', {});
    expect(isFSAAvailable()).toBe(false);
  });

  it('refuses to pick where the API is missing', async () => {
    stub('window', {});
    await expect(FSAAdapter.pick()).rejects.toThrow(/not available/);
  });

  it('asks for readwrite by default and wraps the chosen folder', async () => {
    const chosen = new FakeDirectoryHandle('Documents');
    let requested: unknown;
    stub('window', {
      showDirectoryPicker: async (options: unknown) => {
        requested = options;
        return chosen;
      },
    });

    const adapter = await FSAAdapter.pick();
    expect(requested).toMatchObject({ mode: 'readwrite' });
    expect(adapter.name).toBe('Documents');
  });

  it('lets the caller override picker options', async () => {
    let requested: Record<string, unknown> | undefined;
    stub('window', {
      showDirectoryPicker: async (options: Record<string, unknown>) => {
        requested = options;
        return new FakeDirectoryHandle('d');
      },
    });

    await FSAAdapter.pick({ id: 'workspace', mode: 'read' });
    expect(requested).toMatchObject({ id: 'workspace', mode: 'read' });
  });

  it('wraps a handle restored from IndexedDB', () => {
    const adapter = FSAAdapter.fromHandle(new FakeDirectoryHandle('restored') as never, 'device-a');
    expect(adapter.name).toBe('device-a');
    expect(FSAAdapter.fromHandle(new FakeDirectoryHandle('restored') as never).name).toBe('restored');
  });

  describe('permissions', () => {
    function handleWith(state: PermissionState, onRequest?: PermissionState) {
      const root = new FakeDirectoryHandle('folder') as never as Record<string, unknown>;
      root.queryPermission = async () => state;
      if (onRequest) root.requestPermission = async () => onRequest;
      return FSAAdapter.fromHandle(root as never);
    }

    it('sees an already-granted handle without prompting', async () => {
      const adapter = handleWith('granted');
      expect(await adapter.hasPermission()).toBe(true);
      expect(await adapter.ensurePermission()).toBe(true);
    });

    it('re-requests when permission has lapsed', async () => {
      const adapter = handleWith('prompt', 'granted');
      expect(await adapter.hasPermission()).toBe(false);
      expect(await adapter.ensurePermission()).toBe(true);
    });

    it('reports a refusal rather than throwing', async () => {
      const adapter = handleWith('prompt', 'denied');
      expect(await adapter.ensurePermission()).toBe(false);
    });

    it('assumes access where the browser exposes no permission API', async () => {
      const adapter = FSAAdapter.fromHandle(new FakeDirectoryHandle('folder') as never);
      expect(await adapter.hasPermission()).toBe(true);
      expect(await adapter.ensurePermission()).toBe(true);
    });
  });
});
