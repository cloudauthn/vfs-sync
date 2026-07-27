import { describe, expect, it } from 'vitest';
import { MAX_TEXT_MERGE, diff3, splitLines } from '../src/diff3.js';

const ok = (result: ReturnType<typeof diff3>): string => {
  if (!result.ok) throw new Error(`expected a clean merge, got ${result.reason}`);
  return result.text;
};

describe('splitLines', () => {
  it('keeps terminators, so joining is the original text', () => {
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb').join('')).toBe('a\nb');
  });
});

describe('diff3', () => {
  const base = 'one\ntwo\nthree\n';

  it('takes non-overlapping edits from both sides', () => {
    expect(ok(diff3(base, 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n'))).toBe('ONE\ntwo\nTHREE\n');
  });

  it('takes an edit from whichever side made it', () => {
    expect(ok(diff3(base, base, 'one\ntwo\nTHREE\n'))).toBe('one\ntwo\nTHREE\n');
    expect(ok(diff3(base, 'one\ntwo\nTHREE\n', base))).toBe('one\ntwo\nTHREE\n');
  });

  it('merges an insert against an unrelated delete', () => {
    expect(ok(diff3(base, 'one\ntwo\nthree\nfour\n', 'two\nthree\n'))).toBe('two\nthree\nfour\n');
  });

  it('is not a conflict when both sides made the same edit', () => {
    expect(ok(diff3(base, 'one\nTWO\nthree\n', 'one\nTWO\nthree\n'))).toBe('one\nTWO\nthree\n');
  });

  it('refuses overlapping edits rather than writing markers', () => {
    const result = diff3(base, 'one\nLEFT\nthree\n', 'one\nRIGHT\nthree\n');
    expect(result).toEqual({ ok: false, reason: 'block' });
    // Nothing about the API can produce a `<<<<<<<` in a working file.
    expect(JSON.stringify(result)).not.toContain('<<<');
  });

  it('treats edits to adjacent lines as one region', () => {
    expect(diff3(base, 'one\nTWO\nthree\n', 'one\ntwo\nTHREE\nfour\n').ok).toBe(true);
    expect(diff3('a\nb\nc\n', 'a\nB1\nc\n', 'a\nb\nC1\n').ok).toBe(true);
    // ...but two rewrites of the *same* line are not mergeable.
    expect(diff3('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n').ok).toBe(false);
  });

  it('handles an empty base, an empty side, and a missing final newline', () => {
    expect(ok(diff3('', '', ''))).toBe('');
    expect(ok(diff3('a\n', '', 'a\n'))).toBe('');
    expect(ok(diff3('a\nb', 'a\nb\nc', 'a\nb'))).toBe('a\nb\nc');
  });

  it('refuses a mix of line endings instead of normalising them', () => {
    // Normalising would change the content, and with it the hash.
    expect(diff3('a\nb\n', 'a\r\nb\r\n', 'a\nB\n')).toEqual({ ok: false, reason: 'eol' });
    expect(diff3('a\r\nb\r\n', 'a\r\nB\r\n', 'a\r\nb\r\nc\r\n').ok).toBe(true);
  });

  it('refuses anything past the size guard', () => {
    const huge = `${'x'.repeat(MAX_TEXT_MERGE)}\n`;
    expect(diff3('a\n', huge, 'a\n')).toEqual({ ok: false, reason: 'size' });
  });

  it('merges a realistic gamelist edit', () => {
    const gamelist = [
      '<gameList>',
      '  <game>',
      '    <path>./sonic.md</path>',
      '    <name>Sonic</name>',
      '    <rating>0.5</rating>',
      '  </game>',
      '  <game>',
      '    <path>./altered.md</path>',
      '    <name>Altered Beast</name>',
      '  </game>',
      '</gameList>',
      '',
    ].join('\n');
    const rated = gamelist.replace('<rating>0.5</rating>', '<rating>0.9</rating>');
    const renamed = gamelist.replace('<name>Altered Beast</name>', '<name>Altered Beast (USA)</name>');

    const merged = ok(diff3(gamelist, rated, renamed));
    expect(merged).toContain('<rating>0.9</rating>');
    expect(merged).toContain('<name>Altered Beast (USA)</name>');
  });
});
