import { describe, expect, it } from 'vitest';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import { walk } from '../src/walk.js';
import { makeFakeDrive } from './fake-drive.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function drive(overrides = {}) {
  const fake = makeFakeDrive();
  return { adapter: new GDriveAdapter({ token: 'tok', fetch: fake.fetch, ...overrides }), fake };
}

describe('GDriveAdapter', () => {
  it('assigns a stable fileId that survives a rename', async () => {
    const { adapter } = drive();
    await adapter.write('notes/a.txt', encoder.encode('hi'));
    const before = await adapter.fileId('notes/a.txt');
    expect(before).toBeTruthy();

    await adapter.rename('notes/a.txt', 'notes/b.txt');
    expect(await adapter.fileId('notes/a.txt')).toBeNull();
    expect(await adapter.fileId('notes/b.txt')).toBe(before);
    expect(decoder.decode(await adapter.read('notes/b.txt'))).toBe('hi');
  });

  it('keeps the id when moving across folders', async () => {
    const { adapter } = drive();
    await adapter.write('src/x.txt', encoder.encode('data'));
    const id = await adapter.fileId('src/x.txt');
    await adapter.rename('src/x.txt', 'dst/deep/x.txt');
    expect(await adapter.fileId('dst/deep/x.txt')).toBe(id);
    expect(await adapter.list('src')).toEqual([]);
  });

  it('calls the token provider on every request', async () => {
    let calls = 0;
    const { adapter } = drive({
      token: async () => {
        calls += 1;
        return 'fresh';
      },
    });
    await adapter.write('f.txt', encoder.encode('x'));
    await adapter.read('f.txt');
    expect(calls).toBeGreaterThan(1);
  });

  it('sends the bearer token it is given', async () => {
    const seen: string[] = [];
    const fake = makeFakeDrive();
    const wrapped: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get('Authorization') ?? '');
      return fake.fetch(input, init);
    };
    const adapter = new GDriveAdapter({ token: 'secret', fetch: wrapped });
    await adapter.write('f.txt', encoder.encode('x'));
    expect(seen.every((h) => h === 'Bearer secret')).toBe(true);
  });

  it('skips the redundant existence check when a stat just found the file absent', async () => {
    const seen: string[] = [];
    const fake = makeFakeDrive();
    const wrapped: typeof fetch = (input, init) => {
      seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return fake.fetch(input, init);
    };
    const adapter = new GDriveAdapter({ token: 'tok', fetch: wrapped });
    await adapter.mkdir('objects'); // parent exists and is cached

    // This is the store's `hasObject` → `putObjectAt` pattern: stat, then write.
    seen.length = 0;
    expect(await adapter.stat('objects/x')).toBeNull();
    const afterStat = seen.length;
    await adapter.write('objects/x', encoder.encode('data'));
    const writeReqs = seen.length - afterStat;

    // The write only creates: POST metadata + media upload. No second name
    // query, because the stat already established the file was not there.
    expect(writeReqs).toBe(2);
    expect(seen.slice(afterStat).some((u) => u.includes('pageSize=1'))).toBe(false);
    expect(decoder.decode(await adapter.read('objects/x'))).toBe('data');
  });

  it('works in the hidden appDataFolder space', async () => {
    const seen: string[] = [];
    const fake = makeFakeDrive();
    const wrapped: typeof fetch = (input, init) => {
      seen.push(String(input));
      return fake.fetch(input, init);
    };
    const adapter = new GDriveAdapter({ token: 'tok', fetch: wrapped, space: 'appDataFolder' });

    await adapter.write('state/head.json', encoder.encode('{}'));
    expect(decoder.decode(await adapter.read('state/head.json'))).toBe('{}');
    // Listing queries are scoped to the app-data space, not the visible drive.
    const listings = seen.filter((u) => u.includes('spaces='));
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((u) => u.includes('spaces=appDataFolder'))).toBe(true);
    // The tree is anchored at the special appDataFolder root, not 'root'.
    expect(await adapter.list('')).toMatchObject([
      { name: 'state', path: 'state', kind: 'directory' },
    ]);
  });

  it('lists with sizes and times attached, so a walk needs no stat per file', async () => {
    let requests = 0;
    const fake = makeFakeDrive();
    const adapter = new GDriveAdapter({
      token: 'tok',
      fetch: (input, init) => {
        requests += 1;
        return fake.fetch(input, init);
      },
    });
    await adapter.write('a.md', encoder.encode('aaa'));
    await adapter.write('b.md', encoder.encode('bbbbb'));
    await adapter.write('sub/c.md', encoder.encode('cc'));

    requests = 0;
    const files = await walk(adapter);
    expect(files.map((file) => [file.path, file.stat.size])).toEqual([
      ['a.md', 3],
      ['b.md', 5],
      ['sub/c.md', 2],
    ]);
    // Two folders, so two list queries — and not a single stat on top of them.
    expect(requests).toBe(2);
  });

  it('syncs end-to-end with a memory peer', async () => {
    const { adapter } = drive();
    const remote = await VFSNode.open(adapter, { id: 'drive' });
    const local = await VFSNode.open(new MemoryAdapter('local'), { id: 'local' });

    await adapter.write('doc.md', encoder.encode('# from drive'));
    await remote.commit();
    await sync(local, remote);

    const memory = local.adapter as MemoryAdapter;
    expect(memory.snapshot()['doc.md']).toBe('# from drive');
  });
});

