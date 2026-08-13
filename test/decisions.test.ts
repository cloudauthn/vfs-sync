import { describe, expect, it } from 'vitest';
import { ConflictError } from '../src/sync.js';
import type { ConflictPayload } from '../src/sync.js';
import { encoder, files, get, peer, put, settle, stabilise, sync } from './helpers.js';

/** The conflicts a pass refused to write over, as a caller with no `decide` sees them. */
async function stoppedBy(a: Parameters<typeof sync>[0], b: Parameters<typeof sync>[1]): Promise<ConflictPayload[]> {
  try {
    await sync(a, b);
  } catch (error) {
    if (error instanceof ConflictError) return error.conflicts;
    throw error;
  }
  return [];
}

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

    const stopped = await stoppedBy(a.node, b.node);

    expect(stopped).toHaveLength(1);
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

    expect(await stoppedBy(a.node, b.node)).toHaveLength(1);
    expect((await a.node.file()).syncId).toBeNull();
    expect((await b.node.file()).syncId).toBeNull();

    await settle(a.node, b.node);
    expect((await a.node.file()).syncId).toBeTypeOf('string');
  });

  it('hands over the two versions, so a UI can show what is waiting', async () => {
    const { a, b } = await disputed();
    const [stopped] = await stoppedBy(a.node, b.node);

    expect(stopped?.reason).toBe('content');
    expect(stopped?.level).toBe('entry');
    expect(stopped?.path).toBe('notes.bin');
    expect(stopped?.ctxA).toMatchObject({ path: 'notes.bin', peerId: 'device-a' });
    expect(stopped?.ctxB).toMatchObject({ path: 'notes.bin', peerId: 'device-b' });
  });

  it('still plans the whole pass, which a dry run can read without throwing', async () => {
    const { a, b } = await disputed();
    const preview = await sync(a.node, b.node, { dryRun: true });

    expect(preview.actions.toB.some((action) => action.path === 'unrelated.txt')).toBe(true);
    expect(preview.pending).toHaveLength(1);
    expect(preview.state).toBeTypeOf('string');
  });

  /**
   * A directory has no hash, so nothing can prove its removal is a propagation
   * and the merge reports a divergence. It is not one — and if it counted, every
   * folder anyone deletes would block the mesh until a human said so.
   */
  it('does not stop for a directory one side removed and the other still had', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'roms/game.bin', 'a rom');
    await sync(a.node, b.node);

    await a.node.rename('roms/game.bin', 'moved/game.bin');
    await a.node.commit();
    const result = await sync(a.node, b.node);

    expect(result.pending).toEqual([]);
    expect(result.applied).toBe(true);
    expect(files(b)['moved/game.bin']).toBe('a rom');
    expect(files(b)['roms/game.bin']).toBeUndefined();
  });

  /** The same shape with content on one side is the real thing, and it stops. */
  it('does stop when one side deleted what the other edited', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.bin', 'shared');
    await sync(a.node, b.node);

    await put(b, 'notes.bin', 'edited on B');
    await b.node.commit();
    await a.node.delete('notes.bin');

    const stopped = await stoppedBy(a.node, b.node);

    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.reason).toBe('delete-edit');
    // The edit is still there, unanswered rather than discarded.
    expect(files(b)['notes.bin']).toBe('edited on B');
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
    const [report] = await stoppedBy(a.node, b.node);

    // The engine's own answer is B's version; the user says A's.
    expect((report?.ctxB as { updated: number }).updated).toBeGreaterThan((report?.ctxA as { updated: number }).updated);
    const applied = await sync(a.node, b.node, {
      decisions: [{ id: report?.id as string, action: 'keep', side: 'a' }],
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

    const [report] = await stoppedBy(a.node, b.node);
    await sync(a.node, b.node, { decisions: [{ id: report?.id as string, action: 'keep', side: 'a' }] });

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
    const [report] = await stoppedBy(a.node, b.node);

    await sync(a.node, b.node, {
      decisions: [{ id: report?.id as string, action: 'replace', content: encoder.encode('merged by hand') }],
    });

    expect(await get(a, 'notes.bin')).toBe('merged by hand');
    expect(await get(b, 'notes.bin')).toBe('merged by hand');
  });

  it("park the loser when the answer is 'both'", async () => {
    const { a, b } = await disputed();
    const [report] = await stoppedBy(a.node, b.node);

    const applied = await sync(a.node, b.node, {
      decisions: [{ id: report?.id as string, action: 'keep-both' }],
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
    const [report] = await stoppedBy(a.node, b.node);
    const decision = {
      id: report?.id as string,
      action: 'keep' as const,
      side: 'a' as const,
      a: (report?.ctxA as { hash: string }).hash,
      b: (report?.ctxB as { hash: string }).hash,
    };

    // B edits again while the user is still looking at the two columns.
    await put(b, 'notes.bin', 'from B, again');

    await expect(sync(a.node, b.node, { decisions: [decision] })).rejects.toThrow(ConflictError);
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

    const first = await stoppedBy(a.node, b.node);
    expect(first).toHaveLength(2);

    const half = sync(a.node, b.node, {
      decisions: [{ id: first[0]?.id as string, action: 'keep', side: 'a' }],
    });
    await expect(half).rejects.toThrow(ConflictError);
    await half.catch((error: ConflictError) => {
      expect(error.conflicts).toHaveLength(1);
      expect(error.conflicts[0]?.id).toBe(first[1]?.id);
    });
    // The decided one did not land either: one outstanding decision is enough.
    expect(files(a)['one.bin']).toBe('from A: one.bin');
  });

  it('are ignored when they name nothing at all', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'notes.md', 'hello');

    const result = await sync(a.node, b.node, { decisions: [{ id: 'nope', action: 'keep', side: 'a' }] });

    expect(result.applied).toBe(true);
    expect(files(b)).toEqual({ 'notes.md': 'hello' });
  });
});

