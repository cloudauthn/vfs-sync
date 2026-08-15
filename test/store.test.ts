import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSStore } from '../src/store.js';
import { makeRow } from '../src/log.js';
import { ZERO_DIGEST } from '../src/vfs-file.js';
import { decoder, encoder, peer, put } from './helpers.js';
import type { LogRow } from '../src/types.js';

async function row(uuid: string, at: number, hash: string | null = 'h'): Promise<LogRow> {
  return makeRow({
    batch: 'b1',
    at,
    peerId: 'device-a',
    uuid,
    type: hash ? 'write' : 'delete',
    kind: 'file',
    path: `${uuid}.txt`,
    hash,
  });
}

describe('the control folder', () => {
  it('opens an empty store and keeps its identity on reopen', async () => {
    const adapter = new MemoryAdapter('device-a');
    const created = await new VFSStore(adapter).init({ peerId: 'device-a' });
    const reopened = await new VFSStore(adapter).init({ peerId: 'someone-else' });

    expect(reopened.peerId).toBe('device-a');
    expect(reopened.syncId).toBe(created.syncId);
    expect(reopened.version).toBe(3);
  });

  it('says which backend has no store rather than inventing one', async () => {
    await expect(new VFSStore(new MemoryAdapter('device-a')).read()).rejects.toThrow(
      /no vfs store in device-a/,
    );
  });

  /**
   * Reads go straight to `read` and only ask `stat` on failure, so that question
   * has to be answered right: a flaky backend must not read as an empty store,
   * which would mint a fresh identity over a real one.
   */
  it('tells a backend that broke apart from a file that is not there', async () => {
    const base = new MemoryAdapter('flaky');
    await new VFSStore(base).init({ peerId: 'device-a' });
    const broken = Object.create(base) as MemoryAdapter;
    broken.read = () => Promise.reject(new Error('502 from the backend'));

    await expect(new VFSStore(broken).read()).rejects.toThrow(/502 from the backend/);
    // ...whereas a folder that genuinely has no store is just absent.
    await expect(new VFSStore(broken, '.other').read()).rejects.toThrow(/no vfs store/);
  });

  it('re-reads from the backend after invalidate()', async () => {
    const adapter = new MemoryAdapter('s');
    const writer = new VFSStore(adapter);
    const reader = new VFSStore(adapter);

    const file = await writer.init({ peerId: 'device-a' });
    expect((await reader.read()).peerId).toBe('device-a');

    file.text = ['xml'];
    await writer.write(file);
    expect((await reader.read()).text).not.toEqual(['xml']); // still memoised

    reader.invalidate();
    expect((await reader.read()).text).toEqual(['xml']);
  });
});

describe('discarding the store', () => {
  /** A store with something in every corner of `.vfs`. */
  async function furnished(adapter: MemoryAdapter): Promise<VFSStore> {
    const store = new VFSStore(adapter, undefined, { rotateAt: 1 });
    const file = await store.init({ peerId: 'device-a' });
    file.syncId = 'g-old';
    file.absorbed = ['g-older'];
    await store.append([await row('u1', 100)], file);
    await store.rotate(file); // closes commits-<ts> and writes vfs-<ts>.json
    await store.append([await row('u2', 200)], file);
    await store.putBase('h1', encoder.encode('an older version'));
    return new VFSStore(adapter, undefined, { rotateAt: 1 }).write(file).then(() => store);
  }

  it('leaves a folder that reads as one that has never synced', async () => {
    const adapter = new MemoryAdapter('device-a');
    const store = await furnished(adapter);

    const fresh = await store.discard();

    expect(fresh.syncId).toBeNull();
    expect(fresh.absorbed).toEqual([]);
    expect(fresh.peerId).not.toBe('device-a');
    expect(fresh.entries).toEqual([]);
    expect(fresh.peers).toEqual({});
    expect(fresh.log.rows).toBe(0);
    expect(fresh.log.digest).toBe(ZERO_DIGEST);
    expect(fresh.log.snapshot).toBeUndefined();
    // Nothing of the mesh it left is still readable from here.
    expect(await store.logRows()).toEqual([]);
    expect(await store.readSnapshot()).toEqual([]);
    expect(await store.getBase('h1')).toBeNull();
    expect((await adapter.list('.vfs')).map((entry) => entry.name).sort()).toEqual(['vfs.json']);
  });

  /** Configuration, not history: nobody else holds a copy to restore it from. */
  it('keeps this node local exclusion rules', async () => {
    const adapter = new MemoryAdapter('device-a');
    const store = await furnished(adapter);

    const fresh = await store.discard({ local: { ignore: ['*.tmp'] } });

    expect(fresh.local.ignore).toEqual(['*.tmp']);
  });

  /**
   * The active segment is the only file read without the header naming it, so a
   * header replaced while it is still there would hand the old mesh's rows to a
   * folder claiming to have no history. Failing is the recoverable outcome: the
   * folder still declares the mesh it is leaving, and the next pass discards it
   * again.
   */
  it('refuses to replace the header while the old log is still on disk', async () => {
    const adapter = new MemoryAdapter('device-a');
    await furnished(adapter);
    const stubborn = Object.create(adapter) as MemoryAdapter;
    stubborn.delete = (path: string) =>
      path === '.vfs/commits' ? Promise.reject(new Error('backend said no')) : adapter.delete(path);

    await expect(new VFSStore(stubborn, undefined, { rotateAt: 1 }).discard()).rejects.toThrow(
      /still there/,
    );

    // Still a member of the mesh it was leaving, with its log intact...
    const after = await new VFSStore(adapter).read();
    expect(after.syncId).toBe('g-old');
    expect((await new VFSStore(adapter).logRows()).map((item) => item.uuid)).toEqual(['u2']);
    // ...and the retry, against a backend that works, completes.
    expect((await new VFSStore(adapter).discard()).syncId).toBeNull();
  });
});

