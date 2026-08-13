import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { IGNORE_FILE, matchIgnore, parseIgnore } from '../src/ignore.js';
import { VFSNode } from '../src/vfs-node.js';
import { counting, encoder, files, peer, put, sync, tick } from './helpers.js';

/**
 * Phase 3: exclusion rules with a file format.
 *
 * Three sources, composed by union — the shared `.vfsignore`, this node's
 * `local.ignore`, and the constructor predicate. No negation, so no two rules
 * can disagree and there is no precedence to define between them.
 *
 * This only became safe with phase 1. Distributing a rule *was* the mechanism
 * that triggered the data loss: a rule covering a tracked file used to emit a
 * tombstone, and the peer that lost the file was the one that had not received
 * the rule yet.
 */

const match = (pattern: string, path: string): boolean => matchIgnore(parseIgnore(pattern), path);

describe('the pattern language', () => {
  it('anchors on a leading slash and floats without one', () => {
    expect(match('/docs/notes.md', 'docs/notes.md')).toBe(true);
    expect(match('/docs/notes.md', 'albums/docs/notes.md')).toBe(false);
    // The one place a gitignore instinct is wrong: there, an interior slash
    // anchors implicitly. Here the leading slash is the only anchor.
    expect(match('docs/notes.md', 'albums/docs/notes.md')).toBe(true);
    expect(match('docs/notes.md', 'docs/notes.md')).toBe(true);
  });

  it('covers the subtree of whatever it matches', () => {
    expect(match('.cache/', '.cache')).toBe(true);
    expect(match('.cache/', '.cache/deep/blob.bin')).toBe(true);
    expect(match('.cache/', 'albums/.cache/x')).toBe(true);
    expect(match('/.cache/', 'albums/.cache')).toBe(false);
  });

  it('matches a bare name at any depth, which is the whole point', () => {
    // OS junk turns up in every folder — in a catalogue with one folder per
    // album that is hundreds of files that change on their own.
    expect(match('*.tmp', 'a.tmp')).toBe(true);
    expect(match('*.tmp', 'albums/Kind of Blue/a.tmp')).toBe(true);
    expect(match('._*', 'albums/._cover.jpg')).toBe(true);
    expect(match('@eaDir', 'albums/@eaDir/thumb.png')).toBe(true);
    expect(match('.DS_Store', '.DS_Store')).toBe(true);
  });

  it('never lets `*` cross a folder boundary', () => {
    expect(match('a*b', 'x/aQQb')).toBe(true);
    expect(match('a*b', 'x/a/b')).toBe(false);
    expect(match('*.tmp', 'a.tmpx')).toBe(false);
  });

  it('does not match a prefix of a segment', () => {
    expect(match('docs/notes.md', 'docs/notes.md.bak')).toBe(false);
    expect(match('docs/notes.md', 'docs')).toBe(false);
  });

  it('drops comments, blanks and stray whitespace', () => {
    const rules = parseIgnore('# junk\n\n  *.tmp  \n#*.md\n');
    expect(rules).toHaveLength(1);
    expect(matchIgnore(rules, 'a.tmp')).toBe(true);
    expect(matchIgnore(rules, 'a.md')).toBe(false);
  });

  it('compiles nothing rather than throwing on a useless line', () => {
    // These arrive from other peers. A bad line has to be inert, not fatal.
    expect(parseIgnore('/\n//\n   \n')).toEqual([]);
  });
});

describe('.vfsignore travels', () => {
  it('reaches a peer and is in force on its next scan', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'albums/track.flac', 'audio');
    await put(b, 'albums/@eaDir/thumb.png', 'junk from the NAS');
    await sync(a.node, b.node);
    expect(files(a)['albums/@eaDir/thumb.png']).toBe('junk from the NAS');

    // The rule is ordinary content: A writes it, it syncs like anything else.
    await put(a, IGNORE_FILE, '@eaDir\n');
    await sync(a.node, b.node);
    await sync(a.node, b.node);

    // Now neither side watches it. The file stays where it is on both.
    await b.node.commit();
    const tracked = (await b.node.live()).map((entry) => entry.path);
    expect(tracked).toContain('albums/track.flac');
    expect(files(b)['albums/@eaDir/thumb.png']).toBe('junk from the NAS');
  });

  it('does not delete a tracked file it starts covering', async () => {
    // The regression phase 1 exists for, now driven through the real
    // distribution mechanism rather than a hand-passed predicate.
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'notes.tmp', 'tracked before the rule');
    await sync(a.node, b.node);

    await put(a, IGNORE_FILE, '*.tmp\n');
    await sync(a.node, b.node);
    await sync(a.node, b.node);

    expect(files(a)['notes.tmp']).toBe('tracked before the rule');
    expect(files(b)['notes.tmp']).toBe('tracked before the rule');
    for (const node of [a.node, b.node]) {
      const entry = (await node.entries()).find((item) => item.path === 'notes.tmp');
      expect(entry?.deleted).toBeFalsy();
    }
  });

  it('keeps a newly created ignored file out of the tree', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, IGNORE_FILE, '*.tmp\n');
    await sync(a.node, b.node);

    await put(a, 'scratch.tmp', 'never tracked');
    await a.node.commit();
    await sync(a.node, b.node);

    expect((await a.node.live()).map((entry) => entry.path)).not.toContain('scratch.tmp');
    expect(files(b)).not.toHaveProperty('scratch.tmp');
  });
});

