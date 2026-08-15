import { describe, expect, it } from 'vitest';
import { History } from '../src/history.js';
import { defaultConflictName, mergeEntries, pairEntries } from '../src/merge.js';
import type { MergeSide } from '../src/merge.js';
import type { LogRow, VFSEntry } from '../src/types.js';

function entry(partial: Partial<VFSEntry> & { uuid: string; path: string }): VFSEntry {
  return {
    kind: 'file',
    hash: 'h',
    size: 1,
    created: 1000,
    updated: 1000,
    peerId: 'device-a',
    ...partial,
  };
}

const A = (...entries: VFSEntry[]): MergeSide => ({ peerId: 'device-a', entries });
const B = (...entries: VFSEntry[]): MergeSide => ({ peerId: 'device-b', entries });

/** The one-step chains `prev`/`prevPath` describe, with nothing else loaded. */
function inline(...entries: VFSEntry[]): History {
  return History.from([entries]);
}

describe('pairEntries', () => {
  it('matches by uuid', () => {
    const items = pairEntries(
      A(entry({ uuid: '1', path: 'a.md', hash: 'x' })),
      B(entry({ uuid: '1', path: 'a.md', hash: 'y' })),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.a?.hash).toBe('x');
    expect(items[0]?.b?.hash).toBe('y');
  });

  it('falls back to path when two peers discovered the same file independently', () => {
    const items = pairEntries(A(entry({ uuid: 'zzz', path: 'a.md' })), B(entry({ uuid: 'aaa', path: 'a.md' })));
    expect(items).toHaveLength(1);
    expect(items[0]?.uuid).toBe('aaa'); // smaller uuid becomes canonical
  });

  /**
   * The guard v1 got from the base tree. Without it, a file deleted and
   * recreated at the same path merges into the entry it replaced — and inherits
   * a history that is not its own.
   */
  it('does not pair by path when the other side already knows the uuid', () => {
    // B once had `zzz` and deleted it; the log still says so. A's `zzz` is
    // therefore not a file B has never seen, and must not merge into B's new one.
    const items = pairEntries(A(entry({ uuid: 'zzz', path: 'a.md' })), {
      ...B(entry({ uuid: 'aaa', path: 'a.md' })),
      knows: (uuid) => uuid === 'zzz',
    });
    expect(items).toHaveLength(2);
  });

  it('does not pair a file with a directory of the same name', () => {
    const items = pairEntries(
      A(entry({ uuid: 'zzz', path: 'photos', kind: 'directory', hash: null })),
      B(entry({ uuid: 'aaa', path: 'photos' })),
    );
    expect(items).toHaveLength(2);
  });

  it('leaves unrelated files as separate items', () => {
    expect(pairEntries(A(entry({ uuid: '1', path: 'a.md' })), B(entry({ uuid: '2', path: 'b.md' })))).toHaveLength(2);
  });

  /**
   * One name is not one file.
   *
   * Pairing these would rewrite one peer's uuid inside a mesh, and the peer that
   * was not in the room has no way to learn that it changed: it turns up later
   * holding an identity the others have moved on from, one path with two uuids,
   * and — when the bytes happen to match — a question nobody can answer. Two
   * files that want one name is a `path-collision`, which is a person's to
   * settle.
   */
  it('does not pair two files on one path when their content differs', () => {
    const items = pairEntries(
      A(entry({ uuid: 'zzz', path: 'a.md', hash: 'x' })),
      B(entry({ uuid: 'aaa', path: 'a.md', hash: 'y' })),
    );
    expect(items).toHaveLength(2);
  });

  it('pairs them when the bytes are identical, which proves they are one file', () => {
    const items = pairEntries(
      A(entry({ uuid: 'zzz', path: 'a.md', hash: 'same' })),
      B(entry({ uuid: 'aaa', path: 'a.md', hash: 'same' })),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.uuid).toBe('aaa');
  });

  it('pairs two directories, which are nothing but their path', () => {
    const dir = { kind: 'directory' as const, hash: null };
    const items = pairEntries(
      A(entry({ uuid: 'zzz', path: 'photos', ...dir })),
      B(entry({ uuid: 'aaa', path: 'photos', ...dir })),
    );
    expect(items).toHaveLength(1);
  });

  /**
   * A folder that has never synced has no identities to lose, so its paths take
   * the mesh's uuids — including for a file whose content differs, which is then
   * an ordinary two-version conflict on one identity rather than two files
   * fighting over a name.
   */
  it('gives the mesh identity to the side that has never synced', () => {
    const joining = { ...A(entry({ uuid: 'aaa', path: 'a.md', hash: 'x' })), joining: true };
    const items = pairEntries(joining, B(entry({ uuid: 'zzz', path: 'a.md', hash: 'y' })));
    expect(items).toHaveLength(1);
    // `zzz` sorts after `aaa` and still wins: the joiner yields whatever it is called.
    expect(items[0]?.uuid).toBe('zzz');
  });
});

