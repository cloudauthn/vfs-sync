import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import {
  ZERO_DIGEST,
  canonicalEntry,
  decodeVFSFile,
  emptyFile,
  encodeVFSFile,
  extensionOf,
  normalizeFile,
  parseHeader,
  sortEntries,
  stateDigest,
} from '../src/vfs-file.js';
import {
  encodeRows,
  makeRow,
  missingRows,
  opId,
  parseRows,
  sortRows,
  unionRows,
  xorDigest,
  xorHex,
} from '../src/log.js';
import { VFSStore } from '../src/store.js';
import { decoder, encoder, peer, put } from './helpers.js';
import type { LogRow, VFSEntry } from '../src/types.js';

function entry(partial: Partial<VFSEntry> & { uuid: string; path: string }): VFSEntry {
  return {
    kind: 'file',
    hash: 'h',
    size: 1,
    created: 1000,
    updated: 1000,
    peer: 'device-a',
    ...partial,
  };
}

function row(partial: Partial<LogRow> & { op: string; uuid: string }): LogRow {
  return {
    batch: 'batch',
    at: 1000,
    peer: 'device-a',
    type: 'write',
    kind: 'file',
    path: 'a.txt',
    ...partial,
  };
}

describe('vfs.json', () => {
  it('round-trips', async () => {
    const file = await normalizeFile({
      ...emptyFile('device-a', 'store-1', 1785102000000, ['xml']),
      entries: [entry({ uuid: 'b', path: 'b.txt' }), entry({ uuid: 'a', path: 'a.txt' })],
    });
    expect(decodeVFSFile(encodeVFSFile(file))).toEqual(file);
  });

  it('puts the header first, so a range read can stop early', async () => {
    const file = await normalizeFile({
      ...emptyFile('device-a', 'store-1', 1, []),
      entries: Array.from({ length: 200 }, (_, i) =>
        entry({ uuid: `u${i}`, path: `file-${i}.txt` }),
      ),
    });
    const bytes = encodeVFSFile(file);
    const text = decoder.decode(bytes);
    expect(text.indexOf('"state"')).toBeLessThan(text.indexOf('"entries"'));

    // Only the head of the file, as `readRange` would deliver it.
    const header = parseHeader(bytes.slice(0, 1024));
    expect(header?.state).toBe(file.state);
    expect(header?.storeId).toBe('store-1');
    expect(header).not.toHaveProperty('entries');
  });

  it('asks for more when the prefix stopped short of the entries', async () => {
    const file = await normalizeFile({
      ...emptyFile('device-a', 'store-1', 1, []),
      entries: [entry({ uuid: 'a', path: 'a.txt' })],
    });
    expect(parseHeader(encodeVFSFile(file).slice(0, 20))).toBeNull();
  });

  it('sorts by path, then by uuid', () => {
    const sorted = sortEntries([
      entry({ uuid: 'z', path: 'b.txt' }),
      entry({ uuid: 'b', path: 'a.txt' }),
      entry({ uuid: 'a', path: 'a.txt' }),
    ]);
    expect(sorted.map((item) => [item.path, item.uuid])).toEqual([
      ['a.txt', 'a'],
      ['a.txt', 'b'],
      ['b.txt', 'z'],
    ]);
  });

  it('drops falsy optionals from the canonical form', () => {
    const canonical = canonicalEntry(
      entry({ uuid: 'a', path: 'a.txt', prevPath: '', native: '', deleted: undefined }),
    );
    expect(canonical).not.toHaveProperty('prevPath');
    expect(canonical).not.toHaveProperty('native');
    expect(canonical).not.toHaveProperty('deleted');
  });
});

describe('state digest', () => {
  it('ignores everything that does not converge', async () => {
    const plain = [entry({ uuid: 'a', path: 'a.txt' })];
    const decorated = [
      entry({
        uuid: 'a',
        path: 'a.txt',
        // per-backend, per-route, per-peer: none of it may move the digest
        native: 'drive-7',
        mtime: 999,
        created: 4,
        prev: 'older',
        prevPath: 'was.txt',
        peer: 'device-b',
      }),
    ];
    expect(await stateDigest(decorated)).toBe(await stateDigest(plain));
  });

  it('ignores tombstones, which every peer prunes on its own schedule', async () => {
    const live = [entry({ uuid: 'a', path: 'a.txt' })];
    const withTombstone = [
      ...live,
      entry({ uuid: 'gone', path: 'gone.txt', hash: null, deleted: true }),
    ];
    expect(await stateDigest(withTombstone)).toBe(await stateDigest(live));
  });

  it('is order-independent but content-sensitive', async () => {
    const one = [entry({ uuid: 'a', path: 'a.txt' }), entry({ uuid: 'b', path: 'b.txt' })];
    expect(await stateDigest([...one].reverse())).toBe(await stateDigest(one));
    expect(await stateDigest([entry({ uuid: 'a', path: 'a.txt', hash: 'other' })])).not.toBe(
      await stateDigest([one[0] as VFSEntry]),
    );
  });
});

