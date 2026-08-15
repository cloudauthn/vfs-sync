import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { encodeRows, makeRow, parseRows } from '../src/log.js';
import { ConflictError } from '../src/sync.js';
import { CURRENT_VERSION, decodeVFSFile, encodeVFSFile, migrateFile } from '../src/vfs-file.js';
import { VFSNode } from '../src/vfs-node.js';
import type { FolderContext } from '../src/sync.js';
import type { LogRow } from '../src/types.js';
import { encoder, files, peer, put, sync, syncMesh, syncUntilStable, tick } from './helpers.js';

/**
 * Phase 6: identity, and the guard that decides whether two folders may merge
 * at all.
 *
 * `storeId` was written, converged and read by nothing — it indexed nothing and
 * authorised nothing, so pairing two folders with no relation to each other was
 * never refused. It is replaced by two fields with one job each: `peerId` names
 * the node and never converges, `syncId` names the group and is minted on the
 * first sync.
 *
 * The library detects, describes and stops. It does not ask and it does not
 * decide: the only thing settled here is *whether to merge*, never which side
 * wins — that stays per file and per version, with ancestry above the clock.
 */

/** A v2 file exactly as the previous format wrote it. */
function v2File(peer: string, storeId: string, withPeers: boolean) {
  return {
    version: 2,
    storeId,
    peer,
    state: '',
    text: ['md'],
    log: { segment: 1, digest: '0'.repeat(64), rows: 0, size: 0 },
    peers: withPeers ? { other: { lastSync: 1, segment: 1, offset: 0, digest: '0'.repeat(64) } } : {},
    local: {},
    entries: [
      {
        uuid: 'u1',
        kind: 'file',
        path: 'a.txt',
        hash: 'f'.repeat(64),
        size: 1,
        created: 1,
        updated: 1,
        peer,
      },
    ],
  };
}

/**
 * The one refusal the guard raised, in the shape every conflict arrives in:
 * a pairing refusal is a `conflicts` of length one with `level: 'pairing'`.
 */
async function pairedError(
  a: VFSNode,
  b: VFSNode,
): Promise<{ reason: string; a: FolderContext; b: FolderContext }> {
  try {
    await sync(a, b);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const [conflict] = error.conflicts;
    if (!conflict || conflict.level !== 'pairing') throw error;
    return {
      reason: conflict.reason,
      a: conflict.ctxA as FolderContext,
      b: conflict.ctxB as FolderContext,
    };
  }
  throw new Error('expected the guard to stop this pairing');
}

/** Every byte of a folder's `.vfs`, so "untouched" can be asserted literally. */
async function control(p: { fs: MemoryAdapter }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await p.fs.list('.vfs')) {
    if (entry.kind !== 'file') continue;
    out[entry.name] = new TextDecoder().decode(await p.fs.read(entry.path));
  }
  return out;
}

describe('syncId', () => {
  it('is an explicit null until the first sync', async () => {
    const fs = new MemoryAdapter('a');
    const node = await VFSNode.open(fs, { id: 'a' });

    expect((await node.file()).syncId).toBeNull();
    // The `null` has to be *written*, not absent: it is what tells a folder
    // that has never synced apart from one written by an engine with no notion
    // of a group at all.
    expect(new TextDecoder().decode(await fs.read('.vfs/vfs.json'))).toContain('"syncId": null');
  });

  it('is minted once and given to both sides', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'x.txt', 'x');

    await sync(a.node, b.node);

    const minted = (await a.node.file()).syncId;
    expect(minted).toBeTruthy();
    expect((await b.node.file()).syncId).toBe(minted);
  });

  it('is not minted by a sync that never happened', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'x.txt', 'x');

    await sync(a.node, b.node, { dryRun: true });

    expect((await a.node.file()).syncId).toBeNull();
    expect((await b.node.file()).syncId).toBeNull();
  });

  it('propagates to a folder that has none, without a tiebreak', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    await put(a, 'x.txt', 'x');
    await sync(a.node, b.node);
    const group = (await a.node.file()).syncId;

    // C has no affiliation to lose, so joining is not a contest.
    await sync(b.node, c.node);
    expect((await c.node.file()).syncId).toBe(group);
  });

  it('settles on one value across a chain', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    await put(a, 'x.txt', 'x');

    await syncUntilStable([
      { a: a.node, b: b.node },
      { a: b.node, b: c.node },
    ]);

    const ids = await Promise.all([a, b, c].map(async (p) => (await p.node.file()).syncId));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });
});