describe('mergeEntries', () => {
  it('takes the side that changed', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: 'new', updated: 2000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'old' });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts).toHaveLength(0);
    expect(entries[0]?.hash).toBe('new');
  });

  it('unions files that only one side has', () => {
    const { entries } = mergeEntries(A(entry({ uuid: '1', path: 'a.md' })), B(entry({ uuid: '2', path: 'b.md' })));
    expect(entries.map((item) => item.path)).toEqual(['a.md', 'b.md']);
  });

  /**
   * The case v1 could not have: the entry is simply absent on the far side, and
   * so is any tombstone. Only the log knows it was deleted, and without asking
   * it the file comes back to life.
   */
  it('deletes rather than resurrects when only the log remembers the delete', () => {
    const stale = entry({ uuid: '1', path: 'a.md', updated: 50 });
    const history = History.from([
      [{ uuid: '1', at: 100, type: 'delete', path: 'a.md' } as unknown as LogRow],
    ]);

    const { entries } = mergeEntries(A(stale), B(), { history });
    expect(entries[0]?.deleted).toBe(true);
    expect(entries[0]?.updated).toBe(100);
  });

  it('takes an entry the other side has genuinely never seen', () => {
    const fresh = entry({ uuid: '1', path: 'a.md', updated: 50 });
    const { entries } = mergeEntries(A(fresh), B(), { history: new History() });
    expect(entries[0]?.deleted).toBeUndefined();
  });

  it('resolves a real conflict in favour of the newer updated', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: 'x', updated: 1000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'y', updated: 2000, prev: 'old', peerId: 'device-b' });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts[0]?.kind).toBe('content');
    expect(conflicts[0]?.winner).toBe('b');
    expect(entries.find((item) => item.path === 'a.md')?.hash).toBe('y');
  });

  /**
   * Two edits of the same parent both "appear" in the log, one before the
   * other. That is the canonical conflict, not a propagation — the question is
   * ancestry, and neither is an ancestor of the other.
   */
  it('calls divergence from a shared parent a conflict, not a propagation', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: 'x', updated: 1000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'y', updated: 2000, prev: 'old', peerId: 'device-b' });
    const history = History.from([
      [
        { uuid: '1', at: 500, type: 'write', path: 'a.md', hash: 'old', prev: null } as unknown as LogRow,
        { uuid: '1', at: 1000, type: 'write', path: 'a.md', hash: 'x', prev: 'old' } as unknown as LogRow,
        { uuid: '1', at: 2000, type: 'write', path: 'a.md', hash: 'y', prev: 'old' } as unknown as LogRow,
      ],
    ]);
    expect(mergeEntries(A(a), B(b), { history }).conflicts).toHaveLength(1);
  });

  it('follows the chain more than one step back before crying conflict', () => {
    // A went old -> mid -> new while B stayed on old. Nothing inline says so.
    const a = entry({ uuid: '1', path: 'a.md', hash: 'new', updated: 3000, prev: 'mid' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'old', updated: 1000 });
    const history = History.from([
      [
        { uuid: '1', at: 2000, type: 'write', path: 'a.md', hash: 'mid', prev: 'old' } as unknown as LogRow,
      ],
      [a, b],
    ]);
    expect(mergeEntries(A(a), B(b), { history }).conflicts).toHaveLength(0);
  });

  it('keeps the losing version as a conflict copy', () => {
    const a = entry({ uuid: '1', path: 'notes.md', hash: 'aaaaaaaa11', updated: 1000, prev: 'old' });
    const b = entry({
      uuid: '1',
      path: 'notes.md',
      hash: 'bbbbbbbb22',
      updated: 2000,
      prev: 'old',
      peerId: 'device-b',
    });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    const copy = entries.find((item) => item.path !== 'notes.md');

    expect(copy?.path).toBe('notes (conflict device-a aaaaaaaa).md');
    expect(copy?.hash).toBe('aaaaaaaa11');
    expect(copy?.conflictOf).toBe('1');
    expect(copy?.reason).toBe('binary');
    expect(conflicts[0]?.copy?.uuid).toBe('conflict:1:aaaaaaaa11');
  });

  it('produces the same conflict copy when re-merged', () => {
    const a = entry({ uuid: '1', path: 'notes.md', hash: 'x1', updated: 1000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'notes.md', hash: 'y2', updated: 2000, prev: 'old', peerId: 'device-b' });

    const first = mergeEntries(A(a), B(b), { history: inline(a, b) }).entries;
    const second = mergeEntries(A(...first), B(b), { history: inline(a, b) }).entries;
    expect(second.filter((item) => item.path.includes('conflict'))).toHaveLength(1);
  });

  it('leaves a large conflict copy on the peer that made it', () => {
    const a = entry({ uuid: '1', path: 'game.bin', hash: 'aaa', updated: 1000, size: 700, prev: 'old' });
    const b = entry({
      uuid: '1',
      path: 'game.bin',
      hash: 'bbb',
      updated: 2000,
      size: 700,
      prev: 'old',
      peerId: 'device-b',
    });

    const { entries } = mergeEntries(A(a), B(b), { history: inline(a, b), heldAt: 100 });
    expect(entries.find((item) => item.conflictOf)?.held).toBe('device-a');
  });

  it('merges a rename on one side with an edit on the other', () => {
    const a = entry({ uuid: '1', path: 'renamed.md', hash: 'old', updated: 2000, prevPath: 'a.md' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'edited', updated: 3000, prev: 'old', peerId: 'device-b' });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts).toHaveLength(0);
    expect(entries[0]).toMatchObject({ path: 'renamed.md', hash: 'edited', prevPath: 'a.md' });
  });

  it('takes a rename from either side', () => {
    const still = entry({ uuid: '1', path: 'a.md', hash: 'old' });
    const moved = entry({ uuid: '1', path: 'moved.md', hash: 'old', updated: 2000, prevPath: 'a.md' });

    expect(mergeEntries(A(still), B(moved), { history: inline(moved) }).entries[0]?.path).toBe('moved.md');
    expect(mergeEntries(A(moved), B(still), { history: inline(moved) }).entries[0]?.path).toBe('moved.md');
  });

  /** `a -> b -> c` against a peer still sitting at `a` is a propagation, however far the chain runs. */
  it('follows a rename chain to any distance', () => {
    const moved = entry({ uuid: '1', path: 'c.md', hash: 'old', updated: 3000, prevPath: 'b.md' });
    const behind = entry({ uuid: '1', path: 'a.md', hash: 'old', updated: 1000 });
    const history = History.from([
      [
        { uuid: '1', at: 2000, type: 'rename', path: 'b.md', prevPath: 'a.md' } as unknown as LogRow,
      ],
      [moved],
    ]);

    const { entries, conflicts } = mergeEntries(A(moved), B(behind), { history });
    expect(entries[0]?.path).toBe('c.md');
    expect(conflicts).toHaveLength(0);
  });

  it('resolves two different renames as a location conflict', () => {
    const a = entry({ uuid: '1', path: 'left.md', hash: 'same', updated: 1000, prevPath: 'a.md' });
    const b = entry({ uuid: '1', path: 'right.md', hash: 'same', updated: 2000, prevPath: 'a.md', peerId: 'device-b' });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('location');
    expect(entries[0]).toMatchObject({ path: 'right.md' });
    // Content never diverged, so there is nothing to keep a copy of.
    expect(conflicts[0]?.copy).toBeUndefined();
    expect(entries).toHaveLength(1);
  });

  it('reports a content conflict rather than a location one when both differ', () => {
    const a = entry({ uuid: '1', path: 'left.md', hash: 'x', updated: 1000, prev: 'old', prevPath: 'a.md' });
    const b = entry({
      uuid: '1',
      path: 'right.md',
      hash: 'y',
      updated: 2000,
      prev: 'old',
      prevPath: 'a.md',
      peerId: 'device-b',
    });
    const { conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('content'); // the more serious of the two
  });

  it('breaks an updated tie deterministically instead of by argument order', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: 'aaa', updated: 5000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'bbb', updated: 5000, prev: 'old', peerId: 'device-b' });

    const left = mergeEntries(A(a), B(b), { history: inline(a, b) }).entries.find(
      (item) => item.path === 'a.md',
    );
    const right = mergeEntries(A(b), B(a), { history: inline(a, b) }).entries.find(
      (item) => item.path === 'a.md',
    );

    expect(left?.hash).toBe('bbb'); // higher hash wins the tie
    expect(right?.hash).toBe(left?.hash);
  });

  it('reports delete-versus-edit and lets the newer side win', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: null, deleted: true, updated: 3000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'edited', updated: 2000, prev: 'old', peerId: 'device-b' });

    const { entries, conflicts } = mergeEntries(A(a), B(b), { history: inline(a, b) });
    expect(conflicts[0]?.kind).toBe('delete-edit');
    expect(entries[0]?.deleted).toBe(true);
    // Default policy is 'edits': a winning delete really deletes.
    expect(conflicts[0]?.copy).toBeUndefined();
  });

  it("keeps the edited version under conflictCopies: 'always'", () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: null, deleted: true, updated: 3000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'edited', updated: 2000, prev: 'old', peerId: 'device-b' });

    const { conflicts } = mergeEntries(A(a), B(b), {
      history: inline(a, b),
      conflictCopies: 'always',
    });
    expect(conflicts[0]?.copy?.hash).toBe('edited');
    expect(conflicts[0]?.copy?.reason).toBe('delete-edit');
  });

  it('is symmetric: swapping the peers yields the same content', () => {
    const a = entry({ uuid: '1', path: 'a.md', hash: 'x', updated: 1000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'a.md', hash: 'y', updated: 2000, prev: 'old', peerId: 'device-b' });

    const left = mergeEntries(A(a), B(b), { history: inline(a, b) }).entries;
    const right = mergeEntries(A(b), B(a), { history: inline(a, b) }).entries;
    expect(left.map((item) => [item.path, item.hash])).toEqual(right.map((item) => [item.path, item.hash]));
  });

  it('flags a text conflict for the three-way path without resolving it itself', () => {
    const a = entry({ uuid: '1', path: 'list.xml', hash: 'x', updated: 1000, prev: 'old' });
    const b = entry({ uuid: '1', path: 'list.xml', hash: 'y', updated: 2000, prev: 'old', peerId: 'device-b' });

    const { conflicts } = mergeEntries(A(a), B(b), {
      history: inline(a, b),
      text: (path) => path.endsWith('.xml'),
    });
    expect(conflicts[0]?.text).toBe(true);
  });
});

