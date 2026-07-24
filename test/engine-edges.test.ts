import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { sync } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import { walk } from '../src/walk.js';
import type { VFSAdapter } from '../src/types.js';
import { files, get, peer, put } from './helpers.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('VFSNode basics', () => {
  it('exposes the backend name', async () => {
    const node = await VFSNode.open(new MemoryAdapter('device-a'), { id: 'a' });
    expect(node.name).toBe('device-a');
  });

  it('generates and persists an id when none is given', async () => {
    const adapter = new MemoryAdapter('anon');
    const first = await VFSNode.open(adapter);
    const second = await VFSNode.open(adapter);

    expect(first.id).toMatch(/\w/);
    expect(second.id).toBe(first.id);
  });

  it('walks history through first parents', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'v1');
    await a.node.commit();
    await put(a, 'notes.md', 'v2');
    await a.node.commit();

    const log = await a.node.log();
    expect(log).toHaveLength(2);
    expect(log[0]?.parents).toEqual([log[1]?.hash]);
    expect(log[1]?.parents).toEqual([]);
    expect(await a.node.log(1)).toHaveLength(1);
  });

  it('restores a blob that went missing from the object store', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'recoverable');
    const tree = await a.node.scan();
    const hash = tree.entries[0]?.hash as string;

    // the cache still vouches for the file, but the object is gone
    await a.fs.delete(`.vfs/objects/${hash.slice(0, 2)}/${hash}`);
    expect(await a.node.store.hasObject(hash)).toBe(false);

    await a.node.scan();
    expect(decoder.decode(await a.node.store.getObject(hash))).toBe('recoverable');
  });
});

describe('native file ids', () => {
  /** Stands in for Google Drive, whose `fileId` is stable across renames. */
  class NativeIdAdapter extends MemoryAdapter {
    private readonly ids = new Map<string, string>();
    private next = 0;

    override async write(path: string, data: Uint8Array): Promise<void> {
      // control files are excluded from sync, so they get no id — this keeps
      // the numbering in the assertions readable
      if (!path.startsWith('.vfs') && !this.ids.has(path)) {
        this.ids.set(path, `drive-${this.next++}`);
      }
      await super.write(path, data);
    }

    override async rename(from: string, to: string): Promise<void> {
      const id = this.ids.get(from);
      if (id) {
        this.ids.delete(from);
        this.ids.set(to, id); // the id follows the file, as Drive's does
      }
      await super.rename(from, to);
    }

    async fileId(path: string): Promise<string | null> {
      return this.ids.get(path) ?? null;
    }
  }

  it('uses the backend id instead of a synthetic one', async () => {
    const adapter = new NativeIdAdapter('drive');
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await node.write('notes.md', encoder.encode('hello'));

    const tree = await node.scan();
    expect(tree.entries[0]?.id).toBe('drive-0');
  });

  it('tracks a rename with no heuristic at all', async () => {
    const adapter = new NativeIdAdapter('drive');
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await node.write('notes.md', encoder.encode('hello'));
    await node.commit();

    // straight to the adapter, so no rename intent is recorded anywhere
    await adapter.rename('notes.md', 'moved.md');
    const tree = await node.scan();

    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]).toMatchObject({
      id: 'drive-0',
      path: 'moved.md',
      renamedFrom: 'notes.md',
    });
  });
});

describe('tricky renames', () => {
  it('follows identities through a swap', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'first.txt', 'ONE');
    await put(a, 'second.txt', 'TWO');
    await sync(a.node, b.node);

    const before = await a.node.headTree();
    const idOfOne = before.entries.find((e) => e.path === 'first.txt')?.id;
    const idOfTwo = before.entries.find((e) => e.path === 'second.txt')?.id;

    await a.node.rename('first.txt', 'tmp.txt');
    await a.node.rename('second.txt', 'first.txt');
    await a.node.rename('tmp.txt', 'second.txt');

    const after = await a.node.scan();
    expect(after.entries.find((e) => e.id === idOfOne)?.path).toBe('second.txt');
    expect(after.entries.find((e) => e.id === idOfTwo)?.path).toBe('first.txt');
  });

  it('applies a swap on the other peer without losing either file', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'first.txt', 'ONE');
    await put(a, 'second.txt', 'TWO');
    await sync(a.node, b.node);

    await a.node.rename('first.txt', 'tmp.txt');
    await a.node.rename('second.txt', 'first.txt');
    await a.node.rename('tmp.txt', 'second.txt');
    await sync(a.node, b.node);

    // both destinations were occupied, so applyTree had to park through a
    // scratch path rather than clobbering one of them
    expect(await get(b, 'first.txt')).toBe('TWO');
    expect(await get(b, 'second.txt')).toBe('ONE');
    expect(Object.keys(files(b)).sort()).toEqual(['first.txt', 'second.txt']);
  });

  it('does not hand an old identity to a new file that reuses the name', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'original');
    await a.node.commit();
    const originalId = (await a.node.headTree()).entries[0]?.id;

    await a.node.rename('notes.md', 'archive.md');
    await put(a, 'notes.md', 'brand new file');
    const tree = await a.node.scan();

    expect(tree.entries.find((e) => e.path === 'archive.md')?.id).toBe(originalId);
    expect(tree.entries.find((e) => e.path === 'notes.md')?.id).not.toBe(originalId);
    expect(tree.entries).toHaveLength(2);
  });

  it('gives duplicate content distinct identities', async () => {
    const a = await peer('device-a');
    await put(a, 'one.txt', 'identical');
    await put(a, 'two.txt', 'identical');
    await a.node.commit();

    await a.node.delete('one.txt');
    await put(a, 'three.txt', 'identical');
    const tree = await a.node.scan();

    const live = tree.entries.filter((e) => !e.deleted);
    expect(new Set(live.map((e) => e.id)).size).toBe(live.length);
    expect(live.map((e) => e.path).sort()).toEqual(['three.txt', 'two.txt']);
  });
});