describe('the pairing guard', () => {
  it('refuses two folders that identify as the same peer', async () => {
    const a = await peer('twin');
    const b = await peer('twin');
    await put(a, 'x.txt', 'x');

    const error = await pairedError(a.node, b.node);
    expect(error.reason).toBeTypeOf('string');
    expect(error.reason).toBe('peer-collision');
    expect(error.a.peerId).toBe('twin');
    expect(error.b.peerId).toBe('twin');
  });

  it('refuses two established groups', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const error = await pairedError(b.node, c.node);
    expect(error.reason).toBe('foreign-mesh');
    expect(error.a.syncId).not.toBe(error.b.syncId);
    // Enough to frame the decision as "1,240 files against 890".
    expect(error.a.entries).toBe(1);
    expect(error.b.entries).toBe(1);
    expect(error.a.log.digest).toBeTypeOf('string');
  });

  it('leaves both folders untouched when it stops', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const beforeB = files(b);
    const beforeC = files(c);
    await pairedError(b.node, c.node);

    expect(files(b)).toEqual(beforeB);
    expect(files(c)).toEqual(beforeC);
    expect(files(b)).not.toHaveProperty('y.txt');
  });

  it('reports through the dry run without writing anything', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);
    const groupB = (await b.node.file()).syncId;

    // A dry run reports rather than throws — that is its whole job — and a
    // pairing refusal is reported like anything else that needs an answer.
    const preview = await sync(b.node, c.node, { dryRun: true });
    expect(preview.pending).toHaveLength(1);
    expect(preview.pending[0]?.reason).toBe('foreign-mesh');
    expect(preview.pending[0]?.level).toBe('pairing');
    expect(preview.applied).toBe(false);
    expect((await b.node.file()).syncId).toBe(groupB);
    expect(files(b)).not.toHaveProperty('y.txt');
  });

  it('merges into the group the caller named, and the other gives up its store', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const error = await pairedError(b.node, c.node);
    const kept = error.a.syncId as string;
    const given = error.b.syncId as string;
    const result = await sync(b.node, c.node, { adopt: { syncId: kept } });

    expect(files(b)['y.txt']).toBe('y');
    // The name is the outcome now, not an authorisation: the named group
    // survives whatever the two ids sort as, because the other one is the folder
    // that is about to lose its history.
    expect((await b.node.file()).syncId).toBe(kept);
    expect((await c.node.file()).syncId).toBe(kept);
    expect(result.discarded).toEqual({ side: 'b', syncId: given });
    // ...and the winner remembers, so nobody is asked about that group again.
    expect((await b.node.file()).absorbed).toEqual([given]);
  });

  it('refuses an authorisation for a different collision', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    // A stale token from some other pairing proves nothing about this one.
    await expect(sync(b.node, c.node, { adopt: { syncId: 'g-somewhere-else' } })).rejects.toThrow(
      /different groups/,
    );
  });

  it('does not let `adopt` authorise a peer collision', async () => {
    const a = await peer('twin');
    const b = await peer('twin');
    await put(a, 'x.txt', 'x');

    await expect(sync(a.node, b.node, { adopt: { syncId: 'anything' } })).rejects.toThrow(
      /identify as peer twin/,
    );
  });
});

