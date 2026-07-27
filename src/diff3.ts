/**
 * Line-based three-way merge for the text half of §4.
 *
 * Deliberately all-or-nothing: it returns merged text or it returns nothing.
 * There is no mode that emits `<<<<<<<` markers, because the files this exists
 * for — `gamelist.xml`, `.nfo`, `.cue`, `.m3u` — are read by an emulator
 * frontend that does not ask questions, and a marker propagated through the
 * mesh is a broken catalogue on every peer. When it cannot merge cleanly the
 * caller falls back to last-writer-wins plus a conflict copy, which is the
 * degradation the whole design leans on.
 */

/** Above this, do not even try: LWW, whatever the extension says. */
export const MAX_TEXT_MERGE = 1024 * 1024;

/**
 * Cap on the LCS table. Past it the merge is refused rather than allowed to
 * allocate an O(n·m) table for a file that was never going to merge cleanly.
 */
const MAX_LCS_CELLS = 4_000_000;

export type Diff3Result = { ok: true; text: string } | { ok: false; reason: 'block' | 'size' | 'eol' };

/** Splits keeping each terminator, so joining is exactly the original text. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** `'crlf'`, `'lf'` or `'none'` — whichever terminator the text actually uses. */
function lineEndings(text: string): 'crlf' | 'lf' | 'mixed' | 'none' {
  const lf = (text.match(/\n/g) ?? []).length;
  if (lf === 0) return 'none';
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return 'lf';
  return crlf === lf ? 'crlf' : 'mixed';
}

/**
 * Merges `a` and `b` over their common ancestor `base`.
 *
 * The guards come before the algorithm on purpose: size, because a 700 MB ROM
 * has no business here; line endings, because normalising them would change the
 * content and with it the hash, so a file that is CRLF on one side and LF on
 * the other is a diff of every line and not a merge at all.
 */
export function diff3(base: string, a: string, b: string): Diff3Result {
  if (base.length > MAX_TEXT_MERGE || a.length > MAX_TEXT_MERGE || b.length > MAX_TEXT_MERGE) {
    return { ok: false, reason: 'size' };
  }
  const endings = new Set([lineEndings(base), lineEndings(a), lineEndings(b)]);
  endings.delete('none');
  if (endings.has('mixed') || endings.size > 1) return { ok: false, reason: 'eol' };

  const baseLines = splitLines(base);
  const aLines = splitLines(a);
  const bLines = splitLines(b);

  const left = hunks(baseLines, aLines);
  const right = hunks(baseLines, bLines);
  if (!left || !right) return { ok: false, reason: 'size' };

  const out: string[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;

  while (i < left.length || j < right.length) {
    // Take whichever change comes first in the base, then grow the window over
    // every change from either side whose base range *overlaps* it.
    //
    // Overlap, not adjacency: two edits that merely touch — one rewrites a
    // line, the other appends after it — are independent and both apply. The
    // one exception is a pair of pure insertions at the very same point, which
    // is a genuine disagreement about what goes there.
    const first = Math.min(left[i]?.start ?? Infinity, right[j]?.start ?? Infinity);
    const group = { start: first, end: first };
    const mine: Hunk[] = [];
    const theirs: Hunk[] = [];
    const overlaps = (hunk: Hunk): boolean =>
      hunk.start < group.end || (hunk.start === group.end && group.end === group.start);
    for (;;) {
      let grew = false;
      while (i < left.length && overlaps(left[i] as Hunk)) {
        const hunk = left[i++] as Hunk;
        group.end = Math.max(group.end, hunk.end);
        mine.push(hunk);
        grew = true;
      }
      while (j < right.length && overlaps(right[j] as Hunk)) {
        const hunk = right[j++] as Hunk;
        group.end = Math.max(group.end, hunk.end);
        theirs.push(hunk);
        grew = true;
      }
      if (!grew) break;
    }

    out.push(...baseLines.slice(pos, group.start));
    if (mine.length === 0) {
      out.push(...apply(baseLines, theirs, group.start, group.end));
    } else if (theirs.length === 0) {
      out.push(...apply(baseLines, mine, group.start, group.end));
    } else {
      const ours = apply(baseLines, mine, group.start, group.end);
      const yours = apply(baseLines, theirs, group.start, group.end);
      // Both touched it. Identical edits are not a conflict — two peers
      // running the same scraper land here routinely.
      if (ours.length !== yours.length || ours.some((line, k) => line !== yours[k])) {
        return { ok: false, reason: 'block' };
      }
      out.push(...ours);
    }
    pos = group.end;
  }
  out.push(...baseLines.slice(pos));
  return { ok: true, text: out.join('') };
}

interface Hunk {
  /** Base range this replaces, half-open. */
  start: number;
  end: number;
  lines: string[];
}

/** Rewrites `base[start, end)` with the hunks that fall inside it. */
function apply(base: string[], list: Hunk[], start: number, end: number): string[] {
  const out: string[] = [];
  let pos = start;
  for (const hunk of list) {
    out.push(...base.slice(pos, hunk.start));
    out.push(...hunk.lines);
    pos = Math.max(pos, hunk.end);
  }
  out.push(...base.slice(pos, end));
  return out;
}

/** Changed regions of `other` against `base`, or `null` when the diff is too big. */
function hunks(base: string[], other: string[]): Hunk[] | null {
  let head = 0;
  while (head < base.length && head < other.length && base[head] === other[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < other.length - head &&
    base[base.length - 1 - tail] === other[other.length - 1 - tail]
  ) {
    tail++;
  }
  const baseMid = base.slice(head, base.length - tail);
  const otherMid = other.slice(head, other.length - tail);
  if (baseMid.length === 0 && otherMid.length === 0) return [];
  if (baseMid.length === 0) {
    return [{ start: head, end: head, lines: otherMid }];
  }
  if (otherMid.length === 0) {
    return [{ start: head, end: head + baseMid.length, lines: [] }];
  }
  if (baseMid.length * otherMid.length > MAX_LCS_CELLS) return null;

  const pairs = lcs(baseMid, otherMid);
  const out: Hunk[] = [];
  let bi = 0;
  let oi = 0;
  for (const [b, o] of pairs) {
    if (b > bi || o > oi) {
      out.push({ start: head + bi, end: head + b, lines: otherMid.slice(oi, o) });
    }
    bi = b + 1;
    oi = o + 1;
  }
  if (bi < baseMid.length || oi < otherMid.length) {
    out.push({ start: head + bi, end: head + baseMid.length, lines: otherMid.slice(oi) });
  }
  return out;
}

/** Longest common subsequence as index pairs, by the textbook DP table. */
function lcs(left: string[], right: string[]): Array<[number, number]> {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
