/**
 * The exclusion pattern language, on its own: parsing and matching, no I/O and
 * no engine.
 *
 * It is deliberately a small subset of gitignore — three forms, no negation.
 * Without `!pattern` no tie between two rules is possible, so the three sources
 * the engine composes (`.vfsignore`, `local.ignore`, the constructor predicate)
 * need no precedence between them: ignored by any one of them, ignored.
 *
 * Kept pure because it is the part a second implementation has to match
 * exactly, and a divergence here does not raise an error anywhere — the two
 * would simply exclude different files.
 */

/** The shared rules file. It is ordinary content, so it travels with the tree. */
export const IGNORE_FILE = '.vfsignore';

export interface IgnoreRule {
  /** Anchored at the root by a leading `/`, rather than floating. */
  anchored: boolean;
  /** One matcher per path segment. */
  segments: RegExp[];
}

/**
 * Reads a `.vfsignore`, or any list of patterns.
 *
 * Blank lines and `#` comments are dropped, whitespace is trimmed, and anything
 * that survives is compiled. Nothing throws: these lines usually arrive from
 * another peer, where a bad one has to be inert rather than fatal.
 */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split('\n')) {
    const rule = compile(line.trim());
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Compiles one pattern.
 *
 * | Pattern | Anchored | Matches |
 * | --- | --- | --- |
 * | `/docs/notes.md` | at the root | that one path, and anything under it |
 * | `docs/notes.md` | no | that run of segments at **any** depth |
 * | `.cache/` | no | any `.cache` anywhere, and its subtree |
 * | `*.tmp` | no | that basename at any depth |
 *
 * **The leading `/` is the only anchor.** This differs from gitignore, where an
 * interior slash anchors implicitly — there, `docs/notes.md` means the one at
 * the top. Here it floats, which is more expressive (gitignore cannot say
 * "this pair of segments anywhere" at all) and is the one place a reader's
 * gitignore instinct will be wrong, silently.
 *
 * **A trailing `/` is accepted and normalised away.** In gitignore it means
 * "directories only"; this engine cannot honour that, and does not pretend to.
 * Exclusion is asked about a *path* — by `walk()` and by the scan's ancestor
 * check — and a path does not say whether it is a directory. Giving those two
 * callers different answers is exactly the divergence that made an earlier bug
 * possible. There is also nothing for it to do: a matched directory covers its
 * subtree already, because the walk prunes there and the ancestor check climbs.
 */
function compile(pattern: string): IgnoreRule | null {
  if (pattern === '' || pattern.startsWith('#')) return null;
  const anchored = pattern.startsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (body === '') return null;
  return { anchored, segments: body.split('/').map(segment) };
}

/** `*` is any run of characters that is not `/`, so it never crosses a folder. */
function segment(part: string): RegExp {
  const source = part.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '[^/]*' : `\\${char}`,
  );
  return new RegExp(`^${source}$`);
}

/**
 * Whether any rule covers this path.
 *
 * A rule matches when its segments line up with a run of the path's segments —
 * at the start when anchored, anywhere otherwise. Matching the *prefix* of a
 * path is enough: `docs` covers `docs/deep/a.txt`, which is what makes a
 * directory rule cover its subtree without the language needing a `**`.
 */
export function matchIgnore(rules: IgnoreRule[], path: string): boolean {
  if (rules.length === 0) return false;
  const parts = path.split('/');
  for (const rule of rules) {
    if (rule.segments.length > parts.length) continue;
    const last = rule.anchored ? 0 : parts.length - rule.segments.length;
    for (let start = 0; start <= last; start++) {
      if (rule.segments.every((matcher, i) => matcher.test(parts[start + i] as string))) return true;
    }
  }
  return false;
}

/**
 * Whether these patterns would exclude the rules file itself.
 *
 * `.vfsignore` is synced content and the mesh needs it to converge: a peer that
 * drops it from the tree makes the others read a deletion. The engine therefore
 * never excludes it, whatever any rule says — but a caller writing local rules
 * is present and can be told, which is what this is for.
 */
export function excludesRulesFile(patterns: string[]): boolean {
  return matchIgnore(parseIgnore(patterns.join('\n')), IGNORE_FILE);
}
