import { describe, expect, it } from 'vitest';
import { defaultConflictName, mergeTrees, pairEntries } from '../src/merge.js';
import type { Tree, TreeEntry } from '../src/types.js';

function entry(partial: Partial<TreeEntry> & { id: string; path: string }): TreeEntry {
  return { hash: 'h', size: 1, mtime: 1000, ...partial };
}

function tree(...entries: TreeEntry[]): Tree {
  return { entries };
}

const options = { peerA: 'device-a', peerB: 'device-b' };

describe('pairEntries', () => {
  it('matches by id', () => {
    const base = tree(entry({ id: '1', path: 'a.md' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: 'x' }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'y' }));

    const items = pairEntries(base, a, b);
    expect(items).toHaveLength(1);
    expect(items[0]?.a?.hash).toBe('x');
    expect(items[0]?.b?.hash).toBe('y');
  });

  it('falls back to path when two peers discovered the same file independently', () => {
    const a = tree(entry({ id: 'zzz', path: 'a.md' }));
    const b = tree(entry({ id: 'aaa', path: 'a.md' }));

    const items = pairEntries({ entries: [] }, a, b);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('aaa'); // smaller id becomes canonical
  });

  it('leaves unrelated files as separate items', () => {
    const a = tree(entry({ id: '1', path: 'a.md' }));
    const b = tree(entry({ id: '2', path: 'b.md' }));
    expect(pairEntries({ entries: [] }, a, b)).toHaveLength(2);
  });
});

describe('mergeTrees', () => {
  it('takes the side that changed', () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: 'new', mtime: 2000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));

    const { tree: merged, conflicts } = mergeTrees(base, a, b, options);
    expect(conflicts).toHaveLength(0);
    expect(merged.entries[0]?.hash).toBe('new');
  });

  it('unions files that only one side has', () => {
    const a = tree(entry({ id: '1', path: 'a.md' }));
    const b = tree(entry({ id: '2', path: 'b.md' }));

    const { tree: merged } = mergeTrees({ entries: [] }, a, b, options);
    expect(merged.entries.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('resolves a real conflict in favour of the newer mtime', () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: 'x', mtime: 1000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'y', mtime: 2000 }));

    const { tree: merged, conflicts } = mergeTrees(base, a, b, options);
    expect(conflicts[0]?.kind).toBe('content');
    expect(conflicts[0]?.winner).toBe('b');
    expect(merged.entries.find((e) => e.path === 'a.md')?.hash).toBe('y');
  });

  it('keeps the losing version as a conflict copy', () => {
    const base = tree(entry({ id: '1', path: 'notes.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'notes.md', hash: 'aaaaaaaa11', mtime: 1000 }));
    const b = tree(entry({ id: '1', path: 'notes.md', hash: 'bbbbbbbb22', mtime: 2000 }));

    const { tree: merged, conflicts } = mergeTrees(base, a, b, options);
    const copy = merged.entries.find((e) => e.path !== 'notes.md');

    expect(copy?.path).toBe('notes (conflict device-a aaaaaaaa).md');
    expect(copy?.hash).toBe('aaaaaaaa11');
    expect(conflicts[0]?.copy?.id).toBe('conflict:1:aaaaaaaa11');
  });

  it('produces the same conflict copy when re-merged', () => {
    const base = tree(entry({ id: '1', path: 'notes.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'notes.md', hash: 'x1', mtime: 1000 }));
    const b = tree(entry({ id: '1', path: 'notes.md', hash: 'y2', mtime: 2000 }));

    const first = mergeTrees(base, a, b, options).tree;
    const second = mergeTrees(base, first, b, options).tree;

    expect(second.entries.filter((e) => e.path.includes('conflict'))).toHaveLength(1);
  });

  it('merges a rename on one side with an edit on the other', () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'renamed.md', hash: 'old', mtime: 2000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'edited', mtime: 3000 }));

    const { tree: merged, conflicts } = mergeTrees(base, a, b, options);
    expect(conflicts).toHaveLength(0);
    expect(merged.entries[0]).toMatchObject({
      path: 'renamed.md',
      hash: 'edited',
      renamedFrom: 'a.md',
    });
  });

  it('reports delete-versus-edit and lets the newer side win', () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: null, deleted: true, mtime: 3000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'edited', mtime: 2000 }));

    const { tree: merged, conflicts } = mergeTrees(base, a, b, options);
    expect(conflicts[0]?.kind).toBe('delete-edit');
    expect(merged.entries[0]?.deleted).toBe(true);
    // default policy is 'edits': a winning delete really deletes
    expect(conflicts[0]?.copy).toBeUndefined();
  });

  it("keeps the edited version under conflictCopies: 'always'", () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: null, deleted: true, mtime: 3000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'edited', mtime: 2000 }));

    const { conflicts } = mergeTrees(base, a, b, { ...options, conflictCopies: 'always' });
    expect(conflicts[0]?.copy?.hash).toBe('edited');
  });

  it('is symmetric: swapping the peers yields the same content', () => {
    const base = tree(entry({ id: '1', path: 'a.md', hash: 'old' }));
    const a = tree(entry({ id: '1', path: 'a.md', hash: 'x', mtime: 1000 }));
    const b = tree(entry({ id: '1', path: 'a.md', hash: 'y', mtime: 2000 }));

    const left = mergeTrees(base, a, b, options).tree;
    const right = mergeTrees(base, b, a, { peerA: 'device-b', peerB: 'device-a' }).tree;

    expect(left.entries.map((e) => [e.path, e.hash]).sort()).toEqual(
      right.entries.map((e) => [e.path, e.hash]).sort(),
    );
  });
});

describe('defaultConflictName', () => {
  it('keeps the extension and the folder', () => {
    const name = defaultConflictName({
      path: 'docs/notes.md',
      peer: 'device-b',
      hash: '1f4a9c2e0000',
      entry: entry({ id: '1', path: 'docs/notes.md' }),
    });
    expect(name).toBe('docs/notes (conflict device-b 1f4a9c2e).md');
  });

  it('handles extensionless names', () => {
    const name = defaultConflictName({
      path: 'LICENSE',
      peer: 'p',
      hash: 'abcdef1234',
      entry: entry({ id: '1', path: 'LICENSE' }),
    });
    expect(name).toBe('LICENSE (conflict p abcdef12)');
  });
});
