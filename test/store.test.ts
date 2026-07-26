import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSStore, canonicalTree } from '../src/store.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import type { Tree } from '../src/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('object store', () => {
  it('addresses blobs by content and dedupes them', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    const first = await store.putObject(encoder.encode('payload'));
    const second = await store.putObject(encoder.encode('payload'));

    expect(first).toBe(second);
    expect(await store.hasObject(first)).toBe(true);
    expect(decoder.decode(await store.getObject(first))).toBe('payload');
  });

  it('names the backend when an object is missing', async () => {
    const store = new VFSStore(new MemoryAdapter('device-a'));
    await expect(store.getObject('deadbeef')).rejects.toThrow(/missing object deadbeef in device-a/);
  });

  it('tells a backend that broke apart from a file that is not there', async () => {
    // Store reads go straight to `read` and only ask `stat` if it failed, so
    // that question has to be answered right: a flaky backend must not read as
    // an empty store, which would mint a fresh identity over a real one.
    const base = new MemoryAdapter('flaky');
    const store = new VFSStore(base);
    await store.init('device-a');
    const broken = Object.create(base) as MemoryAdapter;
    broken.read = () => Promise.reject(new Error('502 from the backend'));

    const over = new VFSStore(broken);
    await expect(over.readConfig()).rejects.toThrow(/502 from the backend/);
    // ...whereas a file that genuinely is not there is still just absent.
    await expect(new VFSStore(broken, '.other').readConfig()).resolves.toMatchObject({
      head: null,
    });
  });

  it('names the backend when a commit is missing', async () => {
    const store = new VFSStore(new MemoryAdapter('device-a'));
    await expect(store.getCommit('deadbeef')).rejects.toThrow(/missing commit deadbeef in device-a/);
    expect(await store.hasCommit('deadbeef')).toBe(false);
  });

  it('gives a tree the same hash regardless of entry order', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    const one: Tree = {
      entries: [
        { id: 'b', path: 'b.txt', hash: 'h2', size: 1, mtime: 2 },
        { id: 'a', path: 'a.txt', hash: 'h1', size: 1, mtime: 1 },
      ],
    };
    const other: Tree = { entries: [...one.entries].reverse() };
    expect(await store.putTree(one)).toBe(await store.putTree(other));
  });
});

describe('canonicalTree', () => {
  it('sorts by id and drops falsy optionals', () => {
    const canonical = canonicalTree({
      entries: [
        { id: 'z', path: 'z', hash: null, size: 0, mtime: 1, deleted: true, peer: 'p' },
        { id: 'a', path: 'a', hash: 'h', size: 1, mtime: 1, deleted: false, renamedFrom: '' },
      ],
    });

    expect(canonical.entries.map((e) => e.id)).toEqual(['a', 'z']);
    expect(canonical.entries[0]).not.toHaveProperty('deleted');
    expect(canonical.entries[0]).not.toHaveProperty('renamedFrom');
    expect(canonical.entries[1]).toMatchObject({ deleted: true, peer: 'p' });
  });
});

describe('known-commits log', () => {
  it('survives a reopen, parsed back from disk', async () => {
    const adapter = new MemoryAdapter('device-a');
    const node = await VFSNode.open(adapter, { id: 'device-a' });
    await node.write('notes.md', encoder.encode('v1'));
    const first = await node.commit();
    await node.write('notes.md', encoder.encode('v2'));
    const second = await node.commit();

    // a brand new store over the same folder has to rebuild its index by
    // reading the log rather than from memory
    const reopened = new VFSStore(adapter);
    const known = await reopened.known();

    expect([...known.keys()].sort()).toEqual([first, second].sort());
    expect(known.get(second as string)?.parents).toEqual([first]);
    expect(known.get(first as string)?.parents).toEqual([]);
    expect(typeof known.get(first as string)?.timestamp).toBe('number');
  });

  it('ignores blank lines and keeps entries unique', async () => {
    const adapter = new MemoryAdapter('s');
    const store = new VFSStore(adapter);
    await store.addKnown({ hash: 'aaa', timestamp: 2, parents: ['bbb'] });
    await store.addKnown({ hash: 'aaa', timestamp: 999, parents: [] });

    const reopened = new VFSStore(adapter);
    const known = await reopened.known();
    expect(known.size).toBe(1);
    expect(known.get('aaa')).toEqual({ hash: 'aaa', timestamp: 2, parents: ['bbb'] });
  });

  it('lets two peers negotiate an ancestor after both were reopened', async () => {
    const adapterA = new MemoryAdapter('device-a');
    const adapterB = new MemoryAdapter('device-b');

    const a = await VFSNode.open(adapterA, { id: 'device-a' });
    const b = await VFSNode.open(adapterB, { id: 'device-b' });
    await a.write('notes.md', encoder.encode('v1'));
    const firstSync = await sync(a, b);
    expect(firstSync.base).toBeNull();

    // reopen both: everything now has to come back off disk
    const a2 = await VFSNode.open(adapterA, { id: 'device-a' });
    const b2 = await VFSNode.open(adapterB, { id: 'device-b' });
    await a2.write('notes.md', encoder.encode('v2'));

    const second = await sync(a2, b2);
    expect(second.base).toBe(firstSync.head);
    expect(decoder.decode(await b2.read('notes.md'))).toBe('v2');
  });
});

describe('memoisation', () => {
  it('re-reads from the adapter after invalidate()', async () => {
    const adapter = new MemoryAdapter('s');
    const writer = new VFSStore(adapter);
    const reader = new VFSStore(adapter);

    await writer.init('device-a');
    expect((await reader.readConfig()).id).toBe('device-a');

    await writer.setHead('abc123');
    expect(await reader.head()).toBeNull(); // still the memoised copy

    reader.invalidate();
    expect(await reader.head()).toBe('abc123');
  });

  it('keeps an existing id when init runs again', async () => {
    const adapter = new MemoryAdapter('s');
    const store = new VFSStore(adapter);
    const created = await store.init('device-a');
    const reopened = await new VFSStore(adapter).init('someone-else');

    expect(reopened.id).toBe(created.id);
  });

  it('records the last sync per peer', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    await store.init('device-a');
    await store.recordPeer('device-b', 'head-hash', 1234);

    const config = await store.readConfig();
    expect(config.peers['device-b']).toEqual({ lastSync: 1234, head: 'head-hash' });
  });
});
