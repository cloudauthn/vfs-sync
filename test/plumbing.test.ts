import { describe, expect, it } from 'vitest';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { HandleAdapter } from '../src/adapters/handle.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { VFSStore } from '../src/store.js';
import { makeRow } from '../src/log.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import { collect } from '../src/stream.js';
import { FakeDirectoryHandle } from './fake-handle.js';
import { decoder, encoder, peer, put } from './helpers.js';
import type { LogRow, VFSAdapter, VFSChangeFeed } from '../src/types.js';

/** The facts of one log row, minus the id `makeRow` derives from them. */
const facts = (uuid: string, at: number): Omit<LogRow, 'op'> => ({
  batch: 'b1',
  at,
  peer: 'device-a',
  uuid,
  type: 'write',
  kind: 'file',
  path: `${uuid}.txt`,
  hash: 'h',
});

/**
 * The plumbing the behavioural suites do not reach on their way past: the
 * optional adapter methods a wrapper has to forward, the header read that exists
 * for inspecting a store nobody opened, and the cold archive path of §4.
 */

describe('VFSStore.header', () => {
  /**
   * Not what `sync` uses — it drives both nodes and reconciling one needs its
   * entries anyway. This is "does this folder hold a store, and which one?",
   * answered without pulling a tree that can run to megabytes.
   */
  it('answers from a range read of the top of the file', async () => {
    const adapter = new MemoryAdapter('device-a');
    const node = await VFSNode.open(adapter, { id: 'device-a' });
    for (let i = 0; i < 200; i++) await node.write(`file-${i}.txt`, encoder.encode(`body ${i}`));
    await node.commit();

    const reads: Array<{ path: string; end?: number }> = [];
    const watched: VFSAdapter = {
      ...adapter,
      name: adapter.name,
      list: (path) => adapter.list(path),
      read: (path) => adapter.read(path),
      write: (path, data) => adapter.write(path, data),
      delete: (path) => adapter.delete(path),
      rename: (from, to) => adapter.rename(from, to),
      stat: (path) => adapter.stat(path),
      readRange: (path, range) => {
        reads.push({ path, ...(range?.end !== undefined ? { end: range.end } : {}) });
        return adapter.readRange(path, range);
      },
    };

    const cold = new VFSStore(watched);
    const header = await cold.header();

    expect(header.storeId).toBe((await node.file()).storeId);
    expect(header.state).toBe(await node.state());
    expect(header).not.toHaveProperty('entries');
    // A bounded probe, not the whole file.
    expect(reads).toHaveLength(1);
    expect(reads[0]?.end).toBeGreaterThan(0);
  });

  it('serves the header from memory once the file is in hand', async () => {
    const store = new VFSStore(new MemoryAdapter('m'));
    const file = await store.init({ peer: 'device-a' });
    expect((await store.header()).peer).toBe(file.peer);
  });

  /**
   * A header too big for the first probe — hundreds of peers — still has to come
   * back, so the probe grows before giving up and reading the file whole.
   */
  it('grows the probe rather than truncating a large header', async () => {
    const adapter = new MemoryAdapter('crowded');
    const store = new VFSStore(adapter);
    const file = await store.init({ peer: 'device-a' });
    for (let i = 0; i < 400; i++) {
      file.peers[`peer-${i}-${'x'.repeat(40)}`] = {
        lastSync: 1000 + i,
        segment: 1,
        offset: 0,
        digest: 'd'.repeat(64),
      };
    }
    await store.write(file);

    const cold = new VFSStore(adapter);
    expect(Object.keys((await cold.header()).peers)).toHaveLength(400);
  });
});

