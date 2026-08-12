import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { encodeRows, makeRow, parseRows } from '../src/log.js';
import { sync, syncDryRun, syncMesh, syncUntilStable, PairingError } from '../src/sync.js';
import { CURRENT_VERSION, decodeVFSFile, encodeVFSFile, migrateFile } from '../src/vfs-file.js';
import { VFSNode } from '../src/vfs-node.js';
import type { LogRow } from '../src/types.js';
import { encoder, files, peer, put, tick } from './helpers.js';

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

async function pairedError(a: VFSNode, b: VFSNode): Promise<PairingError> {
  try {
    await sync(a, b);
  } catch (error) {
    return error as PairingError;
  }
  throw new Error('expected the guard to stop this pairing');
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

    await syncDryRun(a.node, b.node);

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
    expect(error).toBeInstanceOf(PairingError);
    expect(error.code).toBe('peer-collision');
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
    expect(error.code).toBe('foreign-mesh');
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

    // Ask first, do not rescue afterwards.
    await expect(syncDryRun(b.node, c.node)).rejects.toThrow(PairingError);
    expect((await b.node.file()).syncId).toBe(groupB);
    expect(files(b)).not.toHaveProperty('y.txt');
  });

  it('merges when the caller names one of the reported ids', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    const d = await peer('d');
    await put(a, 'x.txt', 'x');
    await put(c, 'y.txt', 'y');
    await sync(a.node, b.node);
    await sync(c.node, d.node);

    const error = await pairedError(b.node, c.node);
    await sync(b.node, c.node, { adopt: { syncId: error.a.syncId as string } });

    expect(files(b)['y.txt']).toBe('y');
    // Authorised, then ordinary: the smaller of the two survives.
    const survivor = [error.a.syncId, error.b.syncId].sort()[0];
    expect((await b.node.file()).syncId).toBe(survivor);
    expect((await c.node.file()).syncId).toBe(survivor);
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

    expect(results[0]?.error).toBeInstanceOf(PairingError);
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
    expect(error.code).toBe('version-unreconcilable');
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
