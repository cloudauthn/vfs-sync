import { History } from './history.js';
import { basename, dirname, splitExtension } from './path.js';
import { sortEntries } from './vfs-file.js';
import type { ConflictReason, Hash, VFSEntry } from './types.js';

export type Side = 'a' | 'b';

/** Immediate classification of a conflict, as reported back from `sync()`. */
export type ConflictKind = 'content' | 'location' | 'delete-edit' | 'kind';

export interface ConflictReport {
  uuid: string;
  kind: ConflictKind;
  /** Where the winning version ended up. */
  path: string;
  winner: Side;
  a?: VFSEntry;
  b?: VFSEntry;
  /** The losing version, parked as a copy. Absent when nothing was at risk. */
  copy?: VFSEntry;
  /** Ancestor hash, when the chain turned one up. Feeds the three-way view. */
  base?: Hash;
  /**
   * Both sides are text and small enough that a three-way merge is worth
   * trying. `sync()` is what actually tries it — the merge itself stays pure.
   */
  text?: boolean;
}

/**
 * `'edits'` (default) keeps a copy only when both sides had real content — the
 * case where a silent overwrite would destroy data. `'always'` also keeps the
 * content when a delete wins. `false` never keeps copies.
 */
export type ConflictCopyPolicy = 'always' | 'edits' | false;

export interface ConflictNameInfo {
  path: string;
  peer: string;
  hash: string;
  entry: VFSEntry;
}

export interface MergeSide {
  peer: string;
  entries: VFSEntry[];
  /**
   * Has *this* peer ever heard of this uuid — by entry, by log, or by snapshot?
   *
   * Deliberately one-sided. The shared {@link MergeOptions.history} is the union
   * of both peers' knowledge and would answer "yes" to everything, which is
   * exactly wrong for the path fallback: the question there is whether the
   * *other* side has never seen this identity.
   */
  knows?: (uuid: string) => boolean;
}

export interface MergeOptions {
  /**
   * Ancestry, gathered from whatever the caller was willing to read. An empty
   * history is legal and merely pessimistic: every divergence then reads as a
   * real conflict, which costs copies and never costs correctness.
   */
  history?: History;
  conflictCopies?: ConflictCopyPolicy;
  conflictName?: (info: ConflictNameInfo) => string;
  /** True for paths that get a three-way text merge. Drives {@link ConflictReport.text}. */
  text?: (path: string) => boolean;
  /** Size from which a conflict copy stays on the peer that made it (§4). */
  heldAt?: number;
}

export interface MergeResult {
  entries: VFSEntry[];
  conflicts: ConflictReport[];
}

/** Above this, a conflict copy does not travel — the entry does, the bytes do not. */
export const HELD_AT = 64 * 1024 * 1024;

/** `notes.md` -> `notes (conflict device-b 1f4a9c2e).md` */
export function defaultConflictName(info: ConflictNameInfo): string {
  const dir = dirname(info.path);
  const [stem, ext] = splitExtension(basename(info.path));
  const name = `${stem} (conflict ${info.peer} ${info.hash.slice(0, 8)})${ext}`;
  return dir ? `${dir}/${name}` : name;
}

export interface MergeItem {
  uuid: string;
  a?: VFSEntry;
  b?: VFSEntry;
}

/**
 * Lines up the same file across two peers.
 *
 * By `uuid` first. Uuids only disagree when two peers discovered the same file
 * independently, so what is left unmatched falls back to matching by `path` —
 * but only between live entries of the same kind whose uuid the other side has
 * never heard of, by entry *or* by log. That guard is what the base tree used
 * to provide in v1: without it a delete-and-recreate at the same path merges
 * into the entry it replaced.
 */
export function pairEntries(a: MergeSide, b: MergeSide): MergeItem[] {
  const items = new Map<string, MergeItem>();
  const item = (uuid: string): MergeItem => {
    let found = items.get(uuid);
    if (!found) items.set(uuid, (found = { uuid }));
    return found;
  };
  for (const entry of a.entries) item(entry.uuid).a = entry;
  for (const entry of b.entries) item(entry.uuid).b = entry;

  const knownToA = new Set(a.entries.map((entry) => entry.uuid));
  const knownToB = new Set(b.entries.map((entry) => entry.uuid));
  const strangerToA = (uuid: string) => !knownToA.has(uuid) && !a.knows?.(uuid);
  const strangerToB = (uuid: string) => !knownToB.has(uuid) && !b.knows?.(uuid);

  const loose = new Map<string, MergeItem>();
  for (const candidate of items.values()) {
    const entry = candidate.b;
    if (!entry || candidate.a || entry.deleted || !strangerToA(entry.uuid)) continue;
    loose.set(`${entry.kind}:${entry.path}`, candidate);
  }

  for (const candidate of [...items.values()]) {
    const entry = candidate.a;
    if (!entry || candidate.b || entry.deleted || !strangerToB(entry.uuid)) continue;
    const key = `${entry.kind}:${entry.path}`;
    const other = loose.get(key);
    if (!other) continue;
    loose.delete(key);
    const uuid = candidate.uuid < other.uuid ? candidate.uuid : other.uuid;
    items.delete(candidate.uuid);
    items.delete(other.uuid);
    items.set(uuid, { uuid, a: candidate.a, b: other.b });
  }

  return [...items.values()];
}