describe('answering the pairing question', () => {
  /** The same authorisation `adopt: { syncId }` gives, through the door everything else uses. */
  it('adopts one of the two groups when told which one stays', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);
    const groupB = (await b.node.file()).syncId;
    const stranger = (await c.node.file()).syncId;

    const asked: string[] = [];
    const result = await sync(b.node, c.node, {
      decide: (conflict) => {
        asked.push(`${conflict.level}:${conflict.reason}`);
        return { action: 'adopt', side: 'a' };
      },
    });

    expect(asked).toEqual(['pairing:foreign-mesh']);
    expect(result.applied).toBe(true);
    expect(files(c)).toHaveProperty('x.txt');
    // `side: 'a'` is the payload's ctxA — the first folder of the pass — and it
    // is the one that keeps its group. The other rejoins as a newcomer.
    const groupC = (await c.node.file()).syncId;
    expect(groupC).toBe(groupB);
    expect(groupC).toBe((await b.node.file()).syncId);
    expect(groupC).not.toBe(stranger);
    expect(result.discarded).toEqual({ side: 'b', syncId: stranger });
  });

  /** The remedy that existed and could not be reached from a sync. */
  it('reidentifies the side that did not keep its id', async () => {
    const a = await peer('twin');
    const b = await peer('twin');
    await put(a, 'x.txt', 'from the original');

    const result = await sync(a.node, b.node, {
      decide: (conflict) => {
        expect(conflict.reason).toBe('peer-collision');
        expect((conflict.ctxA as FolderContext).everSynced).toBe(false);
        return { action: 'reidentify', side: 'a' };
      },
    });

    expect(result.applied).toBe(true);
    // A keeps the id it was named with; B is the one that yielded.
    expect(a.node.peerId).toBe('twin');
    expect(b.node.peerId).not.toBe('twin');
    expect(files(b)['x.txt']).toBe('from the original');
  });

  it('stops when the answer is no, and says nothing was written', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const result = await sync(b.node, c.node, { decide: () => ({ action: 'abort' }) });

    expect(result.applied).toBe(false);
    expect(files(c)).not.toHaveProperty('x.txt');
  });

  it('takes the same answer as data, for a UI that went away and came back', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const stopped = await sync(b.node, c.node, { dryRun: true });
    const [refusal] = stopped.pending;
    await sync(b.node, c.node, {
      decisions: [{ id: refusal?.id as string, action: 'adopt', side: 'b' }],
    });

    expect((await b.node.file()).syncId).toBe((await c.node.file()).syncId);
    expect(files(b)).toHaveProperty('y.txt');
  });
});

/**
 * What answering `foreign-mesh` now does, and the reason it does it: a folder
 * that has lost a mesh stops being one that has synced, which is the only state
 * in which its uuids may be rewritten — nobody else is holding them. Everything
 * below follows from that one sentence.
 */
