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
