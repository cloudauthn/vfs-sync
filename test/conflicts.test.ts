import { describe, expect, it } from 'vitest';
import { sync, syncUntilStable } from '../src/sync.js';
import { files, get, peer, put } from './helpers.js';

/**
 * §4's closing move: the bytes always converge, the *decision* is what stays
 * pending — and the pending state is not a new record, it is the conflict copy
 * itself. So "are there conflicts?" is a question about `vfs.json`, and
 * resolving one is a write plus a delete.
 */

/** Drives two peers into a binary conflict over `notes.bin`. */
async function diverged() {
  const a = await peer('device-a');
  const b = await peer('device-b');
  await put(a, 'notes.bin', 'shared');
  await sync(a.node, b.node);

  await put(a, 'notes.bin', 'from A');
  await a.node.commit();
  await put(b, 'notes.bin', 'from B');
  await sync(a.node, b.node);
  return { a, b };
}

describe('pending conflicts', () => {
  it('are enumerable without syncing or touching the network', async () => {
    const { a, b } = await diverged();

    const pending = await a.node.conflicts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reason: 'binary',
      path: 'notes.bin',
      peer: 'device-a',
    });
    expect(pending[0]?.copyPath).toMatch(/conflict device-a/);
    // Both peers see the same pending decision — it converged like any entry.
    expect((await b.node.conflicts()).map((item) => item.uuid)).toEqual(
      pending.map((item) => item.uuid),
    );
  });

  it('offers both sides so a UI can show two columns', async () => {
    const { a } = await diverged();
    const [pending] = await a.node.conflicts();
    expect(pending?.mine.hash).not.toBe(pending?.theirs.hash);
    expect(pending?.theirs.updated).toBeGreaterThan(0);
  });

  it("resolving with 'mine' keeps the winner and drops the copy", async () => {
    const { a, b } = await diverged();
    const [pending] = await a.node.conflicts();

    await a.node.resolve(pending?.uuid as string, 'mine');

    expect(files(a)).toEqual({ 'notes.bin': 'from B' });
    expect(await a.node.conflicts()).toHaveLength(0);

    // The resolution is an ordinary write; it propagates like one.
    await sync(a.node, b.node);
    expect(files(b)).toEqual({ 'notes.bin': 'from B' });
    expect(await b.node.conflicts()).toHaveLength(0);
  });

  it("resolving with 'theirs' promotes the copy over the winner", async () => {
    const { a, b } = await diverged();
    const [pending] = await a.node.conflicts();

    await a.node.resolve(pending?.uuid as string, 'theirs');
    await sync(a.node, b.node);

    expect(files(a)).toEqual({ 'notes.bin': 'from A' });
    expect(files(b)).toEqual(files(a));
  });

  it('accepts a hand-edited resolution', async () => {
    const { a, b } = await diverged();
    const [pending] = await a.node.conflicts();

    await a.node.resolve(pending?.uuid as string, new TextEncoder().encode('merged by hand'));
    await syncUntilStable([{ a: a.node, b: b.node }]);

    expect(await get(a, 'notes.bin')).toBe('merged by hand');
    expect(files(b)).toEqual(files(a));
    expect(await b.node.conflicts()).toHaveLength(0);
  });

  it('refuses a uuid that is not a pending conflict', async () => {
    const a = await peer('device-a');
    await expect(a.node.resolve('nope', 'mine')).rejects.toThrow(/no pending conflict/);
  });
});

