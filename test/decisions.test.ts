import { describe, expect, it } from 'vitest';
import { sync } from '../src/sync.js';
import { encoder, files, get, peer, put, settle, stabilise } from './helpers.js';

/**
 * The rule this suite exists for: **a pass writes nothing at all while a
 * conflict is waiting for a person.** Not the disputed file, and not the
 * hundred unrelated ones travelling alongside it.
 *
 * The decision then comes back as data, and the version it produces has to
 * carry both parents — otherwise the next peer to do the arithmetic reaches the
 * engine's original answer and quietly undoes what the user chose.
 */

/** Two peers, one disputed file, and a third file that has nothing to do with it. */
async function disputed() {
  const a = await peer('device-a');
  const b = await peer('device-b');
  await put(a, 'notes.bin', 'shared');
  await sync(a.node, b.node);

  await put(a, 'notes.bin', 'from A');
  await put(a, 'unrelated.txt', 'a photo, morally');
  await a.node.commit();
  await put(b, 'notes.bin', 'from B');
  return { a, b };
}

describe('a conflict stops the pass', () => {
  it('writes nothing on either side, including what was not in dispute', async () => {
    const { a, b } = await disputed();
    const before = { a: files(a), b: files(b) };

    const result = await sync(a.node, b.node);

    expect(result.pending).toHaveLength(1);
    expect(result.applied).toBe(false);
    expect(files(a)).toEqual(before.a);
    expect(files(b)).toEqual(before.b);
    // The file that had nothing to do with the dispute waits with it.
    expect(files(b)['unrelated.txt']).toBeUndefined();
  });

  /**
   * Affiliation records a sync that happened, not one that was attempted — so a
   * first meeting that ends in a decision leaves both folders unaffiliated.
   */
  it('does not affiliate two folders meeting for the first time', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.bin', 'from A');
    await put(b, 'notes.bin', 'from B');

    expect((await sync(a.node, b.node)).pending).toHaveLength(1);
    expect((await a.node.file()).syncId).toBeNull();
    expect((await b.node.file()).syncId).toBeNull();

    await settle(a.node, b.node);
    expect((await a.node.file()).syncId).toBeTypeOf('string');
  });

  it('still reports the whole plan, so a UI can show what is waiting', async () => {
    const { a, b } = await disputed();
    const result = await sync(a.node, b.node);

    expect(result.actions.toB.some((action) => action.path === 'unrelated.txt')).toBe(true);
    expect(result.pending[0]?.path).toBe('notes.bin');
    expect(result.pending[0]?.a?.hash).not.toBe(result.pending[0]?.b?.hash);
    expect(result.state).toBeTypeOf('string');
  });

  /** What settles itself is not what needs a person. */
  it('leaves a text merge and a rename-versus-rename out of `pending`', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n<three/>\n');
    await put(a, 'notes.md', 'shared');
    await sync(a.node, b.node);

    // Text that merges cleanly, and the same file renamed differently on each side.
    await put(a, 'gamelist.xml', '<ONE/>\n<two/>\n<three/>\n');
    await a.node.rename('notes.md', 'left.md');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<two/>\n<THREE/>\n');
    await b.node.rename('notes.md', 'right.md');

    const result = await sync(a.node, b.node);

    expect(result.merged).toBe(1);
    expect(result.conflicts.some((report) => report.kind === 'location')).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.applied).toBe(true);
  });
});