describe('directories', () => {
  it('carries an empty folder across, which v1 could not', () => {
    const dir = entry({ uuid: 'd', path: 'photos', kind: 'directory', hash: null, size: 0 });
    const { entries } = mergeEntries(A(dir), B());
    expect(entries[0]).toMatchObject({ path: 'photos', kind: 'directory' });
  });

  /**
   * A file and a folder claiming one path. Parking the loser is not a local
   * edit: a directory moves with everything under it, in one go, or the tree is
   * inconsistent halfway through.
   */
  it('moves a losing directory aside with its whole subtree', () => {
    const dir = entry({
      uuid: 'd',
      path: 'photos',
      kind: 'directory',
      hash: null,
      size: 0,
      updated: 1000,
    });
    const child = entry({ uuid: 'c', path: 'photos/one.jpg', hash: 'c1', updated: 1000 });
    const file = entry({ uuid: 'f', path: 'photos', hash: 'f1', updated: 5000, peerId: 'device-b' });

    const { entries, conflicts } = mergeEntries(A(dir, child), B(file));
    const paths = entries.map((item) => item.path).sort();

    expect(paths).toContain('photos'); // the winner keeps the name
    expect(entries.find((item) => item.uuid === 'f')?.path).toBe('photos');
    const moved = entries.find((item) => item.uuid === 'd')?.path as string;
    expect(moved).not.toBe('photos');
    expect(entries.find((item) => item.uuid === 'c')?.path).toBe(`${moved}/one.jpg`);
    expect(conflicts.some((item) => item.kind === 'kind')).toBe(true);
  });

  /**
   * Moving a loser aside can collide in turn. A conflict copy derives its name
   * from the path, the peer and the hash of the version it parks, and so does
   * the aside name of a colliding entry — so a version copied here and another
   * entry carrying that same version land on the identical name.
   *
   * Two live entries on one path is the one thing the tree may not contain:
   * whichever is written second wins on disk and the other is silently gone.
   */
  it('resolves a collision the first pass created', () => {
    const winner = entry({ uuid: 'u1', path: 'notes.md', hash: 'hA', updated: 3000 });
    const loser = entry({ uuid: 'u1', path: 'notes.md', hash: 'hL', peerId: 'device-b', updated: 1000 });
    // Same peer and same hash as the loser, so it derives the same aside name.
    const twin = entry({ uuid: 'u2', path: 'notes.md', hash: 'hL', peerId: 'device-b', updated: 2000 });

    const { entries } = mergeEntries(A(winner, twin), B(loser), { conflictCopies: 'always' });

    const live = entries.filter((item) => !item.deleted).map((item) => item.path);
    expect(new Set(live).size).toBe(live.length);
    expect(entries.find((item) => item.uuid === 'u1')?.path).toBe('notes.md');
  });
});