/**
 * Merges two peers' entry lists into the one both will adopt.
 *
 * Content and location stay separate dimensions — "renamed on one side, edited
 * on the other" is not a conflict — and the rule inside each is the same as v1:
 * the more recent `updated` wins, with the hash as tiebreak so both peers reach
 * the same answer without another round trip.
 *
 * What replaces the common ancestor is {@link History}: instead of asking "did
 * this side change since the base?", the merge asks "is the loser's version an
 * ancestor of the winner's?" and follows the `prev` chain to find out.
 */
export function mergeEntries(a: MergeSide, b: MergeSide, options: MergeOptions = {}): MergeResult {
  const history = options.history ?? new History();
  const policy = options.conflictCopies ?? 'edits';
  const nameConflict = options.conflictName ?? defaultConflictName;
  const heldAt = options.heldAt ?? HELD_AT;
  const conflicts: ConflictReport[] = [];
  const entries: VFSEntry[] = [];
  const copies: VFSEntry[] = [];

  for (const item of pairEntries(a, b)) {
    const left = item.a;
    const right = item.b;

    // ---- one side only: new file, or a delete whose tombstone was pruned
    if (left && !right) {
      entries.push(solo(item.uuid, left, history));
      continue;
    }
    if (right && !left) {
      entries.push(solo(item.uuid, right, history));
      continue;
    }
    if (!left || !right) continue;

    // ---- content dimension
    const winner = pickNewer(left, right);
    const loser = winner === left ? right : left;
    const sameContent = left.hash === right.hash && !!left.deleted === !!right.deleted;
    let kind: ConflictKind | null = null;
    let content = winner;
    let ancestor: Hash | undefined;

    if (sameContent) {
      content = winner;
    } else if (descends(history, item.uuid, winner, loser)) {
      // The loser is behind: propagation, not a conflict.
      content = winner;
      ancestor = loser.hash ?? undefined;
    } else if (descends(history, item.uuid, loser, winner)) {
      // The *newer* one is the ancestor — a clock ran backwards, or a peer
      // relayed an old version with a fresh timestamp. Ancestry beats the clock.
      content = loser;
      ancestor = winner.hash ?? undefined;
    } else {
      content = winner;
      kind = left.deleted || right.deleted ? 'delete-edit' : 'content';
    }

    // ---- location dimension, resolved independently of the content
    let path: string;
    let prevPath: string | undefined;
    if (left.path === right.path) {
      path = left.path;
      prevPath = content.prevPath;
    } else {
      const leftMoved = history.movedFrom(item.uuid, left.path, right.path, left.prevPath);
      const rightMoved = history.movedFrom(item.uuid, right.path, left.path, right.prevPath);
      const mover = leftMoved === rightMoved ? pickNewer(left, right) : leftMoved ? left : right;
      path = mover.path;
      prevPath = mover.prevPath ?? (mover === left ? right.path : left.path);
      if (leftMoved === rightMoved && !kind) kind = 'location';
    }

    const merged: VFSEntry = {
      uuid: item.uuid,
      kind: content.kind,
      path,
      hash: content.hash,
      size: content.size,
      created: Math.min(left.created, right.created),
      updated: content.updated,
      peer: content.peer,
    };
    if (content.deleted) merged.deleted = true;
    if (content.prev !== undefined) merged.prev = content.prev;
    if (content.prev2) merged.prev2 = content.prev2;
    if (prevPath && prevPath !== path && !merged.deleted) merged.prevPath = prevPath;
    if (content.conflictOf) {
      merged.conflictOf = content.conflictOf;
      if (content.reason) merged.reason = content.reason;
      if (content.base) merged.base = content.base;
      if (content.held) merged.held = content.held;
    }
    entries.push(merged);

    if (!kind) continue;

    const side: Side = content === left ? 'a' : 'b';
    const beaten = side === 'a' ? right : left;
    const report: ConflictReport = {
      uuid: item.uuid,
      kind,
      path,
      winner: side,
      a: left,
      b: right,
      ...(ancestor ? { base: ancestor } : {}),
    };

    // A location conflict puts no content at risk — the file lands on one of
    // the two paths and that is that — so a copy would only duplicate it.
    const atRisk = kind !== 'location' && !!beaten.hash;
    const keep = policy === 'always' ? atRisk : policy === 'edits' ? atRisk && !!content.hash : false;

    if (kind === 'content' && options.text?.(path) && left.hash && right.hash) report.text = true;

    if (keep) {
      const copy = conflictCopy(item.uuid, beaten, path, kind, nameConflict, heldAt);
      copies.push(copy);
      report.copy = copy;
    }
    conflicts.push(report);
  }

  for (const copy of copies) if (!entries.some((entry) => entry.uuid === copy.uuid)) entries.push(copy);

  return {
    entries: sortEntries(resolvePathCollisions(entries, conflicts, nameConflict)),
    conflicts,
  };
}