describe('the folder that loses a mesh', () => {
  /** Two groups, each with a file of its own and one they both created. */
  async function twoMeshes(shared: { inFirst: string; inSecond: string }) {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(a, 'shared.txt', shared.inFirst);
    await put(c, 'y.txt', 'y');
    await put(c, 'shared.txt', shared.inSecond);
    await sync(a.node, b.node);
    await sync(c.node, d.node);
    return { a, b, c, d, first: (await b.node.file()).syncId as string };
  }

  /**
   * The headline. Before, the loser kept its identities and a path both groups
   * had created was two files claiming one name — a question nobody could
   * answer when the bytes matched.
   */
  it('asks nothing per file: one answer merges two groups', async () => {
    const { b, c, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });

    const asked: string[] = [];
    const result = await sync(b.node, c.node, {
      decide: (conflict) => {
        asked.push(`${conflict.level}:${conflict.reason}`);
        return { action: 'adopt', side: 'a' };
      },
    });

    expect(asked).toEqual(['pairing:foreign-mesh']);
    expect(result.pending).toEqual([]);
    expect(files(b)).toEqual({ 'x.txt': 'x', 'y.txt': 'y', 'shared.txt': 'same' });
    expect(files(c)).toEqual(files(b));
    expect((await c.node.file()).syncId).toBe(first);
  });

  /**
   * The same path with different bytes is still a question — but the *right*
   * one. One file with two versions, which `keep`, `keep-both` and a text merge
   * can all answer; not two files claiming one name, where the only vocabulary
   * was which of them keeps it.
   */
  it('turns one name claimed by two groups into one file with two versions', async () => {
    const { b, c } = await twoMeshes({ inFirst: 'from the first', inSecond: 'from the second' });

    const asked: string[] = [];
    await sync(b.node, c.node, {
      decide: (conflict) => {
        asked.push(`${conflict.level}:${conflict.reason}`);
        return conflict.level === 'pairing' ? { action: 'adopt', side: 'a' } : { action: 'keep-both' };
      },
    });

    expect(asked).toEqual(['pairing:foreign-mesh', 'entry:content']);
    const live = await b.node.live();
    expect(live.filter((entry) => entry.path === 'shared.txt')).toHaveLength(1);
    // One file with two versions: the loser is parked beside it as a conflict
    // copy, which is what `keep-both` means everywhere else in the library.
    expect(live.filter((entry) => entry.conflictOf)).toHaveLength(1);
    expect(Object.values(files(b))).toContain('from the second');
  });

  /**
   * The invariant the whole design rests on, asserted rather than hoped for: an
   * established peer's identity for a file never moves. Only the side with
   * nothing to lose rewrites anything.
   */
  it('never moves a uuid on the side that keeps its group', async () => {
    // The two versions differ on purpose: identical bytes pair by hash on their
    // own, and a test that cannot tell the two mechanisms apart proves neither.
    const { b, c, first } = await twoMeshes({ inFirst: 'from the first', inSecond: 'from the second' });
    const before = new Map((await b.node.live()).map((entry) => [entry.path, entry.uuid]));
    const strangerShared = (await c.node.live()).find((entry) => entry.path === 'shared.txt')?.uuid;

    await sync(b.node, c.node, {
      adopt: { syncId: first },
      decide: () => ({ action: 'keep', side: 'a' }),
    });

    for (const entry of await b.node.live()) {
      const held = before.get(entry.path);
      if (held) expect(entry.uuid).toBe(held);
    }
    // ...and the joining side took the mesh's identity for the path it shared,
    // rather than turning up beside it as a second file claiming the name.
    const after = (await c.node.live()).find((entry) => entry.path === 'shared.txt')?.uuid;
    expect(after).toBe(before.get('shared.txt'));
    expect(after).not.toBe(strangerShared);
  });

  it('keeps every byte the loser had, including what the winning group never saw', async () => {
    const { b, c, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });
    await put(c, 'only-here.txt', 'never seen by the other group');

    await sync(b.node, c.node, { adopt: { syncId: first } });

    expect(files(c)['y.txt']).toBe('y');
    expect(files(c)['only-here.txt']).toBe('never seen by the other group');
    expect(files(b)['only-here.txt']).toBe('never seen by the other group');
  });

  /**
   * The sharp edge of the design, deliberately: the decision travels, so a peer
   * that was offline when it was taken is not asked to take it again — an answer
   * it could only give one way without undoing what the mesh has recorded.
   */
  it('lets a straggler of the losing group join without asking again', async () => {
    const { b, c, d, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });
    await sync(b.node, c.node, { adopt: { syncId: first } });

    // D has been offline throughout and still carries the group that lost.
    const result = await sync(b.node, d.node, {
      decide: () => {
        throw new Error('nobody should be asked twice about the same decision');
      },
    });

    expect(result.applied).toBe(true);
    expect(result.discarded?.side).toBe('b');
    expect((await d.node.file()).syncId).toBe(first);
    expect(files(d)['x.txt']).toBe('x');
  });

  /** A group that had itself taken one in must not strand *that* group's peers. */
  it('carries the record forward when a group that absorbed one is absorbed', async () => {
    const { b, c, d, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });
    const second = (await c.node.file()).syncId as string;
    await sync(b.node, c.node, { adopt: { syncId: first } });

    // A third group takes in the first, which by now carries the second.
    const e = await peer('e');
    const f = await peer('f');
    await put(e, 'z.txt', 'z');
    await sync(e.node, f.node);
    const third = (await e.node.file()).syncId as string;
    await sync(e.node, b.node, { adopt: { syncId: third } });
    // The record travels by syncing, like `text` does — so F learns what E took
    // in on the next ordinary pass, and only then can answer for it.
    await sync(e.node, f.node);

    // D still carries the second group, which nobody in the third has ever met.
    const result = await sync(f.node, d.node, {
      decide: () => {
        throw new Error('the chain should have answered this');
      },
    });

    expect(result.applied).toBe(true);
    expect((await d.node.file()).syncId).toBe(third);
    expect((await f.node.file()).absorbed).toEqual([first, second].sort());
  });

  it('reports the discard through a dry run without performing it', async () => {
    const { b, c, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });
    const second = (await c.node.file()).syncId as string;
    const before = { b: await control(b), c: await control(c) };

    const preview = await sync(b.node, c.node, {
      dryRun: true,
      adopt: { syncId: first },
    });

    expect(preview.applied).toBe(false);
    expect(preview.discarded).toEqual({ side: 'b', syncId: second });
    // Byte for byte, both control folders: a dry run that rewrote a header
    // identically would still be a write.
    expect(await control(b)).toEqual(before.b);
    expect(await control(c)).toEqual(before.c);
  });

  /**
   * The version check comes first for a reason that only matters now: `.vfs` is
   * the one copy of a folder's history, and a folder this engine cannot read
   * might still be readable by the engine that wrote it.
   */
  it('never discards a folder whose format it cannot read', async () => {
    const fs = new MemoryAdapter('future', { clock: () => tick() });
    const raw = { ...v2File('future', 'store-1', true), version: CURRENT_VERSION + 1 };
    await fs.write('.vfs/vfs.json', encoder.encode(JSON.stringify(raw)));
    const ahead = await VFSNode.open(fs, { id: 'future', now: () => tick() });
    const here = await peer('here');
    await put(here, 'x.txt', 'x');
    await sync(here.node, (await peer('mate')).node);
    const group = (await here.node.file()).syncId as string;
    const before = await control(here);

    await expect(
      sync(here.node, ahead, { adopt: { syncId: group }, decide: () => ({ action: 'adopt', side: 'a' }) }),
    ).rejects.toThrow(/version/);

    expect(await control(here)).toEqual(before);
    expect(decodeVFSFile(await fs.read('.vfs/vfs.json')).version).toBe(CURRENT_VERSION + 1);
  });

  /** Configuration, not history — and nobody else holds a copy of it. */
  it('keeps the losing folder local exclusion rules', async () => {
    const { b, c, first } = await twoMeshes({ inFirst: 'same', inSecond: 'same' });
    await c.node.setLocalIgnore(['*.tmp']);
    await put(c, 'scratch.tmp', 'not for the mesh');

    await sync(b.node, c.node, { adopt: { syncId: first } });

    expect((await c.node.file()).local.ignore).toEqual(['*.tmp']);
    expect(files(b)).not.toHaveProperty('scratch.tmp');
  });
});