describe('the rules file cannot exclude itself', () => {
  it('is walked even when a rule names it exactly', async () => {
    const a = await peer('a');
    const b = await peer('b');
    // A peer could ship this, and every other one has to survive receiving it.
    await put(a, IGNORE_FILE, '.vfsignore\n*.tmp\n');
    await a.node.commit();

    expect((await a.node.live()).map((entry) => entry.path)).toContain(IGNORE_FILE);
    await sync(a.node, b.node);
    expect(files(b)[IGNORE_FILE]).toBe('.vfsignore\n*.tmp\n');
  });

  it('refuses the same rule from the local API, where the caller is present', async () => {
    const a = await peer('a');
    await expect(a.node.setLocalIgnore(['.vfsignore'])).rejects.toThrow(/may not exclude/);
    await expect(a.node.setLocalIgnore(['*.vfsignore'])).rejects.toThrow(/may not exclude/);
    expect((await a.node.file()).local.ignore).toBeUndefined();
  });
});

describe('local rules', () => {
  it('apply here and do not travel', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await put(a, 'keep.md', 'shared');
    await put(a, 'build/out.js', 'local build output');
    await a.node.setLocalIgnore(['build/']);
    await sync(a.node, b.node);

    expect((await a.node.live()).map((entry) => entry.path)).not.toContain('build/out.js');
    // The rule stayed home: B's header knows nothing about it.
    expect((await b.node.file()).local.ignore).toBeUndefined();
    expect(files(b)['keep.md']).toBe('shared');
  });

  it('survive a reopen, because they are in the header', async () => {
    const fs = new MemoryAdapter('a', { clock: () => tick() });
    const first = await VFSNode.open(fs, { id: 'a', now: () => tick() });
    await first.setLocalIgnore(['*.tmp']);

    const again = await VFSNode.open(fs, { id: 'a', now: () => tick() });
    await again.write('x.tmp', encoder.encode('junk'));
    await again.commit();

    expect((await again.live()).map((entry) => entry.path)).not.toContain('x.tmp');
  });

  it('compose with the shared file by union', async () => {
    const a = await peer('a');
    await put(a, IGNORE_FILE, '*.tmp\n');
    await a.node.setLocalIgnore(['build/']);
    await put(a, 'a.tmp', 'covered by the shared file');
    await put(a, 'build/out.js', 'covered by the local rule');
    await put(a, 'keep.md', 'covered by neither');
    await a.node.commit();

    const tracked = (await a.node.live()).map((entry) => entry.path);
    expect(tracked).toContain('keep.md');
    expect(tracked).not.toContain('a.tmp');
    expect(tracked).not.toContain('build/out.js');
  });
});

describe('reading the rules file', () => {
  it('is not re-read while its hash has not moved', async () => {
    const base = new MemoryAdapter('a', { clock: () => tick() });
    const { adapter, calls } = counting(base);
    const node = await VFSNode.open(adapter, { id: 'a', now: () => tick() });
    await node.write(IGNORE_FILE, encoder.encode('*.tmp\n'));
    await node.commit();

    calls.reset();
    await node.commit();
    await node.commit();

    // On Drive each of these is a round trip, on the one path built to avoid
    // them. The hash is already in the tree, so it is the cache key.
    expect(calls.read.filter((path) => path === IGNORE_FILE)).toEqual([]);
  });

  it('picks the new rules up in the pass they appear in', async () => {
    const a = await peer('a');
    await put(a, IGNORE_FILE, '*.tmp\n');
    await put(a, 'a.log', 'tracked before the rule');
    await a.node.commit();
    expect((await a.node.live()).map((entry) => entry.path)).toContain('a.log');

    // Widen the rule and create a file it covers, in one go. The walk runs with
    // the old rules, sees `.vfsignore` changed, and redoes the pass — so the
    // new file is never tracked, rather than tracked now and ignored later.
    await put(a, IGNORE_FILE, '*.tmp\n*.log\n');
    await put(a, 'b.log', 'created under the new rule');
    await a.node.commit();

    const tracked = (await a.node.live()).map((entry) => entry.path);
    expect(tracked).not.toContain('b.log');
    // And the one that was already tracked is preserved, not deleted. A rule
    // governs what is watched, not what exists — phase 1's guarantee.
    expect(tracked).toContain('a.log');
    expect(files(a)['a.log']).toBe('tracked before the rule');
  });

  it('does not fail a scan when the entry has no file behind it', async () => {
    // A peer holding the catalogue without the bytes (§2 of phase 2) still has
    // to scan. Missing rules are no rules, not an error.
    const a = await peer('a');
    await put(a, IGNORE_FILE, '*.tmp\n');
    await put(a, 'keep.md', 'content');
    await a.node.commit();
    await a.fs.delete(IGNORE_FILE);

    await expect(a.node.commit()).resolves.not.toThrow();
  });
});