describe('text conflicts', () => {
  it('settle themselves when the edits do not overlap', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n<three/>\n');
    await sync(a.node, b.node);

    await put(a, 'gamelist.xml', '<ONE/>\n<two/>\n<three/>\n');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<two/>\n<THREE/>\n');
    const result = await sync(a.node, b.node);

    expect(result.merged).toBe(1);
    expect(await get(a, 'gamelist.xml')).toBe('<ONE/>\n<two/>\n<THREE/>\n');
    expect(files(b)).toEqual(files(a));
    expect(Object.keys(files(a))).toEqual(['gamelist.xml']);
    expect(await a.node.conflicts()).toHaveLength(0);
  });

  /**
   * The merged version descends from *both* parents. Without `prev2` a third
   * peer holding one of them would re-classify the merge as a fresh conflict on
   * every pass, and the mesh would never go quiet.
   */
  it('record both parents, so a third peer does not re-raise them', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    const c = await peer('device-c');
    const edges = [
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ];

    await put(a, 'gamelist.xml', '<one/>\n<two/>\n<three/>\n');
    await syncUntilStable(edges);

    await put(a, 'gamelist.xml', '<ONE/>\n<two/>\n<three/>\n');
    await a.node.commit();
    await put(c, 'gamelist.xml', '<one/>\n<two/>\n<THREE/>\n');
    await c.node.commit();
    await syncUntilStable(edges);

    const merged = (await a.node.live()).find((entry) => entry.path === 'gamelist.xml');
    expect(merged?.prev2).toBeTypeOf('string');
    expect(files(a)).toEqual(files(c));

    const again = await syncUntilStable(edges, { maxRounds: 3 });
    expect(again.flat().flatMap((item) => item.result.conflicts)).toHaveLength(0);
  });

  it('fall back to a copy when the edits collide', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n<three/>\n');
    await sync(a.node, b.node);

    await put(a, 'gamelist.xml', '<one/>\n<LEFT/>\n<three/>\n');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<RIGHT/>\n<three/>\n');
    const result = await sync(a.node, b.node);

    expect(result.merged).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    const [pending] = await a.node.conflicts();
    expect(pending?.reason).toBe('binary');
    // Whatever happens, no merge markers reach a working file.
    for (const content of Object.values(files(a))) expect(content).not.toContain('<<<');
  });

  it('hand the decision to a hook when one is supplied', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n');
    await sync(a.node, b.node);

    await put(a, 'gamelist.xml', '<one/>\n<LEFT/>\n');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<RIGHT/>\n');

    const seen: string[] = [];
    const result = await sync(a.node, b.node, {
      resolveText: async (info) => {
        seen.push(info.path);
        return '<one/>\n<BOTH/>\n';
      },
    });

    expect(seen).toEqual(['gamelist.xml']);
    expect(result.merged).toBe(1);
    expect(await get(b, 'gamelist.xml')).toBe('<one/>\n<BOTH/>\n');
  });

  it('take the headless path when the hook declines', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n');
    await sync(a.node, b.node);

    await put(a, 'gamelist.xml', '<one/>\n<LEFT/>\n');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<RIGHT/>\n');

    const result = await sync(a.node, b.node, { resolveText: async () => null });
    expect(result.merged).toBe(0);
    expect(await a.node.conflicts()).toHaveLength(1);
  });

  it('are binary when the extension is not on the list, whatever the bytes look like', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.rom', 'one\ntwo\nthree\n');
    await sync(a.node, b.node);

    await put(a, 'notes.rom', 'ONE\ntwo\nthree\n');
    await a.node.commit();
    await put(b, 'notes.rom', 'one\ntwo\nTHREE\n');
    const result = await sync(a.node, b.node);

    // Sniffing the content would let one peer call it text and the other
    // binary, which is precisely the invariant §4 refuses to break.
    expect(result.merged).toBe(0);
    expect(result.conflicts[0]?.text).toBeUndefined();
  });
});

describe('conflict copies that are too big to travel', () => {
  it('stay on the peer that made them', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'game.bin', 'shared');
    await sync(a.node, b.node);

    await put(a, 'game.bin', 'a re-dump from A');
    await a.node.commit();
    await put(b, 'game.bin', 'a re-dump from B');
    await sync(a.node, b.node, { heldAt: 8 });

    const [pending] = await b.node.conflicts();
    expect(pending?.held).toBe('device-a');
    // The entry travelled; the bytes did not.
    expect(Object.keys(files(b))).toEqual(['game.bin']);
    expect(Object.keys(files(a)).some((path) => path.includes('conflict'))).toBe(true);

    // And B says so, instead of failing on a read of a file that was never
    // going to be there.
    await expect(b.node.resolve(pending?.uuid as string, 'theirs')).rejects.toThrow(
      /held on device-a/,
    );
    // Keeping its own side needs nothing from the far peer.
    await b.node.resolve(pending?.uuid as string, 'mine');
    expect(await b.node.conflicts()).toHaveLength(0);
  });
});