/**
 * The version one side has and the other does not.
 *
 * The interesting case is the third one: absent on the far side, and no
 * tombstone either. That is exactly what a pruned tombstone looks like, so the
 * log and its cumulative snapshot get asked before the entry is taken as new —
 * without that question a delete comes back to life every time it meets a peer
 * that never heard about it.
 */
function solo(uuid: string, entry: VFSEntry, history: History): VFSEntry {
  const last = history.last(uuid);
  if (last?.deleted && last.at > entry.updated && !entry.deleted) {
    return {
      ...entry,
      hash: null,
      size: 0,
      updated: last.at,
      deleted: true,
      prev: entry.hash,
    };
  }
  return { ...entry, uuid };
}

function descends(history: History, uuid: string, of: VFSEntry, ancestor: VFSEntry): boolean {
  if (!ancestor.hash) return false;
  return history.descends(uuid, of.hash, ancestor.hash, [of.prev, of.prev2]);
}

function conflictCopy(
  uuid: string,
  loser: VFSEntry,
  path: string,
  kind: ConflictKind,
  nameConflict: (info: ConflictNameInfo) => string,
  heldAt: number,
): VFSEntry {
  const reason: ConflictReason = kind === 'delete-edit' ? 'delete-edit' : kind === 'kind' ? 'kind' : 'binary';
  const copy: VFSEntry = {
    // Deterministic: re-merging the same pair yields the same copy rather than
    // piling up near-duplicates on every pass.
    uuid: `conflict:${uuid}:${loser.hash}`,
    kind: loser.kind,
    path: nameConflict({ path, peer: loser.peer, hash: loser.hash as string, entry: loser }),
    hash: loser.hash,
    size: loser.size,
    created: loser.updated,
    updated: loser.updated,
    peer: loser.peer,
    conflictOf: uuid,
    reason,
  };
  if (loser.prev) copy.base = loser.prev;
  // A 700 MB re-dump would otherwise be 700 MB on every peer until someone
  // resolved it. The entry travels; the bytes stay put until asked for.
  if (loser.size >= heldAt) copy.held = loser.peer;
  return copy;
}

/**
 * Two entries on one path.
 *
 * v2 records directories, so a file and a folder can now claim the same name —
 * and unlike a content conflict, parking the loser is not a local edit: a
 * directory moves with everything under it. The winner is picked by the same
 * deterministic rule as everywhere else, and the loser (with its subtree) is
 * renamed aside in one go, so the tree is never inconsistent halfway through.
 */
function resolvePathCollisions(
  entries: VFSEntry[],
  conflicts: ConflictReport[],
  nameConflict: (info: ConflictNameInfo) => string,
): VFSEntry[] {
  const byPath = new Map<string, VFSEntry[]>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    const bucket = byPath.get(entry.path);
    if (bucket) bucket.push(entry);
    else byPath.set(entry.path, [entry]);
  }

  const moves: Array<{ from: string; to: string }> = [];
  for (const [path, bucket] of byPath) {
    if (bucket.length < 2) continue;
    const ranked = [...bucket].sort((x, y) => (pickNewer(x, y) === x ? -1 : 1));
    const keeper = ranked[0] as VFSEntry;
    for (const loser of ranked.slice(1)) {
      const aside = nameConflict({
        path,
        peer: loser.peer,
        hash: loser.hash ?? loser.uuid,
        entry: loser,
      });
      moves.push({ from: loser.path, to: aside });
      loser.prevPath = loser.path;
      loser.path = aside;
      loser.conflictOf ??= keeper.uuid;
      loser.reason ??= keeper.kind === loser.kind ? 'binary' : 'kind';
      // `winner` here is an index into this report's own `a`/`b`, not into the
      // arguments of `sync(a, b)`: a path collision is between two entries, and
      // which peer contributed each is not the question being answered.
      conflicts.push({
        uuid: loser.uuid,
        kind: keeper.kind === loser.kind ? 'content' : 'kind',
        path,
        winner: 'a',
        a: keeper,
        b: loser,
        copy: loser,
      });
    }
  }

  // A directory that lost its path takes its whole subtree along.
  for (const move of moves) {
    for (const entry of entries) {
      if (!entry.path.startsWith(`${move.from}/`)) continue;
      entry.prevPath = entry.path;
      entry.path = `${move.to}${entry.path.slice(move.from.length)}`;
    }
  }
  return entries;
}

/**
 * Newest `updated` wins; ties break on hash, then on peer, so both sides pick
 * the same one from the same two entries without talking.
 */
export function pickNewer(left: VFSEntry, right: VFSEntry): VFSEntry {
  if (left.updated !== right.updated) return left.updated > right.updated ? left : right;
  const leftKey = `${left.hash ?? ''}|${left.peer}|${left.uuid}`;
  const rightKey = `${right.hash ?? ''}|${right.peer}|${right.uuid}`;
  return leftKey >= rightKey ? left : right;
}
