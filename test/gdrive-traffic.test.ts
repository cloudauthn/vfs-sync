import { describe, expect, it } from 'vitest';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { walk } from '../src/walk.js';
import { sync } from '../src/sync.js';
import { makeFakeDrive } from './fake-drive.js';
import type { FakeDrive } from './fake-drive.js';

/**
 * On Drive every call is a round trip (and a CORS preflight on top), so the
 * request count *is* the performance. These are tripwires, not golden files:
 * they assert an upper bound, so an improvement passes and a regression fails
 * with the number it regressed to. The comments say what each was before, so a
 * change that puts a round trip back is visible as exactly that.
 */
const encoder = new TextEncoder();

/** A Drive adapter over one fake drive, counting the calls it makes. */
function counted(fake: FakeDrive): { adapter: GDriveAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter = new GDriveAdapter({
    token: 'tok',
    fetch: (input, init) => {
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
      return fake.fetch(input, init);
    },
  });
  return { adapter, calls };
}

/** A folder on Drive holding a store, three files and one subfolder. */
async function driveRoot(): Promise<FakeDrive> {
  const fake = makeFakeDrive();
  const { adapter } = counted(fake);
  await adapter.write('notes.md', encoder.encode('# notes\n'));
  await adapter.write('todo.md', encoder.encode('- [ ] sync\n'));
  await adapter.write('docs/getting-started.md', encoder.encode('folders too\n'));
  const node = await VFSNode.open(adapter, { id: 'drive', reconstructBlobs: true });
  await node.commit();
  return fake;
}

describe('Drive traffic', () => {
  it('opens a root — store probe, config, walk, head commit and tree', async () => {
    const fake = await driveRoot();
    // A fresh adapter: nothing resolved, nothing cached, as on a page load.
    const { adapter, calls } = counted(fake);

    const hasStore = (await adapter.stat('.vfs'))?.kind === 'directory';
    const node = await VFSNode.open(adapter, { id: 'drive', reconstructBlobs: true });
    const files = await walk(adapter);
    const tracked = await node.headTree();

    expect(hasStore).toBe(true);
    expect(files).toHaveLength(3);
    expect(tracked.entries).toHaveLength(3);
    // Was 20: a stat that re-fetched metadata the name lookup already had, a
    // config.json read three times over, and a stat before every store read.
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it('walks a root without a stat per file', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    await walk(adapter);
    // Two folders, two list queries. Was 5: one list per folder plus a stat each
    // for three files, for sizes and times the listing had already returned.
    expect(calls).toHaveLength(2);
  });

  it('re-reads neither the head commit nor its tree on a second look', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    const node = await VFSNode.open(adapter, { id: 'drive', reconstructBlobs: true });
    await node.headTree();
    const warm = calls.length;

    await node.headTree();
    await node.headTree();
    // A hash is its content, so the commit and the tree behind it are memoized:
    // the explorer repaints (and a sync negotiates) over the same two objects.
    expect(calls.length).toBe(warm);
  });

  it('syncs a three-file root into a fresh memory peer', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    const remote = await VFSNode.open(adapter, { id: 'drive', reconstructBlobs: true });
    const local = await VFSNode.open(new MemoryAdapter('mem'), { id: 'mem' });
    // As in the app: the tab is open, so the walk has already warmed the ids the
    // sync needs. Counting from here is counting the sync itself.
    await walk(adapter);
    await remote.headTree();
    calls.length = 0;

    const result = await sync(remote, local);
    expect(result.transferred.toA + result.transferred.toB).toBe(3);
    // Was 64 for the same three blobs. What is left is the work itself: the
    // walk, one read per blob, and the writes that record the merge. It moves by
    // a call or two between runs — a store's own hashes change with its id, and
    // with them how many `objects/` buckets have to be resolved.
    expect(calls.length).toBeLessThanOrEqual(38);
  });
});
