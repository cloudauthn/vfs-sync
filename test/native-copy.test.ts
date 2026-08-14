import { describe, expect, it, vi } from 'vitest';
import { GDriveAdapter } from '../src/adapters/gdrive.js';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter, unscope } from '../src/adapters/scoped.js';
import { VFSNode, holds } from '../src/vfs-node.js';
import { makeFakeDrive } from './fake-drive.js';
import { decoder, encoder, settle, sync, tick } from './helpers.js';
import type { MockInstance } from 'vitest';
import type { Hash, VFSAdapter, VFSEntry } from '../src/types.js';

/**
 * The native transfer fast path: two folders *inside one backend* copy without
 * the bytes leaving it.
 *
 * The topology under test is the realistic one — two `ScopedAdapter`s over one
 * `MemoryAdapter`, which is a Drive with two folders in it, without a Drive.
 * Every assertion is about bytes that did *not* move, so the tests spy on the
 * shared backend rather than on the nodes.
 */

/** Every method that could move payload bytes through this process. */
const MOVERS = ['read', 'write', 'readRange', 'readStream', 'writeStream'] as const;

/**
 * Records which paths the backend was asked to move bytes for.
 *
 * A pass-through wrapper cannot be used: `unscope()` stops at the adapter that
 * really holds the bytes, and a proxy is not that adapter — it would suppress
 * the very fast path under test. Spying leaves identity intact.
 */
function watch(fs: MemoryAdapter): { touched: () => string[]; reset: () => void } {
  const spies = MOVERS.map((name) => vi.spyOn(fs, name));
  return {
    touched: () =>
      spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).filter(payload),
    reset: () => spies.forEach((spy) => spy.mockClear()),
  };
}

/** The control folder is chatty and uninteresting; only payload paths count. */
function payload(path: string): boolean {
  return !path.includes('.vfs');
}

interface Twin {
  fs: MemoryAdapter;
  a: VFSNode;
  b: VFSNode;
  copies: MockInstance<MemoryAdapter['copyFrom']>;
  bytes: ReturnType<typeof watch>;
  /**
   * Commits and clears the tallies, so what follows measures the transfer
   * alone. Without it the scan's own hashing read counts as bytes moving
   * through the process and every assertion below means nothing.
   */
  ready(): Promise<void>;
}

/**
 * Two folders in one backend, each with its own store.
 *
 * The spies go on *before* the views are built, and that is not fussiness:
 * `ScopedAdapter` binds its base's optional methods once, in its constructor, so
 * a spy installed afterwards is bound around and never sees a call. A fixture
 * that got this wrong reported the fast path as never firing.
 */
async function twoFolders(): Promise<Twin> {
  const fs = new MemoryAdapter('one-backend', { clock: () => tick() });
  const copies = vi.spyOn(fs, 'copyFrom');
  const bytes = watch(fs);
  const a = await VFSNode.open(new ScopedAdapter(fs, 'folder-a'), { id: 'a', now: () => tick() });
  const b = await VFSNode.open(new ScopedAdapter(fs, 'folder-b'), { id: 'b', now: () => tick() });
  return {
    fs,
    a,
    b,
    copies,
    bytes,
    async ready() {
      await a.commit();
      await b.commit();
      bytes.reset();
      copies.mockClear();
    },
  };
}

