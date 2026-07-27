import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { sync } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';
import { walk } from '../src/walk.js';
import type { VFSAdapter } from '../src/types.js';
import { decoder, encoder, entryAt, files, get, peer, put } from './helpers.js';

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

  it('keeps one step of history inline, in place of a commit graph', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'v1');
    await a.node.commit();
    const first = await entryAt(a, 'notes.md');

    await put(a, 'notes.md', 'v2');
    await a.node.commit();

    expect((await entryAt(a, 'notes.md'))?.prev).toBe(first?.hash);
    const rows = await a.node.store.logRows();
    expect(rows.map((row) => row.type)).toEqual(['write', 'write']);
    expect(rows[1]?.prev).toBe(first?.hash);
  });

  it('re-reads a file the mirror can no longer vouch for', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'original');
    await a.node.commit();

    // Something wrote through the back door; the mirror is now stale, and the
    // next scan is what repairs it (§6).
    await a.fs.write('notes.md', encoder.encode('changed outside'));
    await a.node.commit();

    expect(await get(a, 'notes.md')).toBe('changed outside');
    expect((await entryAt(a, 'notes.md'))?.size).toBe('changed outside'.length);
  });
});

describe('native file ids', () => {
  /** Stands in for Google Drive, whose `fileId` is stable across renames. */
  class NativeIdAdapter extends MemoryAdapter {
    private readonly ids = new Map<string, string>();
    private next = 0;

    override async write(path: string, data: Uint8Array): Promise<void> {
      // Control files are excluded from sync, so they get no id — this keeps
      // the numbering in the assertions readable.
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

  it('records the backend id alongside the logical identity', async () => {
    const adapter = new NativeIdAdapter('drive');
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await node.write('notes.md', encoder.encode('hello'));
    await node.commit();

    const [entry] = await node.live();
    expect(entry?.native).toBe('drive-0');
    expect(entry?.uuid).not.toBe('drive-0'); // the uuid stays the logical one
  });

  it('tracks a rename with no heuristic at all', async () => {
    const adapter = new NativeIdAdapter('drive');
    const node = await VFSNode.open(adapter, { id: 'drive' });
    await node.write('notes.md', encoder.encode('hello'));
    await node.commit();
    const before = (await node.live())[0];

    // Straight to the adapter, so no rename intent is recorded anywhere.
    await adapter.rename('notes.md', 'moved.md');
    const { entries } = await node.scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      uuid: before?.uuid,
      native: 'drive-0',
      path: 'moved.md',
      prevPath: 'notes.md',
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

    const one = (await entryAt(a, 'first.txt'))?.uuid;
    const two = (await entryAt(a, 'second.txt'))?.uuid;

    await a.node.rename('first.txt', 'tmp.txt');
    await a.node.rename('second.txt', 'first.txt');
    await a.node.rename('tmp.txt', 'second.txt');

    const { entries } = await a.node.scan();
    expect(entries.find((entry) => entry.uuid === one)?.path).toBe('second.txt');
    expect(entries.find((entry) => entry.uuid === two)?.path).toBe('first.txt');
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

    // Both destinations were occupied, so apply had to park through a scratch
    // path rather than clobbering one of them.
    expect(await get(b, 'first.txt')).toBe('TWO');
    expect(await get(b, 'second.txt')).toBe('ONE');
    expect(Object.keys(files(b)).sort()).toEqual(['first.txt', 'second.txt']);
  });

  it('does not hand an old identity to a new file that reuses the name', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'original');
    await a.node.commit();
    const original = (await entryAt(a, 'notes.md'))?.uuid;

    await a.node.rename('notes.md', 'archive.md');
    await put(a, 'notes.md', 'brand new file');
    const { entries } = await a.node.scan();

    expect(entries.find((entry) => entry.path === 'archive.md')?.uuid).toBe(original);
    expect(entries.find((entry) => entry.path === 'notes.md')?.uuid).not.toBe(original);
    expect(entries.filter((entry) => entry.kind === 'file')).toHaveLength(2);
  });

  it('gives duplicate content distinct identities', async () => {
    const a = await peer('device-a');
    await put(a, 'one.txt', 'identical');
    await put(a, 'two.txt', 'identical');
    await a.node.commit();

    await a.node.delete('one.txt');
    await put(a, 'three.txt', 'identical');
    const { entries } = await a.node.scan();

    const live = entries.filter((entry) => !entry.deleted && entry.kind === 'file');
    expect(new Set(live.map((entry) => entry.uuid)).size).toBe(live.length);
    expect(live.map((entry) => entry.path).sort()).toEqual(['three.txt', 'two.txt']);
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
    expect(walked.map((file) => file.path)).toEqual(['keep.txt']);
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

    expect((await walk(adapter)).map((file) => file.path)).toEqual([
      'a/b.txt',
      'a/deep/c.txt',
      'b.txt',
    ]);
  });

  it('reports directories when asked, so empty folders can sync', async () => {
    const adapter = new MemoryAdapter('m');
    await adapter.mkdir('empty/inner');
    await adapter.write('a/b.txt', encoder.encode('x'));

    expect((await walk(adapter, { directories: true })).map((file) => file.path)).toEqual([
      'a',
      'a/b.txt',
      'empty',
      'empty/inner',
    ]);
    expect((await walk(adapter)).map((file) => file.path)).toEqual(['a/b.txt']);
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

  it('appends without rewriting the file', async () => {
    const adapter = new MemoryAdapter('m');
    await adapter.append('log', encoder.encode('one\n'));
    await adapter.append('log', encoder.encode('two\n'));
    expect(decoder.decode(await adapter.read('log'))).toBe('one\ntwo\n');
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

describe('degenerate cases', () => {
  it('survives an adapter that reports no native id', async () => {
    const adapter: VFSAdapter = Object.assign(new MemoryAdapter('partial'), {
      fileId: async () => null,
    });
    const node = await VFSNode.open(adapter, { id: 'partial' });
    await node.write('notes.md', encoder.encode('x'));
    await node.commit();

    const [entry] = await node.live();
    expect(entry?.uuid).toMatch(/\w/);
    expect(entry?.native).toBeUndefined();
  });

  it('survives a backend with no mkdir, minus the empty folders', async () => {
    const bare = new MemoryAdapter('bare');
    const adapter = Object.assign(Object.create(bare) as MemoryAdapter, { mkdir: undefined });
    const node = await VFSNode.open(adapter as VFSAdapter, { id: 'bare' });
    await node.mkdir('nowhere'); // no-op rather than a crash
    await node.write('notes.md', encoder.encode('x'));
    expect(await node.commit()).toBeTypeOf('string');
  });
});
