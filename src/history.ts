import type { Hash, LogRow, VFSEntry } from './types.js';

/**
 * The ancestry index that replaces the commit DAG.
 *
 * v1 answered "did this side change?" by walking back to a common ancestor
 * commit. v2 asks a narrower question — *is the loser's version an ancestor of
 * the winner's?* — and answers it per file, by following the `prev` links that
 * every version carries inline. This class is just those links, gathered from
 * whatever sources the caller was willing to read: the entries themselves, the
 * active log segment, its cumulative snapshot, and — only when someone pays for
 * it — a closed archive.
 *
 * Everything degrades the same way: a link that is not here makes the answer
 * "unknown", and an unknown ancestry is treated as a real conflict. That costs
 * a conflict copy nobody needed; it never decides the state wrongly.
 */
export class History {
  /** uuid -> version hash -> the hashes it descends from. */
  private readonly content = new Map<string, Map<Hash, Set<Hash>>>();
  /** uuid -> path -> the path it was moved from. */
  private readonly location = new Map<string, Map<string, string>>();
  /** uuid -> the latest thing anyone recorded about it. */
  private readonly latest = new Map<string, { at: number; deleted: boolean; path: string }>();

  static from(sources: Array<Iterable<LogRow> | Iterable<VFSEntry>>): History {
    const history = new History();
    for (const source of sources) history.add(source as Iterable<LogRow | VFSEntry>);
    return history;
  }

  /**
   * Feeds in log rows or entries — the two carry the same links under the same
   * names, which is deliberate: a snapshot entry is one more step of the chain
   * and reading it should not need a second code path.
   */
  add(source: Iterable<LogRow | VFSEntry>): this {
    for (const item of source) {
      const row = item as Partial<LogRow> & Partial<VFSEntry>;
      const uuid = row.uuid;
      if (!uuid) continue;
      const at = row.at ?? row.updated ?? 0;
      const deleted = row.type === 'delete' || row.deleted === true;

      if (row.hash) this.link(uuid, row.hash, row.prev ?? null, row.prev2 ?? null);
      if (row.prevPath && row.path && row.prevPath !== row.path) {
        let paths = this.location.get(uuid);
        if (!paths) this.location.set(uuid, (paths = new Map()));
        paths.set(row.path, row.prevPath);
      }

      const held = this.latest.get(uuid);
      if (!held || at >= held.at) this.latest.set(uuid, { at, deleted, path: row.path ?? held?.path ?? '' });
    }
    return this;
  }

  private link(uuid: string, hash: Hash, prev: Hash | null, prev2: Hash | null): void {
    let versions = this.content.get(uuid);
    if (!versions) this.content.set(uuid, (versions = new Map()));
    let parents = versions.get(hash);
    if (!parents) versions.set(hash, (parents = new Set()));
    if (prev) parents.add(prev);
    if (prev2) parents.add(prev2);
  }

  /** True when anything at all is known about this uuid. */
  knows(uuid: string): boolean {
    return this.latest.has(uuid) || this.content.has(uuid) || this.location.has(uuid);
  }

  /** The most recent thing recorded about a uuid, wherever it came from. */
  last(uuid: string): { at: number; deleted: boolean; path: string } | undefined {
    return this.latest.get(uuid);
  }

  /**
   * Does `hash` descend from `ancestor`, following the chain backwards?
   *
   * `seed` is the version's own inline `prev`/`prev2`, which covers the
   * overwhelmingly common case — each side edited at most once since the last
   * sync — without reading anything at all. Beyond that the walk continues
   * through whatever links were loaded.
   */
  descends(uuid: string, hash: Hash | null, ancestor: Hash | null, seed: Array<Hash | null | undefined> = []): boolean {
    if (!ancestor) return false;
    if (hash === ancestor) return true;
    const versions = this.content.get(uuid);
    const queue: Hash[] = [];
    for (const parent of seed) if (parent) queue.push(parent);
    for (const parent of versions?.get(hash ?? '') ?? []) queue.push(parent);

    const seen = new Set<Hash>(queue);
    while (queue.length > 0) {
      const current = queue.pop() as Hash;
      if (current === ancestor) return true;
      for (const parent of versions?.get(current) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
    }
    return false;
  }

  /**
   * Nearest version both sides descend from — the base a three-way text merge
   * needs. `null` when the chains never meet, which is the ordinary answer for
   * two peers that have not exchanged enough history; the caller then falls
   * back to last-writer-wins plus a copy.
   */
  commonAncestor(
    uuid: string,
    left: { hash?: Hash | null; prev?: Hash | null; prev2?: Hash },
    right: { hash?: Hash | null; prev?: Hash | null; prev2?: Hash },
  ): Hash | null {
    const reach = (from: { hash?: Hash | null; prev?: Hash | null; prev2?: Hash }): Hash[] => {
      const versions = this.content.get(uuid);
      const out: Hash[] = [];
      const seen = new Set<Hash>();
      const queue: Hash[] = [];
      for (const seed of [from.prev, from.prev2]) if (seed) queue.push(seed);
      for (const parent of versions?.get(from.hash ?? '') ?? []) queue.push(parent);
      while (queue.length > 0) {
        const current = queue.shift() as Hash;
        if (seen.has(current)) continue;
        seen.add(current);
        out.push(current);
        for (const parent of versions?.get(current) ?? []) queue.push(parent);
      }
      return out;
    };
    const mine = reach(left);
    const theirs = new Set(reach(right));
    // Breadth-first from each side, so the first hit is the nearest one.
    return mine.find((hash) => theirs.has(hash)) ?? null;
  }

  /**
   * Was `path` once the home of this uuid, on the way to `from`?
   *
   * `a -> b -> c` against a peer still sitting at `a` is a propagation however
   * far the chain runs, so the whole chain has to be walkable — one inline
   * `prevPath` is only the first link.
   */
  movedFrom(uuid: string, from: string, path: string, seed?: string): boolean {
    if (from === path) return true;
    const paths = this.location.get(uuid);
    let current: string | undefined = seed ?? paths?.get(from);
    const seen = new Set<string>([from]);
    while (current !== undefined && !seen.has(current)) {
      if (current === path) return true;
      seen.add(current);
      current = paths?.get(current);
    }
    return false;
  }
}
