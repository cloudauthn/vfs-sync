import { describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { VFSNode } from '../src/vfs-node.js';
import type { ByteRange, VFSAdapter } from '../src/types.js';
import { ExplorerModel } from '../explorer/src/model';
import type { BrowseSource } from '../explorer/src/model';

const encoder = new TextEncoder();

interface Calls {
  list: string[];
  read: string[];
  stat: string[];
  reset(): void;
}

/**
 * A pass-through adapter that tallies what it was asked for. Every call it
 * records is a network round trip on Drive, so these counts are the thing the
 * explorer's caches exist to keep down.
 */
function counting(base: VFSAdapter): { adapter: VFSAdapter; calls: Calls } {
  const calls: Calls = {
    list: [],
    read: [],
    stat: [],
    reset() {
      this.list.length = 0;
      this.read.length = 0;
      this.stat.length = 0;
    },
  };
  const adapter: VFSAdapter = {
    name: base.name,
    list: (path) => {
      calls.list.push(path);
      return base.list(path);
    },
    read: (path) => {
      calls.read.push(path);
      return base.read(path);
    },
    stat: (path) => {
      calls.stat.push(path);
      return base.stat(path);
    },
    write: (path, data) => base.write(path, data),
    delete: (path) => base.delete(path),
    rename: (from, to) => base.rename(from, to),
    mkdir: (path) => base.mkdir?.(path) ?? Promise.resolve(),
    readRange: (path, range?: ByteRange) => base.readRange?.(path, range) ?? base.read(path),
  };
  return { adapter, calls };
}

/**
 * A booted model browsing one counted filesystem that already holds two vFS
 * roots. `sources` is public and its entries are plain data, so a test can hand
 * the model a filesystem of its own without a browser API in sight.
 */
async function browsing(): Promise<{
  model: ExplorerModel;
  source: BrowseSource;
  calls: Calls;
}> {
  const base = new MemoryAdapter('base');
  for (const root of ['one', 'two']) {
    await base.write(`${root}/notes.md`, encoder.encode(`# ${root}\n`));
    await VFSNode.open(new ScopedAdapter(base, root), { id: root });
  }
  const { adapter, calls } = counting(base);
  const model = new ExplorerModel({ seed: null, localFolder: false });
  await model.boot();
  const source: BrowseSource = {
    key: 'test',
    label: 'Counted',
    icon: '🧪',
    backend: 'memory',
    adapter,
    expanded: new Set(),
  };
  model.sources.push(source);
  model.activeSource = source.key;
  await model.activateNewTab();
  calls.reset();
  return { model, source, calls };
}

const configReads = (calls: Calls): string[] =>
  calls.read.filter((path) => path.endsWith('config.json'));

describe('explorer caches', () => {
  it('probes each folder for a .vfs store once, not on every tree rebuild', async () => {
    const { model, source, calls } = await browsing();
    // The first build is behind us; both roots are already probed and cached.
    expect(configReads(calls)).toEqual([]);

    model.toggleBrowseDir(source, 'one', false);
    await vi.waitFor(() => expect(model.newTab?.rows?.length).toBeGreaterThan(2));
    model.toggleBrowseDir(source, 'one', true);
    await vi.waitFor(() => expect(model.newTab?.rows?.length).toBe(2));
    // Two full rebuilds of the tree, and not one re-read of a store's config.
    expect(configReads(calls)).toEqual([]);
    expect(model.newTab?.rows?.[0]?.info?.storeId).toBeTruthy();

    // The refresh button is the escape hatch: it re-reads everything.
    await model.reload();
    expect(configReads(calls)).toEqual(['one/.vfs/config.json', 'two/.vfs/config.json']);
  });

  it('takes a browsed file’s size and time from the listing it came from', async () => {
    const { model, source, calls } = await browsing();
    model.toggleBrowseDir(source, 'one', false);
    await vi.waitFor(() => expect(model.newTab?.rows?.length).toBeGreaterThan(2));
    calls.reset();

    model.selectBrowse(source, 'one/notes.md', 'file');
    await vi.waitFor(() => expect(model.newTab?.details.kind).toBe('file'));
    const details = model.newTab?.details;
    expect(details?.kind === 'file' && details.stat.size).toBe(6);
    // The listing already carried the stat, so clicking the row asked nothing.
    expect(calls.stat).toEqual([]);
    expect(calls.list).toEqual([]);
  });

  it('reads a selected file once, however often it is reselected', async () => {
    const { model, source, calls } = await browsing();
    await model.openVfsTab(source, 'one');
    const peer = model.activePeer();
    if (!peer) throw new Error('tab did not open');

    await model.select(peer, { path: 'notes.md', kind: 'file' });
    expect(model.details?.text).toBe('# one\n');
    expect(calls.read.filter((path) => path === 'one/notes.md')).toHaveLength(1);

    await model.select(peer, null);
    await model.select(peer, { path: 'notes.md', kind: 'file' });
    expect(model.details?.text).toBe('# one\n');
    // Same bytes, same mtime and size: served from the read cache.
    expect(calls.read.filter((path) => path === 'one/notes.md')).toHaveLength(1);
  });

  it('never serves a stale read: an edit lands on a new cache key', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    const peer = model.activePeer();
    if (!peer) throw new Error('tab did not open');

    await model.select(peer, { path: 'notes.md', kind: 'file' });
    const first = model.details?.hash;
    await model.write(peer, 'notes.md', '# one, edited\n');
    expect(model.details?.text).toBe('# one, edited\n');
    expect(model.details?.hash).not.toBe(first);
  });

  it('compares across roots out of their walks, without statting either', async () => {
    const { model, source, calls } = await browsing();
    await model.openVfsTab(source, 'one');
    await model.openVfsTab(source, 'two');
    const peer = model.activePeer();
    if (!peer) throw new Error('tab did not open');
    calls.reset();

    await model.select(peer, { path: 'notes.md', kind: 'file' });
    expect(model.details?.across).toHaveLength(1);
    // Both roots hold a `notes.md`, and their contents differ.
    expect(model.details?.across[0]?.state).toBe('differs');
    // Its presence, size and time all came from the other root's snapshot.
    expect(calls.stat).toEqual([]);
  });
});