describe('commits log', () => {
  it('is one self-contained JSON object per line', () => {
    const rows = [row({ op: 'aa', uuid: 'u1' }), row({ op: 'bb', uuid: 'u2', type: 'delete' })];
    const text = decoder.decode(encodeRows(rows));
    expect(text.trim().split('\n')).toHaveLength(2);
    for (const line of text.trim().split('\n')) expect(JSON.parse(line)).toBeTruthy();
    expect(parseRows(encodeRows(rows))).toEqual(rows);
  });

  it('drops a torn trailing line instead of throwing', () => {
    const whole = decoder.decode(encodeRows([row({ op: 'aa', uuid: 'u1' })]));
    const torn = encoder.encode(`${whole}{"op":"bb","uu`);
    expect(parseRows(torn)).toHaveLength(1);
  });

  it('gives the same op id to the same operation on any replica', async () => {
    const facts = {
      at: 5,
      peer: 'device-a',
      uuid: 'u1',
      type: 'write' as const,
      kind: 'file' as const,
      path: 'a.txt',
      hash: 'h1',
    };
    expect(await opId(facts)).toBe(await opId({ ...facts }));
    // The batch groups operations for the UI; it must not change identity.
    const first = await makeRow({ ...facts, batch: 'one' });
    const second = await makeRow({ ...facts, batch: 'two' });
    expect(first.op).toBe(second.op);
    expect(await opId({ ...facts, path: 'b.txt' })).not.toBe(first.op);
  });

  it('unions by op, idempotently and regardless of order', () => {
    const one = row({ op: 'a'.repeat(64), uuid: 'u1' });
    const two = row({ op: 'b'.repeat(64), uuid: 'u2' });
    expect(unionRows([one, two], [two, one], [one])).toHaveLength(2);
    expect(missingRows([one], [one, two])).toEqual([two]);
    expect(missingRows([one, two], [one])).toEqual([]);
  });

  it('digests a set, not a sequence', () => {
    const one = row({ op: '1'.repeat(64), uuid: 'u1' });
    const two = row({ op: '2'.repeat(64), uuid: 'u2' });
    expect(xorDigest([one, two])).toBe(xorDigest([two, one]));
    expect(xorDigest([])).toBe(ZERO_DIGEST);
    expect(xorHex(xorDigest([one, two]), two.op)).toBe(one.op);
  });

  it('reads back in time order however it was written', () => {
    const late = row({ op: 'a'.repeat(64), uuid: 'u1', at: 900 });
    const early = row({ op: 'b'.repeat(64), uuid: 'u2', at: 100 });
    expect(sortRows([late, early]).map((item) => item.at)).toEqual([100, 900]);
  });
});

describe('rotation', () => {
  it('closes the segment, snapshots cumulatively and starts empty', async () => {
    const adapter = new MemoryAdapter('device-a');
    let clock = 1000;
    const store = new VFSStore(adapter, '.vfs', { now: () => (clock += 1000) });
    const file = await store.init({ peer: 'device-a', storeId: 'store-1' });

    file.entries = [entry({ uuid: 'a', path: 'a.txt' })];
    const facts = row({ op: '', uuid: 'a' });
    delete (facts as Partial<LogRow>).op;
    await store.append([await makeRow(facts)], file);
    const closing = file.log.segment;

    await store.rotate(file);
    expect(file.log.segment).toBeGreaterThan(closing);
    expect(file.log.rows).toBe(0);
    expect(file.log.digest).toBe(ZERO_DIGEST);
    expect(file.log.archives).toEqual([closing]);
    expect(await adapter.stat(`.vfs/commits-${closing}`)).not.toBeNull();
    expect((await store.readSnapshot(file)).map((item) => item.uuid)).toEqual(['a']);
  });

  it('accumulates: the snapshot keeps uuids the current tree no longer has', async () => {
    const adapter = new MemoryAdapter('device-a');
    let clock = 1000;
    const store = new VFSStore(adapter, '.vfs', { now: () => (clock += 1000) });
    const file = await store.init({ peer: 'device-a', storeId: 'store-1' });

    file.entries = [entry({ uuid: 'old', path: 'old.txt', hash: null, deleted: true })];
    await store.rotate(file);
    await store.write(file);

    // Somebody pruned the tombstone; the next rotation must not forget it.
    file.entries = [entry({ uuid: 'new', path: 'new.txt' })];
    store.invalidate();
    const reopened = new VFSStore(adapter, '.vfs', { now: () => (clock += 1000) });
    const held = await reopened.read();
    held.entries = file.entries;
    await reopened.rotate(held);

    const uuids = (await reopened.readSnapshot(held)).map((item) => item.uuid).sort();
    expect(uuids).toEqual(['new', 'old']);
  });

  it('rotates a live store once the segment outgrows its budget', async () => {
    const a = await peer('rotating', { rotateAt: 300 });
    for (let i = 0; i < 12; i++) {
      await put(a, `file-${i}.txt`, `content ${i}`);
      await a.node.commit();
    }
    const file = await a.node.file();
    expect(file.log.snapshot).toBeTypeOf('string');
    expect(file.log.size).toBeLessThan(600);
    expect(await a.fs.stat(`.vfs/${file.log.snapshot as string}`)).not.toBeNull();
  });
});

describe('extensionOf', () => {
  it('lowercases, drops the dot, and ignores dotfiles', () => {
    expect(extensionOf('a/b/gamelist.XML')).toBe('xml');
    expect(extensionOf('LICENSE')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });
});