describe('conditional writes', () => {
  it('lands when the tag still matches, and refuses when it does not', async () => {
    const { adapter } = drive();
    await adapter.write('log', encoder.encode('one\n'));

    const tag = await adapter.tag('log');
    expect(tag).toBeTruthy();
    expect(await adapter.writeIf('log', encoder.encode('one\ntwo\n'), tag)).toBeTruthy();
    expect(decoder.decode(await adapter.read('log'))).toBe('one\ntwo\n');

    // Somebody else got there first: the stale tag no longer matches.
    expect(await adapter.writeIf('log', encoder.encode('clobbered'), tag)).toBeNull();
    expect(decoder.decode(await adapter.read('log'))).toBe('one\ntwo\n');
  });

  it('creates a missing file only when no tag was demanded', async () => {
    const { adapter } = drive();
    expect(await adapter.writeIf('fresh', encoder.encode('x'), '"nope"')).toBeNull();
    expect(await adapter.stat('fresh')).toBeNull();

    expect(await adapter.writeIf('fresh', encoder.encode('x'), null)).toBeTruthy();
    expect(decoder.decode(await adapter.read('fresh'))).toBe('x');
  });
});

describe('the changes feed', () => {
  it('reports what moved since the token, in one request', async () => {
    const { adapter } = drive();
    await adapter.write('a.md', encoder.encode('one'));

    const { token, changes } = await adapter.changes(null);
    expect(changes).toEqual([]); // a baseline, not an enumeration

    await adapter.write('b.md', encoder.encode('two'));
    await adapter.write('a.md', encoder.encode('one, edited'));

    const feed = await adapter.changes(token);
    expect(feed.reset).toBeUndefined();
    expect(feed.changes.map((change) => change.path).sort()).toEqual(['a.md', 'b.md']);
    expect(feed.changes.every((change) => change.removed === undefined)).toBe(true);
    expect(feed.token).not.toBe(token);
  });

  it('reports a delete as removed', async () => {
    const { adapter } = drive();
    await adapter.write('gone.md', encoder.encode('x'));
    const { token } = await adapter.changes(null);
    await adapter.delete('gone.md');

    const feed = await adapter.changes(token);
    expect(feed.changes).toHaveLength(1);
    expect(feed.changes[0]?.removed).toBe(true);
  });

  it('asks for a full walk instead of guessing when the token expired', async () => {
    const { adapter, fake } = drive();
    await adapter.write('a.md', encoder.encode('one'));
    const { token } = await adapter.changes(null);

    fake.expireToken();
    const feed = await adapter.changes(token);
    expect(feed.reset).toBe(true);
    expect(feed.changes).toEqual([]);
    // A fresh token comes back, so the caller can walk once and carry on.
    expect(feed.token).toBeTruthy();
    expect((await adapter.changes(feed.token)).reset).toBeUndefined();
  });
});

describe('a node over the feed', () => {
  it('has no baseline the first time, and answers from the feed afterwards', async () => {
    const { adapter } = drive();
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await adapter.write('a.md', encoder.encode('one'));
    await node.commit();

    // No token yet: the caller has to walk, and that walk *is* the baseline.
    expect(await node.externalChanges()).toBeNull();
    // Nothing has happened since, and our own writes do not count as external.
    expect(await node.externalChanges()).toEqual([]);

    // Something writes around the engine — the Drive web UI, another client.
    await adapter.write('a.md', encoder.encode('edited elsewhere'));
    expect(await node.externalChanges()).toEqual(['a.md']);
  });

  it('ignores the control folder and anything the node was told to skip', async () => {
    const { adapter } = drive();
    const node = await VFSNode.open(adapter, {
      id: 'drive',
      ignore: (path) => path.startsWith('cache'),
    });
    await adapter.write('a.md', encoder.encode('one'));
    await node.commit();
    await node.externalChanges();

    await adapter.write('cache/huge.bin', encoder.encode('local only'));
    await node.commit(); // writes .vfs/vfs.json and .vfs/commits

    expect(await node.externalChanges()).toEqual([]);
  });
});