describe('native transfer', () => {
  it('moves a file between two folders of one backend without reading it', async () => {
    const twin = await twoFolders();
    await twin.a.write('rom.bin', encoder.encode('a payload worth not moving'));
    await twin.ready();

    await sync(twin.a, twin.b);

    expect(twin.bytes.touched()).toEqual([]);
    expect(twin.copies).toHaveBeenCalledTimes(1);
    expect(decoder.decode(await twin.b.read('rom.bin'))).toBe('a payload worth not moving');
  });

  it('copies the bytes for real, not just the entry', async () => {
    const twin = await twoFolders();
    await twin.a.write('deep/nested/note.md', encoder.encode('hello'));
    await twin.ready();

    await sync(twin.a, twin.b);

    // Through the adapter, not the node: the file has to exist on disk at the
    // path the tree claims, under a parent that was created for it.
    expect(decoder.decode(await twin.b.adapter.read('deep/nested/note.md'))).toBe('hello');
    expect(await twin.a.state()).toBe(await twin.b.state());
  });

  it('pumps between two separate backends, and lands the same result', async () => {
    const one = new MemoryAdapter('one', { clock: () => tick() });
    const two = new MemoryAdapter('two', { clock: () => tick() });
    const spy = watch(one);
    const a = await VFSNode.open(one, { id: 'a', now: () => tick() });
    const b = await VFSNode.open(two, { id: 'b', now: () => tick() });
    await a.write('notes.md', encoder.encode('across'));
    await a.commit();
    spy.reset();

    await sync(a, b);

    // Different `backendId`, so the bytes travel the ordinary way.
    expect(spy.touched()).toContain('notes.md');
    expect(decoder.decode(await b.read('notes.md'))).toBe('across');
  });

  it('syncs identically over a backend that implements neither method', async () => {
    const fs = new MemoryAdapter('plain', { clock: () => tick() });
    // Exposes only the required surface — no `backendId`, no `copyFrom`.
    const bare: VFSAdapter = {
      name: 'bare',
      list: (path) => fs.list(path),
      read: (path) => fs.read(path),
      write: (path, data) => fs.write(path, data),
      delete: (path) => fs.delete(path),
      rename: (from, to) => fs.rename(from, to),
      stat: (path) => fs.stat(path),
      mkdir: (path) => fs.mkdir(path),
    };
    const a = await VFSNode.open(new ScopedAdapter(bare, 'a'), { id: 'a', now: () => tick() });
    const b = await VFSNode.open(new ScopedAdapter(bare, 'b'), { id: 'b', now: () => tick() });
    await a.write('notes.md', encoder.encode('plain'));

    await sync(a, b);

    expect(decoder.decode(await b.read('notes.md'))).toBe('plain');
    expect(await a.state()).toBe(await b.state());
  });

  it('takes no fast path when the backend will not identify itself', async () => {
    const fs = new MemoryAdapter('shy', { clock: () => tick() });
    // Same object on both sides, so a copy would certainly work — but an
    // adapter answering `null` is saying "do not assume", and it is obeyed.
    vi.spyOn(fs, 'backendId').mockResolvedValue(null);
    const copies = vi.spyOn(fs, 'copyFrom');
    const a = await VFSNode.open(new ScopedAdapter(fs, 'a'), { id: 'a', now: () => tick() });
    const b = await VFSNode.open(new ScopedAdapter(fs, 'b'), { id: 'b', now: () => tick() });
    await a.write('notes.md', encoder.encode('shy'));

    await sync(a, b);

    expect(copies).not.toHaveBeenCalled();
    expect(decoder.decode(await b.read('notes.md'))).toBe('shy');
  });

  it('falls back to pumping when the copy reports the wrong size', async () => {
    const twin = await twoFolders();
    await twin.a.write('notes.md', encoder.encode('recoverable'));
    await twin.ready();
    // A backend that copies and then lies about what landed. The engine cannot
    // tell this from a truncated copy, and treats both the same way: throw the
    // copy away and move the bytes the slow, verified way.
    twin.copies.mockImplementation(async (source, from, to) => {
      await MemoryAdapter.prototype.copyFrom.call(twin.fs, source, from, to);
      return 99_999;
    });

    await sync(twin.a, twin.b);

    expect(twin.bytes.touched()).toContain('folder-a/notes.md');
    expect(decoder.decode(await twin.b.read('notes.md'))).toBe('recoverable');
    expect(await twin.a.state()).toBe(await twin.b.state());
  });

  it('leaves nothing behind at the destination when it falls back', async () => {
    const twin = await twoFolders();
    await twin.a.write('notes.md', encoder.encode('clean'));
    await twin.ready();
    // Copies the wrong bytes *and* reports a size that gives it away. The
    // fallback has to remove them, or the pump writes over a file already there.
    twin.copies.mockImplementation(async (_source, _from, to) => {
      await twin.fs.write(to, encoder.encode('rubbish'));
      return 7;
    });

    await sync(twin.a, twin.b);

    expect(decoder.decode(await twin.b.read('notes.md'))).toBe('clean');
  });

  it('stages a conflict copy natively, inside the one folder', async () => {
    const twin = await twoFolders();
    await twin.a.write('shared.bin', encoder.encode(' a-side'));
    await sync(twin.a, twin.b);
    await twin.a.write('shared.bin', encoder.encode(' edited by a'));
    await twin.b.write('shared.bin', encoder.encode(' edited by b'));
    await twin.ready();

    await settle(twin.a, twin.b, { action: 'keep-both' });

    // Site two of the plan: staging the parked copy is intra-adapter by
    // construction, so it goes native without any identity question.
    expect(twin.copies.mock.calls.length).toBeGreaterThan(0);
  });
});