describe('decisions', () => {
  it('take the side the user picked, even when the engine picked the other', async () => {
    const { a, b } = await disputed();
    const [report] = (await sync(a.node, b.node)).pending;

    // The engine's own answer is B's version; the user says A's.
    expect(report?.winner).toBe('b');
    const applied = await sync(a.node, b.node, {
      decisions: [{ uuid: report?.uuid as string, choice: 'a' }],
    });

    expect(applied.applied).toBe(true);
    expect(applied.pending).toEqual([]);
    expect(await get(a, 'notes.bin')).toBe('from A');
    expect(files(b)).toEqual(files(a));
    // No copy was parked: a decision was made, so there is nothing pending.
    expect(await a.node.conflicts()).toHaveLength(0);
    expect(Object.keys(files(a)).some((path) => path.includes('conflict'))).toBe(false);
  });

  /**
   * The load-bearing one. Adopting the chosen entry as it stands would lose to
   * the other version's newer `updated` the moment a third peer does the
   * arithmetic — so the decision mints a version descending from *both*.
   */
  it('mint a version with both parents, so nobody re-decides it later', async () => {
    const { a, b } = await disputed();
    const c = await peer('device-c');
    // C has A's losing version and nothing else, which is what would re-raise it.
    await settle(a.node, c.node);

    const [report] = (await sync(a.node, b.node)).pending;
    await sync(a.node, b.node, { decisions: [{ uuid: report?.uuid as string, choice: 'a' }] });

    const decided = (await a.node.live()).find((entry) => entry.path === 'notes.bin');
    expect(decided?.prev).toBeTypeOf('string');
    expect(decided?.prev2).toBeTypeOf('string');
    expect(decided?.prev).not.toBe(decided?.prev2);

    await stabilise([
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ]);
    expect(await get(c, 'notes.bin')).toBe('from A');
    expect((await sync(a.node, c.node)).conflicts).toEqual([]);
  });

  it('accept content the caller composed', async () => {
    const { a, b } = await disputed();
    const [report] = (await sync(a.node, b.node)).pending;

    await sync(a.node, b.node, {
      decisions: [{ uuid: report?.uuid as string, choice: encoder.encode('merged by hand') }],
    });

    expect(await get(a, 'notes.bin')).toBe('merged by hand');
    expect(await get(b, 'notes.bin')).toBe('merged by hand');
  });

  it("park the loser when the answer is 'both'", async () => {
    const { a, b } = await disputed();
    const [report] = (await sync(a.node, b.node)).pending;

    const applied = await sync(a.node, b.node, {
      decisions: [{ uuid: report?.uuid as string, choice: 'both' }],
    });

    expect(applied.applied).toBe(true);
    const copies = Object.entries(files(a)).filter(([path]) => path.includes('conflict'));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.[1]).toBe('from A');
    // And it stays a pending decision, which is what `node.resolve()` is for.
    expect(await a.node.conflicts()).toHaveLength(1);
  });

  it('are ignored when they name a dispute that has moved on', async () => {
    const { a, b } = await disputed();
    const [report] = (await sync(a.node, b.node)).pending;
    const decision = {
      uuid: report?.uuid as string,
      choice: 'a' as const,
      a: report?.a?.hash ?? null,
      b: report?.b?.hash ?? null,
    };

    // B edits again while the user is still looking at the two columns.
    await put(b, 'notes.bin', 'from B, again');

    const result = await sync(a.node, b.node, { decisions: [decision] });

    expect(result.applied).toBe(false);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.b?.hash).not.toBe(decision.b);
    expect(files(a)['notes.bin']).toBe('from A');
  });

  it('do not need to be complete, and what is left keeps the pass from writing', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'one.bin', 'shared');
    await put(a, 'two.bin', 'shared');
    await sync(a.node, b.node);

    for (const path of ['one.bin', 'two.bin']) await put(a, path, `from A: ${path}`);
    await a.node.commit();
    for (const path of ['one.bin', 'two.bin']) await put(b, path, `from B: ${path}`);

    const first = await sync(a.node, b.node);
    expect(first.pending).toHaveLength(2);

    const half = await sync(a.node, b.node, {
      decisions: [{ uuid: first.pending[0]?.uuid as string, choice: 'a' }],
    });

    expect(half.applied).toBe(false);
    expect(half.pending).toHaveLength(1);
    expect(half.pending[0]?.uuid).toBe(first.pending[1]?.uuid);
    // The decided one did not land either: one outstanding decision is enough.
    expect(files(a)['one.bin']).toBe('from A: one.bin');
  });

  it('are ignored when they name nothing at all', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello');

    const result = await sync(a.node, b.node, { decisions: [{ uuid: 'nope', choice: 'a' }] });

    expect(result.applied).toBe(true);
    expect(files(b)).toEqual({ 'notes.md': 'hello' });
  });
});

describe('dryRun', () => {
  it('touches neither folder, and predicts what the real pass then does', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello from A');
    await put(b, 'other.md', 'hello from B');

    const preview = await sync(a.node, b.node, { dryRun: true });

    expect(preview.applied).toBe(false);
    expect(files(a)).toEqual({ 'notes.md': 'hello from A' });
    expect(files(b)).toEqual({ 'other.md': 'hello from B' });
    expect((await a.node.file()).syncId).toBeNull();

    const applied = await sync(a.node, b.node);
    expect(applied.applied).toBe(true);
    expect(applied.transferred).toEqual(preview.transferred);
    expect(applied.actions.toB.map((action) => action.path).sort()).toEqual(
      preview.actions.toB.map((action) => action.path).sort(),
    );
  });

  /**
   * `state` is the one prediction with a caveat, and it is worth pinning: a
   * version is stamped when it is *recorded*, and a dry run records nothing. So
   * the digest it predicts is exact for edits already committed, and differs by
   * those timestamps for edits it only scanned.
   */
  it('predicts the digest exactly once both sides have recorded their edits', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello from A');
    await put(b, 'other.md', 'hello from B');
    await a.node.commit();
    await b.node.commit();

    const preview = await sync(a.node, b.node, { dryRun: true });
    expect((await sync(a.node, b.node)).state).toBe(preview.state);
  });

  it('reports a conflict without writing, exactly as the real pass would', async () => {
    const { a, b } = await disputed();

    const preview = await sync(a.node, b.node, { dryRun: true });
    const real = await sync(a.node, b.node);

    expect(preview.pending.map((report) => report.path)).toEqual(
      real.pending.map((report) => report.path),
    );
    expect(files(b)['unrelated.txt']).toBeUndefined();
  });
});
