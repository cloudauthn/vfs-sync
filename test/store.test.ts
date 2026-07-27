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
    peer: 'device-a',
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
    const created = await new VFSStore(adapter).init({ peer: 'device-a' });
    const reopened = await new VFSStore(adapter).init({ peer: 'someone-else' });

    expect(reopened.peer).toBe('device-a');
    expect(reopened.storeId).toBe(created.storeId);
    expect(reopened.version).toBe(2);
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
    await new VFSStore(base).init({ peer: 'device-a' });
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

    const file = await writer.init({ peer: 'device-a' });
    expect((await reader.read()).peer).toBe('device-a');

    file.text = ['xml'];
    await writer.write(file);
    expect((await reader.read()).text).not.toEqual(['xml']); // still memoised

    reader.invalidate();
    expect((await reader.read()).text).toEqual(['xml']);
  });
});

describe('appending to the log', () => {
  it('adds only what the segment does not already hold', async () => {
    const adapter = new MemoryAdapter('s');
    const store = new VFSStore(adapter);
    const file = await store.init({ peer: 'device-a' });

    const one = await row('u1', 100);
    const two = await row('u2', 200);
    await store.append([one, two], file);
    await store.append([two, one], file); // the same operations again

    expect(file.log.rows).toBe(2);
    expect(decoder.decode(await adapter.read('.vfs/commits')).trim().split('\n')).toHaveLength(2);
  });

  it('keeps the digest in step with the set', async () => {
    const store = new VFSStore(new MemoryAdapter('s'));
    const file = await store.init({ peer: 'device-a' });
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
    const file = await mine.init({ peer: 'device-a' });
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
    const file = await store.init({ peer: 'device-a' });
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
    await store.init({ peer: 'device-a' });
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