describe('cold archives', () => {
  /**
   * §4's one look backwards. The link that proves the loser is an ancestor has
   * rotated out of the active segment, so without opening the archive the sync
   * assumes a conflict and keeps a copy — the safe degradation, and exactly what
   * `archives: false` opts into.
   */
  async function laggingChain() {
    const a = await peer('device-a', { rotateAt: 200 });
    const b = await peer('device-b', { rotateAt: 200 });

    await put(a, 'notes.bin', 'v1');
    await sync(a.node, b.node);

    // A moves on while B stays put, and the link ages out of the segment.
    for (const body of ['v2', 'v3', 'v4']) {
      await put(a, 'notes.bin', body);
      await a.node.commit();
    }
    for (let i = 0; i < 6; i++) {
      await put(a, `filler-${i}.txt`, `x${i}`);
      await a.node.commit();
    }
    // B's mirror still points at v1, and A's active segment no longer explains it.
    const file = await a.node.file();
    expect(file.log.archives?.length).toBeGreaterThan(0);
    a.node.store.invalidate();
    return { a, b };
  }

  it('turns what looks like a conflict into the propagation it is', async () => {
    const { a, b } = await laggingChain();
    const result = await sync(a.node, b.node);

    expect(result.conflicts).toEqual([]);
    expect(decoder.decode(await b.node.read('notes.bin'))).toBe('v4');
    expect(Object.keys(b.fs.snapshot()).some((path) => path.includes('conflict'))).toBe(false);
  });

  it('keeps a copy instead when the caller declines the cold read', async () => {
    const { a, b } = await laggingChain();
    const result = await sync(a.node, b.node, { archives: false });

    // The state is the same either way; the cost is a copy nobody needed.
    expect(decoder.decode(await b.node.read('notes.bin'))).toBe('v4');
    expect(result.conflicts).toHaveLength(1);
  });
});

describe('ScopedAdapter forwarding', () => {
  it('re-roots the optional methods its base implements', async () => {
    const base = new MemoryAdapter('host');
    const scoped = new ScopedAdapter(base, 'projects/notes');

    await scoped.mkdir?.('deep/folder');
    expect((await base.stat('projects/notes/deep/folder'))?.kind).toBe('directory');

    await scoped.append?.('log', encoder.encode('one\n'));
    await scoped.append?.('log', encoder.encode('two\n'));
    expect(decoder.decode(await base.read('projects/notes/log'))).toBe('one\ntwo\n');
  });

  it('forwards fileId, tag and writeIf against the base path', async () => {
    const base = Object.assign(new MemoryAdapter('host'), {
      fileId: async (path: string) => `id:${path}`,
      tag: async (path: string) => `tag:${path}`,
      writeIf: async (path: string, data: Uint8Array, tag: string | null) => {
        if (tag !== null && tag !== `tag:${path}`) return null;
        await base.write(path, data);
        return `tag:${path}`;
      },
    });
    const scoped = new ScopedAdapter(base as VFSAdapter, 'inner');

    expect(await scoped.fileId?.('a.txt')).toBe('id:inner/a.txt');
    expect(await scoped.tag?.('a.txt')).toBe('tag:inner/a.txt');
    expect(await scoped.writeIf?.('a.txt', encoder.encode('x'), 'tag:inner/a.txt')).toBe(
      'tag:inner/a.txt',
    );
    expect(decoder.decode(await base.read('inner/a.txt'))).toBe('x');
    expect(await scoped.writeIf?.('a.txt', encoder.encode('y'), 'stale')).toBeNull();
  });

  /**
   * A change feed is account-wide on every backend that has one, so the wrapper
   * has to drop what falls outside its scope and re-root what does not.
   */
  it('filters and re-roots a change feed', async () => {
    const base = Object.assign(new MemoryAdapter('host'), {
      changes: async (): Promise<VFSChangeFeed> => ({
        token: 't2',
        changes: [
          { native: '1', path: 'inner/a.txt' },
          { native: '2', path: 'elsewhere/b.txt' },
          { native: '3', path: 'inner/deep/c.txt' },
          { native: '4', removed: true }, // no path: cannot be placed, so it travels
        ],
      }),
    });
    const scoped = new ScopedAdapter(base as VFSAdapter, 'inner');

    const feed = await (scoped.changes as NonNullable<VFSAdapter['changes']>)('t1');
    expect(feed.token).toBe('t2');
    expect(feed.changes.map((change) => change.path)).toEqual([
      'a.txt',
      'deep/c.txt',
      undefined,
    ]);
  });

  it('leaves the optional methods undefined when its base has none', () => {
    const bare: VFSAdapter = {
      name: 'bare',
      list: async () => [],
      read: async () => new Uint8Array(),
      write: async () => undefined,
      delete: async () => undefined,
      rename: async () => undefined,
      stat: async () => null,
    };
    const scoped = new ScopedAdapter(bare, 'x');
    expect(scoped.append).toBeUndefined();
    expect(scoped.writeIf).toBeUndefined();
    expect(scoped.tag).toBeUndefined();
    expect(scoped.changes).toBeUndefined();
  });

  it('passes everything through when the scope is the root', async () => {
    const base = new MemoryAdapter('host');
    const scoped = new ScopedAdapter(base, '');
    await scoped.write('a.txt', encoder.encode('x'));
    expect(decoder.decode(await base.read('a.txt'))).toBe('x');
    expect((await scoped.list('')).map((entry) => entry.path)).toEqual(['a.txt']);
  });
});

