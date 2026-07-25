import { describe, expect, it } from 'vitest';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
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
    expect(await adapter.list('')).toEqual([
      { name: 'state', path: 'state', kind: 'directory' },
    ]);
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