describe('defaultConflictName', () => {
  it('keeps the extension and the folder', () => {
    expect(
      defaultConflictName({
        path: 'docs/notes.md',
        peerId: 'device-b',
        hash: '1f4a9c2e0000',
        entry: entry({ uuid: '1', path: 'docs/notes.md' }),
      }),
    ).toBe('docs/notes (conflict device-b 1f4a9c2e).md');
  });

  it('handles extensionless names', () => {
    expect(
      defaultConflictName({
        path: 'LICENSE',
        peerId: 'p',
        hash: 'abcdef1234',
        entry: entry({ uuid: '1', path: 'LICENSE' }),
      }),
    ).toBe('LICENSE (conflict p abcdef12)');
  });
});

describe('History', () => {
  it('reads a log row and an entry as the same kind of link', () => {
    const history = History.from([
      [{ uuid: '1', at: 10, type: 'write', path: 'a.md', hash: 'mid', prev: 'old' } as unknown as LogRow],
      [entry({ uuid: '1', path: 'a.md', hash: 'new', prev: 'mid', updated: 20 })],
    ]);
    expect(history.descends('1', 'new', 'old')).toBe(true);
    expect(history.descends('1', 'old', 'new')).toBe(false);
    // Nothing to descend from is not an ancestry claim.
    expect(history.descends('1', 'new', null)).toBe(false);
  });

  it('keeps the latest record of a uuid, whichever source it came from', () => {
    const history = History.from([
      [{ uuid: '1', at: 10, type: 'write', path: 'a.md', hash: 'h' } as unknown as LogRow],
      [{ uuid: '1', at: 30, type: 'delete', path: 'a.md' } as unknown as LogRow],
      [{ uuid: '1', at: 20, type: 'write', path: 'a.md', hash: 'h2' } as unknown as LogRow],
    ]);
    expect(history.last('1')).toMatchObject({ at: 30, deleted: true });
    expect(history.last('nobody')).toBeUndefined();
  });

  it('finds the nearest common ancestor, or says there is none', () => {
    const history = History.from([
      [
        { uuid: '1', at: 1, type: 'write', path: 'a', hash: 'base', prev: null } as unknown as LogRow,
        { uuid: '1', at: 2, type: 'write', path: 'a', hash: 'left', prev: 'base' } as unknown as LogRow,
        { uuid: '1', at: 3, type: 'write', path: 'a', hash: 'right', prev: 'base' } as unknown as LogRow,
      ],
    ]);
    expect(history.commonAncestor('1', { hash: 'left' }, { hash: 'right' })).toBe('base');
    expect(history.commonAncestor('1', { hash: 'left' }, { hash: 'unrelated' })).toBeNull();
  });

  it('walks a path chain without looping on a cycle', () => {
    const history = History.from([
      [
        { uuid: '1', at: 1, type: 'rename', path: 'b', prevPath: 'a' } as unknown as LogRow,
        { uuid: '1', at: 2, type: 'rename', path: 'a', prevPath: 'b' } as unknown as LogRow,
      ],
    ]);
    expect(history.movedFrom('1', 'b', 'b')).toBe(true);
    expect(history.movedFrom('1', 'b', 'nowhere')).toBe(false);
  });
});