describe('HandleAdapter.mkdir', () => {
  it('creates an empty folder, which v2 syncs', async () => {
    const adapter = new HandleAdapter(new FakeDirectoryHandle('opfs-like') as never, 'handle');
    await adapter.mkdir('roms/megadrive');

    expect((await adapter.stat('roms/megadrive'))?.kind).toBe('directory');
    expect((await adapter.list('roms')).map((entry) => entry.name)).toEqual(['megadrive']);
  });
});

describe('Drive errors', () => {
  /** The error names the request that failed, its status, and Drive's own words. */
  it('carries the status and the message Drive sent', async () => {
    await expect(
      new GDriveAdapter({
        token: 'tok',
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      }).read('a.txt'),
    ).rejects.toThrow(/Drive 429 on .*: Rate limit exceeded/);
  });

  it('copes with a failure that carries no JSON body', async () => {
    await expect(
      new GDriveAdapter({
        token: 'tok',
        fetch: async () => new Response('gateway down', { status: 502 }),
      }).read('a.txt'),
    ).rejects.toThrow(/Drive 502 on /);
  });
});

describe('node surface', () => {
  it('exposes the ancestry it can answer from without a cold read', async () => {
    const a = await peer('device-a');
    await put(a, 'notes.md', 'v1');
    await a.node.commit();
    const first = (await a.node.live())[0];
    await put(a, 'notes.md', 'v2');
    await a.node.commit();
    const second = (await a.node.live())[0];

    const history = await a.node.history();
    expect(history.knows(second?.uuid as string)).toBe(true);
    expect(
      history.descends(second?.uuid as string, second?.hash ?? null, first?.hash ?? null),
    ).toBe(true);
    expect(history.knows('never-existed')).toBe(false);
  });

  it('classifies text by the store list, not by the bytes', async () => {
    const a = await peer('device-a');
    expect(await a.node.isText('gamelist.xml')).toBe(true);
    expect(await a.node.isText('game.rom')).toBe(false);
    expect(await a.node.isText('LICENSE')).toBe(false);
  });

  it('writes through a stream and records it on the next commit', async () => {
    const a = await peer('device-a');
    const writer = (await a.node.writeStream('generated.bin')).getWriter();
    await writer.write(encoder.encode('streamed '));
    await writer.write(encoder.encode('in two'));
    await writer.close();

    await a.node.commit();
    const entry = (await a.node.live())[0];
    expect(entry?.path).toBe('generated.bin');
    expect(entry?.size).toBe('streamed in two'.length);
    expect(decoder.decode(await collect(await a.node.readStream('generated.bin')))).toBe(
      'streamed in two',
    );
  });

  it('creates a folder even where the backend cannot', async () => {
    const bare = Object.assign(Object.create(new MemoryAdapter('bare')) as MemoryAdapter, {
      mkdir: undefined,
    });
    const node = await VFSNode.open(bare as VFSAdapter, { id: 'bare' });
    await expect(node.mkdir('nowhere')).resolves.toBeUndefined();
  });
});

describe('an auto-merged text file too big to hold', () => {
  /**
   * `streamThreshold: 1` forces the merged bytes down the streaming path, which
   * is the branch a merge result normally never takes.
   */
  it('lands through the streaming path', async () => {
    const streaming = { streamThreshold: 1 };
    const fsA = new MemoryAdapter('device-a');
    const fsB = new MemoryAdapter('device-b');
    let clock = 1_700_000_000_000;
    const now = () => (clock += 1000);
    const a = await VFSNode.open(fsA, { id: 'device-a', now, ...streaming });
    const b = await VFSNode.open(fsB, { id: 'device-b', now, ...streaming });

    await a.write('list.xml', encoder.encode('<one/>\n<two/>\n<three/>\n'));
    await sync(a, b);

    await a.write('list.xml', encoder.encode('<ONE/>\n<two/>\n<three/>\n'));
    await a.commit();
    await b.write('list.xml', encoder.encode('<one/>\n<two/>\n<THREE/>\n'));
    const result = await sync(a, b);

    expect(result.merged).toBe(1);
    expect(decoder.decode(await b.read('list.xml'))).toBe('<ONE/>\n<two/>\n<THREE/>\n');
    expect(fsA.snapshot()).toEqual(fsB.snapshot());
  });
});