describe('appending to the log', () => {
  it('adds only what the segment does not already hold', async () => {
    const adapter = new MemoryAdapter('s');
    const store = new VFSStore(adapter);
    const file = await store.init({ peerId: 'device-a' });

    const one = await row('u1', 100);
    const two = await row('u2', 200);
    await store.append([one, two], file);
    await store.append([two, one], file); // the same operations again

    expect(file.log.rows).toBe(2);
    expect(decoder.decode(await adapter.read('.vfs/commits')).trim().split('\n')).toHaveLength(2);
  });

  it('keeps the digest in step with the set', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    const file = await store.init({ peerId: 'device-a' });
    expect(file.log.digest).toBe(ZERO_DIGEST);

    await store.append([await row('u1', 100)], file);
    const afterOne = file.log.digest;
    await store.append([await row('u2', 200)], file);
    expect(file.log.digest).not.toBe(afterOne);
  });

  /**
   * One writer per store is the assumption; a shared file makes it a race. The
   * mitigation is explicit — notice the file grew and fold the tail in rather
   * than writing over it.
   */
  it('folds in rows another writer appended underneath it', async () => {
    const adapter = new MemoryAdapter('s');
    const mine = new VFSStore(adapter);
    const file = await mine.init({ peerId: 'device-a' });
    await mine.append([await row('u1', 100)], file);

    // Somebody else appends through a store of their own.
    const theirs = new VFSStore(adapter);
    await theirs.append([await row('u2', 200)], await theirs.read());

    await mine.append([await row('u3', 300)], file);
    expect(file.log.rows).toBe(3);
    expect((await mine.logRows()).map((item) => item.uuid).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('reads the tail from an offset instead of the whole segment', async () => {
    const adapter = new MemoryAdapter('s');
    const store = new VFSStore(adapter);
    const file = await store.init({ peerId: 'device-a' });
    await store.append([await row('u1', 100)], file);
    const offset = file.log.size;
    await store.append([await row('u2', 200)], file);

    const cold = new VFSStore(adapter);
    expect((await cold.rowsSince(offset)).map((item) => item.uuid)).toEqual(['u2']);
  });
});

describe('base/', () => {
  it('holds text versions and prunes what nothing refers to', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    await store.init({ peerId: 'device-a' });
    await store.putBase('keepme', encoder.encode('kept'));
    await store.putBase('dropme', encoder.encode('dropped'));

    await store.pruneBase(new Set(['keepme']));
    expect(decoder.decode((await store.getBase('keepme')) as Uint8Array)).toBe('kept');
    expect(await store.getBase('dropme')).toBeNull();
  });

  it('is filled as text versions are recorded, and never travels', async () => {
    const a = await peer('a');
    await put(a, 'list.xml', '<one/>\n');
    await a.node.commit();
    const first = (await a.node.live())[0]?.hash as string;

    expect(await a.node.baseOf(first)).not.toBeNull();
    // Local by construction: the working snapshot cannot see it.
    expect(Object.keys(a.fs.snapshot())).toEqual(['list.xml']);
  });

  it('leaves binary content alone', async () => {
    const a = await peer('a');
    await put(a, 'game.bin', 'not text');
    await a.node.commit();
    const hash = (await a.node.live())[0]?.hash as string;
    expect(await a.node.baseOf(hash)).toBeNull();
  });
});