describe('a bad edge does not paralyse the mesh', () => {
  it('syncs every other edge and reports the one that failed', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const foreign = await peer('foreign');
    const partner = await peer('partner');
    // Two established groups. Both sides have to be affiliated for this to be
    // a conflict at all — a folder with no `syncId` simply joins.
    await put(a, 'seed.txt', 'seed');
    await sync(a.node, b.node);
    await put(foreign, 'f.txt', 'f');
    await sync(foreign.node, partner.node);
    await put(a, 'x.txt', 'x');

    const results = await syncMesh([
      { a: foreign.node, b: b.node }, // the bad one, and it runs first
      { a: a.node, b: b.node },
    ]);

    expect(results[0]?.error).toBeInstanceOf(ConflictError);
    expect(results[0]?.result).toBeUndefined();
    expect(results[1]?.result?.changed).toBe(true);
    // The good edge did its work despite the bad one going first.
    expect(files(b)['x.txt']).toBe('x');
  });

  it('does not treat a failing edge as progress', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const foreign = await peer('foreign');
    const partner = await peer('partner');
    await put(a, 'seed.txt', 'seed');
    await sync(a.node, b.node);
    await put(foreign, 'f.txt', 'f');
    await sync(foreign.node, partner.node);
    await put(a, 'x.txt', 'x');

    const rounds = await syncUntilStable(
      [
        { a: a.node, b: b.node },
        { a: foreign.node, b: b.node },
      ],
      { maxRounds: 6 },
    );

    // An edge that throws identically every pass is not a reason to keep
    // going: the loop settles instead of burning every round.
    expect(rounds.length).toBeLessThan(6);
    expect(rounds.at(-1)?.some((item) => item.error)).toBe(true);
  });
});