describe('appending without a native append', () => {
  /**
   * Drive's shape: no `append`, but a conditional write. §3's check-then-act
   * becomes a race somebody actually wins, and the loser re-reads and folds in
   * on top rather than clobbering what landed.
   */
  function conditional(
    base: MemoryAdapter,
    sabotage?: (self: VFSAdapter) => Promise<void>,
  ): VFSAdapter {
    const tags = new Map<string, number>();
    const wrapper: VFSAdapter = {
      name: base.name,
      list: (path) => base.list(path),
      read: (path) => base.read(path),
      delete: (path) => base.delete(path),
      rename: (from, to) => base.rename(from, to),
      stat: (path) => base.stat(path),
      write: async (path, data) => {
        tags.set(path, (tags.get(path) ?? 0) + 1);
        await base.write(path, data);
      },
      readRange: (path, range) => base.readRange(path, range),
      tag: async (path) => (tags.has(path) ? `v${tags.get(path)}` : null),
      writeIf: async (path, data, tag) => {
        // Whoever is going to interfere does it here — in the window between
        // reading the tag and writing against it.
        await sabotage?.(wrapper);
        const current = tags.has(path) ? `v${tags.get(path)}` : null;
        if (tag !== current) return null;
        tags.set(path, (tags.get(path) ?? 0) + 1);
        await base.write(path, data);
        return `v${tags.get(path)}`;
      },
    };
    return wrapper;
  }

  it('extends the log through the conditional write', async () => {
    const base = new MemoryAdapter('drive-like');
    const store = new VFSStore(conditional(base));
    const file = await store.init({ peer: 'device-a' });

    await store.append([await makeRow({ ...facts('u1', 100) })], file);
    await store.append([await makeRow({ ...facts('u2', 200) })], file);

    expect(file.log.rows).toBe(2);
    expect(decoder.decode(await base.read('.vfs/commits')).trim().split('\n')).toHaveLength(2);
  });

  it('re-reads and folds in when it loses the race', async () => {
    const base = new MemoryAdapter('drive-like');
    // Somebody else lands a row in the window between the tag and the write.
    let sabotaged = false;
    const adapter = conditional(base, async (self) => {
      if (sabotaged) return;
      sabotaged = true;
      await self.write('.vfs/commits', encoder.encode('{"op":"other","uuid":"u9"}\n'));
    });
    const store = new VFSStore(adapter);
    const file = await store.init({ peer: 'device-a' });

    await store.append([await makeRow({ ...facts('u1', 100) })], file);

    const written = decoder.decode(await base.read('.vfs/commits'));
    expect(written).toContain('"uuid":"u9"');   // the other writer survived
    expect(written).toContain('"uuid":"u1"');   // and so did ours
  });
});

describe('memoised store reads', () => {
  it('serves a snapshot and an archive from memory the second time', async () => {
    const a = await peer('device-a', { rotateAt: 200 });
    for (let i = 0; i < 10; i++) {
      await put(a, `file-${i}.txt`, `body ${i}`);
      await a.node.commit();
    }
    const file = await a.node.file();
    const segment = (file.log.archives ?? [])[0] as number;
    expect(segment).toBeTypeOf('number');

    const reads: string[] = [];
    const original = a.fs.read.bind(a.fs);
    a.fs.read = async (path: string) => {
      reads.push(path);
      return original(path);
    };

    await a.node.store.readSnapshot(file);
    await a.node.store.readArchive(segment);
    const cold = reads.length;
    // Both are immutable, so what came back once is kept.
    await a.node.store.readSnapshot(file);
    await a.node.store.readArchive(segment);
    expect(reads.length).toBe(cold);

    a.fs.read = original;
  });

  it('reports an archive that has been deleted as nothing at all', async () => {
    const store = new VFSStore(new MemoryAdapter('m'));
    await store.init({ peer: 'device-a' });
    expect(await store.readArchive(1_700_000_000_000)).toEqual([]);
  });
});