describe('the payload carries what the decision needs', () => {
  it('says whether each version can be read here', async () => {
    const { a, b } = await disputed();
    const [conflict] = await stoppedBy(a.node, b.node);

    expect(conflict?.ctxA).toMatchObject({ readable: true, subtree: 0 });
    expect(conflict?.ctxB).toMatchObject({ readable: true, subtree: 0 });
    // Two versions of one file share an identity; two files colliding do not.
    expect((conflict?.ctxA as { uuid: string }).uuid).toBe((conflict?.ctxB as { uuid: string }).uuid);
  });

  /**
   * Two *different* files wanting one name is not two versions of one file, and
   * calling both `content` made a consumer look at the uuids to tell them apart.
   */
  it('separates two files colliding on a path from two versions of one file', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'one.txt', 'first');
    await put(a, 'two.txt', 'second');
    await sync(a.node, b.node);

    // Two files both sides know, renamed onto the same name from either end.
    await a.node.rename('one.txt', 'merged.txt');
    await a.node.commit();
    await b.node.rename('two.txt', 'merged.txt');

    const stopped = await stoppedBy(a.node, b.node);
    const collision = stopped.find((conflict) => conflict.reason === 'path-collision');

    expect(collision).toBeDefined();
    expect(collision?.path).toBe('merged.txt');
    expect((collision?.ctxA as { uuid: string }).uuid).not.toBe(
      (collision?.ctxB as { uuid: string }).uuid,
    );
    // Nothing is at risk: the loser keeps its bytes at the name it was moved to.
    expect((collision?.ctxB as { path: string }).path).toMatch(/conflict/);
  });

  it('counts what a directory would take with it', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'seed.txt', 'seed');
    await sync(a.node, b.node);

    // A directory on one side, a file on the other, on the same path.
    await put(a, 'shared/one.txt', 'one');
    await put(a, 'shared/two.txt', 'two');
    await a.node.commit();
    await put(b, 'shared', 'a file, not a folder');

    const stopped = await stoppedBy(a.node, b.node);
    const collision = stopped.find((conflict) => conflict.reason === 'kind');

    expect(collision).toBeDefined();
    const directory = [collision?.ctxA, collision?.ctxB].find(
      (context) => (context as { kind: string }).kind === 'directory',
    );
    expect((directory as { subtree: number }).subtree).toBe(2);
  });
});

describe('decide', () => {
  it('is asked once per conflict and settles the pass in one go', async () => {
    const { a, b } = await disputed();
    const seen: string[] = [];

    const result = await sync(a.node, b.node, {
      decide: (conflict) => {
        seen.push(`${conflict.reason}:${conflict.path}`);
        return { action: 'keep', side: 'a' };
      },
    });

    expect(seen).toEqual(['content:notes.bin']);
    expect(result.applied).toBe(true);
    expect(await get(b, 'notes.bin')).toBe('from A');
    // And the unrelated file travelled with it, in the same pass.
    expect(files(b)['unrelated.txt']).toBe('a photo, morally');
  });

  /** Being asked and saying no is an answer. Answers come back; they do not throw. */
  it('returns instead of throwing when the answer is no', async () => {
    const { a, b } = await disputed();

    const result = await sync(a.node, b.node, { decide: () => ({ action: 'abort' }) });

    expect(result.applied).toBe(false);
    expect(result.pending).toHaveLength(1);
    expect(files(b)['unrelated.txt']).toBeUndefined();
  });

  it('treats no answer at all as the same no', async () => {
    const { a, b } = await disputed();
    const result = await sync(a.node, b.node, { decide: () => null });

    expect(result.applied).toBe(false);
    expect(files(b)['unrelated.txt']).toBeUndefined();
  });

  /**
   * The array is what a person has already seen and confirmed; the callback may
   * be a policy that never looked. So the array wins.
   */
  it('yields to a decision the caller already had in hand', async () => {
    const { a, b } = await disputed();
    const [report] = await stoppedBy(a.node, b.node);
    let asked = 0;

    await sync(a.node, b.node, {
      decisions: [{ id: report?.id as string, action: 'keep', side: 'a' }],
      decide: () => {
        asked++;
        return { action: 'keep', side: 'b' };
      },
    });

    expect(asked).toBe(0);
    expect(await get(b, 'notes.bin')).toBe('from A');
  });

  it('is not asked about anything that settled itself', async () => {
    const a = await peer('device-a');
    const b = await peer('device-b');
    await put(a, 'gamelist.xml', '<one/>\n<two/>\n<three/>\n');
    await sync(a.node, b.node);

    await put(a, 'gamelist.xml', '<ONE/>\n<two/>\n<three/>\n');
    await a.node.commit();
    await put(b, 'gamelist.xml', '<one/>\n<two/>\n<THREE/>\n');

    let asked = 0;
    const result = await sync(a.node, b.node, {
      decide: () => {
        asked++;
        return { action: 'abort' };
      },
    });

    expect(asked).toBe(0);
    expect(result.merged).toBe(1);
    expect(result.applied).toBe(true);
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
    const real = await stoppedBy(a.node, b.node);

    expect(preview.pending.map((report) => report.path)).toEqual(
      real.map((conflict) => conflict.path),
    );
    expect(files(b)['unrelated.txt']).toBeUndefined();
  });
});