describe('migration', () => {
  it('reads a v2 file and brings it forward', () => {
    const raw = v2File('device-a', 'store-1', true);
    const file = decodeVFSFile(encoder.encode(JSON.stringify(raw)));

    expect(file.version).toBe(CURRENT_VERSION);
    expect(file.peerId).toBe('device-a');
    expect(file.entries[0]?.peerId).toBe('device-a');
    expect(file).not.toHaveProperty('peer');
    expect(file).not.toHaveProperty('storeId');
  });

  it('seeds the syncId from storeId, so a real mesh does not fracture', () => {
    // The regression that justifies seeding rather than minting. In v2 the
    // `storeId` converged on the smaller and was transitive, so a mesh already
    // shared one value: each peer derives the same `syncId` alone. Minting a
    // fresh one per folder would make the next sync read `foreign-mesh`.
    const left = migrateFile(v2File('device-a', 'store-shared', true));
    const right = migrateFile(v2File('device-b', 'store-shared', true));

    expect(left.syncId).toBe('store-shared');
    expect(right.syncId).toBe(left.syncId);
  });

  it('treats a folder that never synced as unaffiliated', () => {
    const virgin = migrateFile(v2File('device-c', 'store-1', false));
    expect(virgin.syncId).toBeNull();
  });

  it('keeps two v2 meshes apart after migrating', async () => {
    const write = async (name: string, storeId: string) => {
      const fs = new MemoryAdapter(name, { clock: () => tick() });
      await fs.write('.vfs/vfs.json', encoder.encode(JSON.stringify(v2File(name, storeId, true))));
      return VFSNode.open(fs, { id: name, now: () => tick() });
    };
    const one = await write('m1', 'store-one');
    const two = await write('m2', 'store-two');

    await expect(sync(one, two)).rejects.toThrow(/different groups/);
  });

  it('lets two peers of one v2 mesh keep syncing', async () => {
    const write = async (name: string) => {
      const fs = new MemoryAdapter(name, { clock: () => tick() });
      await fs.write('.vfs/vfs.json', encoder.encode(JSON.stringify(v2File(name, 'store-same', true))));
      return VFSNode.open(fs, { id: name, now: () => tick() });
    };
    const one = await write('m1');
    const two = await write('m2');

    await expect(sync(one, two)).resolves.toBeTruthy();
    expect((await one.file()).syncId).toBe('store-same');
  });

  it('refuses a version it has no migration for', async () => {
    const fs = new MemoryAdapter('future', { clock: () => tick() });
    const raw = { ...v2File('future', 'store-1', true), version: CURRENT_VERSION + 1 };
    await fs.write('.vfs/vfs.json', encoder.encode(JSON.stringify(raw)));
    const ahead = await VFSNode.open(fs, { id: 'future', now: () => tick() });
    const here = await peer('here');

    const error = await pairedError(here.node, ahead);
    expect(error.reason).toBe('version-unreconcilable');
    expect(error.b.version).toBe(CURRENT_VERSION + 1);
  });

  it('writes back the version it migrated to, not the one it read', () => {
    const file = decodeVFSFile(encoder.encode(JSON.stringify(v2File('device-a', 'store-1', true))));
    const round = decodeVFSFile(encodeVFSFile(file));
    // Written as a literal, a migrated file would claim v2 for ever and be
    // migrated again on every read.
    expect(round.version).toBe(CURRENT_VERSION);
  });
});

