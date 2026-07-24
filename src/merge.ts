import { basename, dirname, splitExtension } from './path.js';
import { canonicalTree } from './store.js';
import type { Tree, TreeEntry } from './types.js';

export type Side = 'a' | 'b';

export interface MergeItem {
  id: string;
  base?: TreeEntry;
  a?: TreeEntry;
  b?: TreeEntry;
}

export type ConflictKind = 'content' | 'location' | 'delete-edit';

export interface ConflictReport {
  id: string;
  kind: ConflictKind;
  path: string;
  winner: Side;
  a: TreeEntry;
  b: TreeEntry;
  /** The losing version, kept as a copy. Absent when it was discarded. */
  copy?: TreeEntry;
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
  entry: TreeEntry;
}

export interface MergeOptions {
  peerA: string;
  peerB: string;
  conflictCopies?: ConflictCopyPolicy;
  conflictName?: (info: ConflictNameInfo) => string;
}

export interface MergeResult {
  tree: Tree;
  conflicts: ConflictReport[];
}

/** `notes.md` -> `notes (conflict device-b 1f4a9c2e).md` */
export function defaultConflictName(info: ConflictNameInfo): string {
  const dir = dirname(info.path);
  const [stem, ext] = splitExtension(basename(info.path));
  const name = `${stem} (conflict ${info.peer} ${info.hash.slice(0, 8)})${ext}`;
  return dir ? `${dir}/${name}` : name;
}

/**
 * Lines up the same file across three trees.
 *
 * Entries are matched by `id` first. Ids only disagree when two peers
 * discovered the same file independently and have never synced, so anything
 * left unmatched and absent from the base falls back to matching by `path`;
 * the lexicographically smaller id then wins and becomes canonical.
 */
export function pairEntries(base: Tree, a: Tree, b: Tree): MergeItem[] {
  const items = new Map<string, MergeItem>();
  const item = (id: string): MergeItem => {
    let found = items.get(id);
    if (!found) {
      found = { id };
      items.set(id, found);
    }
    return found;
  };

  for (const entry of base.entries) item(entry.id).base = entry;
  for (const entry of a.entries) item(entry.id).a = entry;
  for (const entry of b.entries) item(entry.id).b = entry;

  const unmatchedB = new Map<string, MergeItem>();
  for (const candidate of items.values()) {
    if (candidate.b && !candidate.a && !candidate.base) {
      unmatchedB.set((candidate.b as TreeEntry).path, candidate);
    }
  }

  for (const candidate of [...items.values()]) {
    if (!candidate.a || candidate.b || candidate.base) continue;
    const path = (candidate.a as TreeEntry).path;
    const other = unmatchedB.get(path);
    if (!other) continue;
    unmatchedB.delete(path);
    const canonical = candidate.id < other.id ? candidate.id : other.id;
    items.delete(candidate.id);
    items.delete(other.id);
    items.set(canonical, { id: canonical, a: candidate.a, b: other.b });
  }

  return [...items.values()];
}

/**
 * Three-way merge of two peer trees against their common ancestor.
 *
 * Content and location are resolved independently, so "renamed on one side,
 * edited on the other" merges cleanly instead of being reported as a conflict.
 * When both sides really did change the same dimension, the more recent
 * `mtime` wins (section 7 of the design).
 */
export function mergeTrees(base: Tree, a: Tree, b: Tree, options: MergeOptions): MergeResult {
  const policy = options.conflictCopies ?? 'edits';
  const nameConflict = options.conflictName ?? defaultConflictName;
  const conflicts: ConflictReport[] = [];
  const entries: TreeEntry[] = [];
  const copies: TreeEntry[] = [];

  for (const item of pairEntries(base, a, b)) {
    const { base: ancestor, a: left, b: right } = item;

    if (left && !right) {
      entries.push({ ...left, id: item.id });
      continue;
    }
    if (right && !left) {
      entries.push({ ...right, id: item.id });
      continue;
    }
    if (!left || !right) continue;

    const leftDeleted = !!left.deleted;
    const rightDeleted = !!right.deleted;
    const contentChangedA = !ancestor || ancestor.hash !== left.hash || !!ancestor.deleted !== leftDeleted;
    const contentChangedB = !ancestor || ancestor.hash !== right.hash || !!ancestor.deleted !== rightDeleted;
    const sameContent = left.hash === right.hash && leftDeleted === rightDeleted;

    // ---- content dimension
    let content: TreeEntry;
    let conflict: ConflictKind | null = null;
    if (sameContent) {
      content = left.mtime >= right.mtime ? left : right;
    } else if (!contentChangedA) {
      content = right;
    } else if (!contentChangedB) {
      content = left;
    } else {
      content = pickNewer(left, right);
      conflict = leftDeleted || rightDeleted ? 'delete-edit' : 'content';
    }

    // ---- location dimension
    let path: string;
    if (left.path === right.path) {
      path = left.path;
    } else if (ancestor && ancestor.path === left.path) {
      path = right.path;
    } else if (ancestor && ancestor.path === right.path) {
      path = left.path;
    } else {
      const winner = pickNewer(left, right);
      path = winner.path;
      if (!conflict) conflict = 'location';
    }

    const merged: TreeEntry = {
      id: item.id,
      path,
      hash: content.hash,
      size: content.size,
      mtime: content.mtime,
      peer: content.peer ?? (content === left ? options.peerA : options.peerB),
    };
    if (content.deleted) merged.deleted = true;
    if (ancestor && !merged.deleted && ancestor.path !== path) merged.renamedFrom = ancestor.path;
    entries.push(merged);

    if (!conflict) continue;

    const winner: Side = content === left ? 'a' : 'b';
    const loser = winner === 'a' ? right : left;
    // whoever actually wrote the losing version, not whoever relayed it here
    const loserPeer = loser.peer ?? (winner === 'a' ? options.peerB : options.peerA);
    const report: ConflictReport = { id: item.id, kind: conflict, path, winner, a: left, b: right };

    // A location conflict puts no content at risk — the file simply lands on
    // one of the two paths — so copying it would just duplicate the file.
    const contentAtRisk = conflict !== 'location' && !!loser.hash;
    const keepCopy =
      policy === 'always' ? contentAtRisk : policy === 'edits' ? contentAtRisk && !!content.hash : false;

    if (keepCopy) {
      const copyPath = nameConflict({
        path,
        peer: loserPeer,
        hash: loser.hash as string,
        entry: loser,
      });
      // Deterministic id: re-merging the same pair yields the same copy rather
      // than piling up duplicates.
      const copy: TreeEntry = {
        id: `conflict:${item.id}:${loser.hash}`,
        path: copyPath,
        hash: loser.hash,
        size: loser.size,
        mtime: loser.mtime,
        peer: loserPeer,
      };
      copies.push(copy);
      report.copy = copy;
    }
    conflicts.push(report);
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const copy of copies) if (!byId.has(copy.id)) entries.push(copy);

  return { tree: canonicalTree({ entries }), conflicts };
}

/** Newest `mtime` wins; ties break on hash so both peers agree. */
function pickNewer(left: TreeEntry, right: TreeEntry): TreeEntry {
  if (left.mtime !== right.mtime) return left.mtime > right.mtime ? left : right;
  return (left.hash ?? '') >= (right.hash ?? '') ? left : right;
}