describe('walk', () => {
  it('honours an ignore predicate', async () => {
    const adapter = new MemoryAdapter('m');
    await adapter.write('keep.txt', encoder.encode('x'));
    await adapter.write('build/output.js', encoder.encode('x'));
    await adapter.write('notes.tmp', encoder.encode('x'));

    const walked = await walk(adapter, {
      ignore: (path) => path === 'build' || path.endsWith('.tmp'),
    });
    expect(walked.map((f) => f.path)).toEqual(['keep.txt']);
  });

  it('keeps ignored paths out of sync entirely', async () => {
    const ignore = (path: string) => path.startsWith('cache');
    const a = await VFSNode.open(new MemoryAdapter('device-a'), { id: 'a', ignore });
    const b = await VFSNode.open(new MemoryAdapter('device-b'), { id: 'b', ignore });

    await a.write('shared.txt', encoder.encode('shared'));
    await a.write('cache/huge.bin', encoder.encode('local only'));
    await sync(a, b);

    expect(await b.adapter.stat('shared.txt')).not.toBeNull();
    expect(await b.adapter.stat('cache/huge.bin')).toBeNull();
    expect(await a.adapter.stat('cache/huge.bin')).not.toBeNull();
  });

  it('returns files sorted, depth included', async () => {
    const adapter = new MemoryAdapter('m');
    await adapter.write('b.txt', encoder.encode('x'));
    await adapter.write('a/deep/c.txt', encoder.encode('x'));
    await adapter.write('a/b.txt', encoder.encode('x'));

    expect((await walk(adapter)).map((f) => f.path)).toEqual([
      'a/b.txt',
      'a/deep/c.txt',
      'b.txt',
    ]);
  });
});

describe('MemoryAdapter specifics', () => {
  it('accepts seed files in the constructor', async () => {
    const adapter = new MemoryAdapter('seeded', {
      files: { 'a.txt': 'text value', 'dir/b.bin': new Uint8Array([1, 2, 3]) },
    });

    expect(decoder.decode(await adapter.read('a.txt'))).toBe('text value');
    expect(await adapter.read('dir/b.bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(adapter.snapshot()['a.txt']).toBe('text value');
  });

  it('renames a whole directory', async () => {
    const adapter = new MemoryAdapter('m', {
      files: { 'src/a.txt': 'A', 'src/deep/b.txt': 'B', 'other.txt': 'O' },
    });

    await adapter.rename('src', 'lib');
    expect(adapter.snapshot()).toEqual({
      'lib/a.txt': 'A',
      'lib/deep/b.txt': 'B',
      'other.txt': 'O',
    });
  });

  it('deletes a whole directory', async () => {
    const adapter = new MemoryAdapter('m', { files: { 'src/a.txt': 'A', 'keep.txt': 'K' } });
    await adapter.delete('src');
    expect(adapter.snapshot()).toEqual({ 'keep.txt': 'K' });
  });

  it('hides the control folder from snapshots', async () => {
    const adapter = new MemoryAdapter('m');
    const node = await VFSNode.open(adapter, { id: 'm' });
    await node.write('visible.txt', encoder.encode('x'));
    await node.commit();

    expect(Object.keys(adapter.snapshot())).toEqual(['visible.txt']);
  });

  it('allows a forced mtime for scripting clock skew', async () => {
    const adapter = new MemoryAdapter('m', { files: { 'a.txt': 'x' } });
    adapter.setMtime('a.txt', 4242);
    expect((await adapter.stat('a.txt'))?.mtime).toBe(4242);
    adapter.setMtime('missing.txt', 1); // no-op, must not throw
  });
});

describe('degenerate syncs', () => {
  it('does nothing when both peers are empty', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');

    const result = await sync(a.node, b.node);
    expect(result).toMatchObject({ base: null, head: null, changed: false, conflicts: [] });
    expect(await a.node.head()).toBeNull();
  });

  it('syncs a peer with itself as a no-op', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'v1');

    const result = await sync(a.node, a.node);
    expect(result.conflicts).toHaveLength(0);
    expect(await get(a, 'notes.md')).toBe('v1');
  });

  it('reports blob transfers in the direction they happened', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'one.txt', 'A1');
    await put(a, 'two.txt', 'A2');

    const result = await sync(a.node, b.node);
    expect(result.transferred).toEqual({ toA: 0, toB: 2 });
  });

  it('survives an adapter that reports no native id', async () => {
    const adapter: VFSAdapter = Object.assign(new MemoryAdapter('partial'), {
      fileId: async () => null,
    });
    const node = await VFSNode.open(adapter, { id: 'partial' });
    await node.write('notes.md', encoder.encode('x'));

    const tree = await node.scan();
    expect(tree.entries[0]?.id).toMatch(/\w/);
  });
});