/**
 * `origin` is a promise, not a coordinate, so the tests that matter are about
 * when the holder refuses to make it.
 *
 * These drive `holds()` directly. Going through `sync()` cannot reach the
 * guard: a pass commits first, so anything done to the file beforehand is seen
 * by the scan and adopted as an ordinary edit — the drift the guard exists for
 * only opens *after* the commit, inside one pass.
 */
describe('the promise `origin` makes', () => {
  async function held(text: string): Promise<{ fs: MemoryAdapter; node: VFSNode; entry: VFSEntry }> {
    const fs = new MemoryAdapter('holder', { clock: () => tick() });
    const node = await VFSNode.open(fs, { id: 'holder', now: () => tick() });
    await node.write('rom.bin', encoder.encode(text));
    await node.commit();
    const entry = (await node.live()).find((item) => item.path === 'rom.bin')!;
    return { fs, node, entry };
  }

  it('vouches for a file that still matches what the scan recorded', async () => {
    const { node, entry } = await held('recorded');

    const handle = await holds(node, [entry], entry.hash as Hash);

    expect(handle?.origin).toEqual({ adapter: node.adapter, path: 'rom.bin' });
  });

  it('will not vouch once the file has been touched behind the engine', async () => {
    const { fs, node, entry } = await held('recorded');
    // Same length, so only the mtime gives it away — which is the point: this
    // is the in-pass race, and the mtime is what closes it.
    await fs.write('rom.bin', encoder.encode('tampered'));

    const handle = await holds(node, [entry], entry.hash as Hash);

    expect(handle).not.toBeNull();
    expect(handle?.origin).toBeUndefined();
  });

  it('will not vouch when the size moved', async () => {
    const { fs, node, entry } = await held('recorded');
    await fs.write('rom.bin', encoder.encode('recorded, and then some'));
    fs.setMtime('rom.bin', entry.mtime as number);

    expect((await holds(node, [entry], entry.hash as Hash))?.origin).toBeUndefined();
  });

  it('will not vouch for an entry that was never stamped with an mtime', async () => {
    const { node, entry } = await held('unstamped');
    // No recorded mtime is no evidence, not weak evidence: there is nothing to
    // compare a stat against, so the promise cannot be made.
    delete entry.mtime;

    expect((await holds(node, [entry], entry.hash as Hash))?.origin).toBeUndefined();
  });

  /**
   * The trade §11 of the session took knowingly, pinned so it stays visible.
   *
   * `mtime` + `size` is what the *scan* trusts everywhere in the engine, so a
   * change that fools the scan fools this too. It is not a regression the fast
   * path introduced; it is the same standing trade reaching one place further.
   * Closing it costs a re-hash of every byte copied, which is the whole saving.
   */
  it('is fooled by exactly what the scan is fooled by', async () => {
    const { fs, node, entry } = await held('12345678');
    await fs.write('rom.bin', encoder.encode('87654321')); // same size
    fs.setMtime('rom.bin', entry.mtime as number); // and the mtime restored

    expect((await holds(node, [entry], entry.hash as Hash))?.origin).toBeDefined();
  });
});

