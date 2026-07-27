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
 * with the number it regressed to. The comments say what v1 cost, so a change
 * that puts a round trip back is visible as exactly that.
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
  const node = await VFSNode.open(adapter, { id: 'drive' });
  await node.commit();
  return fake;
}

describe('Drive traffic', () => {
  /**
   * The single biggest saving of the redesign: the tree is `vfs.json`, so
   * painting a folder is a read, not a listing per folder plus one per hash
   * bucket.
   */
  it('paints a root from one read', async () => {
    const fake = await driveRoot();
    // A fresh adapter: nothing resolved, nothing cached, as on a page load.
    const { adapter, calls } = counted(fake);

    const node = await VFSNode.open(adapter, { id: 'drive' });
    const tracked = await node.live();

    expect(tracked.filter((entry) => entry.kind === 'file')).toHaveLength(3);
    // Was 11 for the same folder in v1 (a walk, the config, the head commit,
    // its tree, and a bucket resolve per object). What is left is resolving
    // `.vfs/vfs.json` and reading it.
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('walks a root without a stat per file', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    await walk(adapter);
    // Two folders, two list queries. Was 5: one list per folder plus a stat each
    // for three files, for sizes and times the listing had already returned.
    expect(calls).toHaveLength(2);
  });

  it('does not go back to the network to repaint', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await node.live();
    const warm = calls.length;

    await node.live();
    await node.live();
    expect(calls.length).toBe(warm);
  });

  /**
   * The quiet edge of §5: one range read of the peer's header, one digest
   * comparison, done. `entries` is never fetched, however big it gets.
   */
  it('settles a quiet sync on the headers', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    const remote = await VFSNode.open(adapter, { id: 'drive' });
    const local = await VFSNode.open(new MemoryAdapter('mem'), { id: 'mem' });
    await sync(remote, local);
    calls.length = 0;

    const second = await sync(remote, local);
    expect(second.changed).toBe(false);
    // Was ~10 in v1: two commits, an ancestor negotiation and a config write on
    // each side. What is left is the walk that reconciles the mirror against
    // the disk, which is obligatory whatever the protocol.
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('syncs a three-file root into a fresh memory peer', async () => {
    const fake = await driveRoot();
    const { adapter, calls } = counted(fake);
    const remote = await VFSNode.open(adapter, { id: 'drive' });
    const local = await VFSNode.open(new MemoryAdapter('mem'), { id: 'mem' });
    // As in the app: the tab is open, so the walk has already warmed the ids the
    // sync needs. Counting from here is counting the sync itself.
    await walk(adapter);
    await remote.live();
    calls.length = 0;

    const result = await sync(remote, local);
    expect(result.transferred.toA + result.transferred.toB).toBe(3);
    // Was 64 for the same three files in v1, against a budget of 38. What is
    // left is the walk, one read per file, and the writes that record the
    // result — no object store, no commits, no known-commits log, and no stat
    // of an entry this sync did not touch.
    expect(calls.length).toBeLessThanOrEqual(14);
  });
});