describe('the log migrates in the reader', () => {
  it('reads v2 and v3 rows out of one segment', async () => {
    const v3 = await makeRow({
      batch: 'b1',
      at: 2,
      peerId: 'device-a',
      uuid: 'u2',
      type: 'write',
      kind: 'file',
      path: 'b.txt',
      hash: 'a'.repeat(64),
      size: 1,
    });
    const legacy = JSON.stringify({
      op: 'c'.repeat(64),
      batch: 'b0',
      at: 1,
      peer: 'device-a',
      uuid: 'u1',
      type: 'write',
      kind: 'file',
      path: 'a.txt',
      hash: 'b'.repeat(64),
      size: 1,
    });

    const mixed = new Uint8Array([...encoder.encode(`${legacy}\n`), ...encodeRows([v3])]);
    const rows = parseRows(mixed);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.peerId)).toEqual(['device-a', 'device-a']);
  });

  it('keeps op ids stable across the rename', async () => {
    // `opId` hashes the *values*, joined by `|` — no key name enters it. That
    // is what lets closed segments stay untouched: a v2 row and its migrated
    // self are the same operation with the same identity, so history stays
    // comparable across the cut and the log digest never moves.
    const facts = {
      batch: 'b1',
      at: 7,
      peerId: 'device-a',
      uuid: 'u1',
      type: 'write' as const,
      kind: 'file' as const,
      path: 'a.txt',
      hash: 'd'.repeat(64),
      size: 1,
    };
    const fresh = await makeRow(facts);
    const legacy = parseRows(
      encoder.encode(
        `${JSON.stringify({ ...facts, peerId: undefined, peer: 'device-a', op: fresh.op })}\n`,
      ),
    )[0] as LogRow;

    expect(legacy.peerId).toBe('device-a');
    expect((await makeRow(legacy)).op).toBe(fresh.op);
  });
});

describe('reidentify', () => {
  it('mints a new identity and keeps the group', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'x.txt', 'x');
    await sync(a.node, b.node);
    const group = (await a.node.file()).syncId;

    const minted = await a.node.reidentify();

    expect(minted).not.toBe('a');
    expect(a.node.peerId).toBe(minted);
    expect((await a.node.file()).peerId).toBe(minted);
    // Reidentifying is not leaving the mesh. Clearing the group would turn a
    // repairable collision into a foreign-mesh, which is worse than the bug.
    expect((await a.node.file()).syncId).toBe(group);
  });

  it('repairs a copied .vfs so the two can sync', async () => {
    const a = await peer('twin');
    const b = await peer('twin');
    await put(a, 'x.txt', 'from the original');
    await expect(sync(a.node, b.node)).rejects.toThrow(/identify as peer twin/);

    await b.node.reidentify();

    await expect(sync(a.node, b.node)).resolves.toBeTruthy();
    expect(files(b)['x.txt']).toBe('from the original');
  });

  it('does not rewrite who made past changes', async () => {
    const a = await peer('a');
    await put(a, 'x.txt', 'written as a');
    await a.node.commit();

    await a.node.reidentify();

    // The entry records who changed it, and that is history.
    const entry = (await a.node.live()).find((item) => item.path === 'x.txt');
    expect(entry?.peerId).toBe('a');
    const rows = await a.node.store.logRows();
    expect(rows.every((row) => row.peerId === 'a')).toBe(true);
  });

  it('is undone by an imposed id, which is the case it cannot fix', async () => {
    const fs = new MemoryAdapter('imposed', { clock: () => tick() });
    const first = await VFSNode.open(fs, { id: 'derived-from-hostname', now: () => tick() });
    const minted = await first.reidentify();
    expect(minted).not.toBe('derived-from-hostname');

    // `options.id` overwrites the stored id on open, so a caller deriving it
    // from something non-unique gets the same collision straight back. The
    // library cannot tell this apart from a copied folder — hence the remedy
    // being offered rather than applied.
    const again = await VFSNode.open(fs, { id: 'derived-from-hostname', now: () => tick() });
    expect(again.peerId).toBe('derived-from-hostname');
  });
});