describe('unscope', () => {
  it('follows nested views down to the adapter holding the bytes', () => {
    const fs = new MemoryAdapter('base');
    const once = new ScopedAdapter(fs, 'projects');
    const twice = new ScopedAdapter(once, 'notes');

    expect(unscope(twice, 'a.md')).toEqual({ adapter: fs, path: 'projects/notes/a.md' });
    expect(unscope(fs, 'a.md')).toEqual({ adapter: fs, path: 'a.md' });
  });

  it('only advertises the two methods when the base has them', () => {
    const scoped = new ScopedAdapter(new MemoryAdapter('m'), 'x');
    expect(typeof scoped.backendId).toBe('function');
    expect(typeof scoped.copyFrom).toBe('function');

    const bare: VFSAdapter = {
      name: 'bare',
      list: async () => [],
      read: async () => new Uint8Array(),
      write: async () => undefined,
      delete: async () => undefined,
      rename: async () => undefined,
      stat: async () => null,
    };
    const over = new ScopedAdapter(bare, 'x');
    expect(over.backendId).toBeUndefined();
    expect(over.copyFrom).toBeUndefined();
  });

  it('is a view, not a backend: two scopes over one base are one backend', async () => {
    const fs = new MemoryAdapter('shared');
    const a = new ScopedAdapter(fs, 'a');
    const b = new ScopedAdapter(fs, 'b');

    expect(await a.backendId!()).toBe(await b.backendId!());
    expect(await a.backendId!()).not.toBeNull();
    expect(await new MemoryAdapter('other').backendId()).not.toBe(await a.backendId!());
  });
});

describe('Drive native copy', () => {
  /** A Drive adapter over one fake drive, recording every request and body. */
  function traced(): {
    drive: GDriveAdapter;
    calls: Array<{ url: string; method: string; body: string }>;
  } {
    const fake = makeFakeDrive();
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const drive = new GDriveAdapter({
      token: 'tok',
      fetch: (input, init) => {
        const body = init?.body;
        calls.push({
          url: String(input),
          method: (init?.method ?? 'GET').toUpperCase(),
          body: body instanceof Uint8Array ? decoder.decode(body) : String(body ?? ''),
        });
        return fake.fetch(input, init);
      },
    });
    return { drive, calls };
  }

  it('duplicates server-side, with the bytes never crossing the wire', async () => {
    const { drive, calls } = traced();
    const a = await VFSNode.open(new ScopedAdapter(drive, 'folder-a'), {
      id: 'a',
      now: () => tick(),
    });
    const b = await VFSNode.open(new ScopedAdapter(drive, 'folder-b'), {
      id: 'b',
      now: () => tick(),
    });
    // Binary on purpose. A text file also has its base kept in `.vfs` for a
    // future three-way merge, and that write is a legitimate upload of the same
    // bytes — it would mask the question this test is asking.
    const rom = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);
    await a.write('rom.bin', rom);
    await a.commit();
    await b.commit();
    calls.length = 0;

    await sync(a, b);

    expect(calls.filter((call) => call.url.includes('/copy'))).toHaveLength(1);
    // The two ways the payload would otherwise cross the wire. Uploads still
    // happen — `.vfs` is written on every pass — so the assertion is about the
    // *content* of the bodies, not the number of requests.
    const carried = decoder.decode(rom);
    expect(calls.filter((call) => call.body.includes(carried))).toEqual([]);
    expect(calls.filter((call) => call.url.includes('alt=media'))).toEqual([]);
    expect(new Uint8Array(await b.read('rom.bin'))).toEqual(rom);
  });

  it('identifies the account once and caches it', async () => {
    const { drive, calls } = traced();

    const first = await drive.backendId();
    await drive.backendId();
    await drive.backendId();

    // The resolved root folder, not the `root` alias that was asked about.
    expect(first).toMatch(/^drive:drive-root-\d+$/);
    expect(calls.filter((call) => call.url.includes('files/root'))).toHaveLength(1);
  });

  it('answers an explicit root folder without asking Drive at all', async () => {
    const fake = makeFakeDrive();
    let asked = 0;
    const drive = new GDriveAdapter({
      token: 'tok',
      rootFolderId: 'folder-123',
      fetch: (input, init) => {
        asked++;
        return fake.fetch(input, init);
      },
    });

    expect(await drive.backendId()).toBe('drive:folder-123');
    expect(asked).toBe(0);
  });

  it('answers null when the account cannot be resolved, and loses the fast path', async () => {
    const drive = new GDriveAdapter({
      token: 'tok',
      fetch: async () => new Response('{"error":{"message":"nope"}}', { status: 403 }),
    });

    expect(await drive.backendId()).toBeNull();
  });

  it('is two backends when it is two accounts', async () => {
    const one = new GDriveAdapter({ token: 'tok', fetch: makeFakeDrive().fetch });
    const two = new GDriveAdapter({ token: 'tok', fetch: makeFakeDrive().fetch });

    expect(await one.backendId()).not.toBe(await two.backendId());
  });
});
