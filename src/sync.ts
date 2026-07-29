import { decodeText, encodeText, randomId, sha256 } from './hash.js';
import { History } from './history.js';
import { MAX_TEXT_MERGE, diff3 } from './diff3.js';
import { makeRow, missingRows } from './log.js';
import { HELD_AT, mergeEntries } from './merge.js';
import type {
  ConflictCopyPolicy,
  ConflictNameInfo,
  ConflictReport,
  MergeOptions,
} from './merge.js';
import { extensionOf } from './vfs-file.js';
import type { ContentHandle, ContentSource, VFSNode } from './vfs-node.js';
import { stateDigest } from './vfs-file.js';
import type { EntryKind, Hash, LogRow, VFSEntry, VFSFile } from './types.js';

export interface TextConflictInfo {
  path: string;
  /** Common ancestor, when one was found. */
  base: string | null;
  a: string;
  b: string;
  peerA: string;
  peerB: string;
}

export interface SyncOptions {
  conflictCopies?: ConflictCopyPolicy;
  conflictName?: (info: ConflictNameInfo) => string;
  now?: () => number;
  /** Size from which a conflict copy stays on the peer that made it (§4). */
  heldAt?: number;
  /** Turn off the automatic three-way merge of text files. */
  autoMerge?: boolean;
  /**
   * Whether to open a closed log segment when a conflict's loser is older than
   * the active one. Defaults to `true`. Turning it off trades a cold read for
   * the occasional conflict copy that need not have been kept — never for a
   * different outcome.
   */
  archives?: boolean;
  /**
   * Interactive resolution for a text conflict. Returning content settles it;
   * returning `null` — or leaving the hook out — takes the headless path of
   * last-writer-wins, a copy, and a pending decision.
   */
  resolveText?: (info: TextConflictInfo) => Promise<string | null>;
  /**
   * Called after planning and before any cross-peer writes. Return `false` to
   * abort this sync pass.
   */
  approveMerge?: (preview: SyncDryRunResult) => Promise<boolean> | boolean;
}

export interface SyncResult {
  /** False when both folders were already identical. */
  changed: boolean;
  /** False when an approval hook vetoed the merge before writes. */
  approved?: boolean;
  conflicts: ConflictReport[];
  /** Content copies performed in each direction. */
  transferred: { toA: number; toB: number };
  /** Text conflicts settled by a three-way merge instead of a copy. */
  merged: number;
  /** The digest both peers end on, or `null` when the pair is empty. */
  state: Hash | null;
}

export type SyncDryRunActionType = 'write' | 'delete' | 'rename' | 'mkdir';

export interface SyncDryRunAction {
  type: SyncDryRunActionType;
  uuid: string;
  kind: EntryKind;
  path: string;
  /** Present on `write` actions that create a new file on that side. */
  created?: boolean;
  from?: string;
  to?: string;
}

export interface SyncDryRunResult {
  /** False when the final `sync()` call would be a no-op. */
  changed: boolean;
  /** Whether `sync()` would first converge `storeId`/`text` config. */
  configChanged: boolean;
  conflicts: ConflictReport[];
  /** Predicted content copies performed in each direction. */
  transferred: { toA: number; toB: number };
  /** Text conflicts that would settle via three-way merge. */
  merged: number;
  /** Paths that would be settled by text auto-merge. */
  mergedPaths: string[];
  /** Predicted file-system actions `sync()` would perform. */
  actions: { toA: SyncDryRunAction[]; toB: SyncDryRunAction[] };
  /** The digest both peers would end on after `sync()`. */
  state: Hash | null;
}

/**
 * Syncs one edge of the mesh (§5). No ancestor negotiation: both sides are
 * reconciled, one `state` digest is compared, and nothing else happens unless it
 * differs.
 *
 * Nothing is assumed about who else either peer talks to, which is what lets
 * changes travel down a chain (A <-> B <-> C) one edge at a time — and the log
 * is deliberately not per-peer, so A also carries B's operations when it meets
 * C, and both sides decide conflicts from the same information.
 */
export async function sync(a: VFSNode, b: VFSNode, options: SyncOptions = {}): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());
  const nothing: SyncResult['transferred'] = { toA: 0, toB: 0 };

  // The mirror is only as good as its last reconciliation, and a scan is
  // obligatory here anyway: it is what turns disk state into entries.
  await a.commit();
  await b.commit();
  if (a === b) {
    return { changed: false, conflicts: [], transferred: nothing, merged: 0, state: await a.state() };
  }

  const fileA = await a.file();
  const fileB = await b.file();

  // ---- 2. config converges: storeId on the smaller, `text` by union
  const storeId = [fileA.storeId, fileB.storeId].sort()[0] as string;
  const text = [...new Set([...fileA.text, ...fileB.text])].sort();
  const configChanged =
    fileA.storeId !== storeId ||
    fileB.storeId !== storeId ||
    fileA.text.join() !== text.join() ||
    fileB.text.join() !== text.join();
  fileA.storeId = fileB.storeId = storeId;
  fileA.text = [...text];
  fileB.text = [...text];

  // ---- 3. one comparison decides whether there is anything to do at all
  const at = now();
  if (fileA.state === fileB.state && fileA.log.digest === fileB.log.digest) {
    await close(a, b, fileA, fileB, [], [], at);
    return {
      changed: configChanged,
      conflicts: [],
      transferred: nothing,
      merged: 0,
      state: fileA.state,
    };
  }

  // ---- 4/5. entries, and the log only where the entries cannot answer alone
  const sources: Array<Iterable<LogRow> | Iterable<VFSEntry>> = [fileA.entries, fileB.entries];
  let rowsA: LogRow[] = [];
  let rowsB: LogRow[] = [];
  // Each side's *own* knowledge, which is what the path fallback turns on: the
  // shared history below is the union of both and would vouch for everything.
  const ownA = History.from([fileA.entries]);
  const ownB = History.from([fileB.entries]);

  if (needsLog(fileA.entries, fileB.entries)) {
    rowsA = await a.store.logRows();
    rowsB = await readPeerLog(b, fileA.peers[b.id]);
    const snapA = await a.store.readSnapshot(fileA);
    const snapB = await b.store.readSnapshot(fileB);
    ownA.add(rowsA).add(snapA);
    ownB.add(rowsB).add(snapB);
    sources.push(rowsA, rowsB, snapA, snapB);
  }
  const history = History.from(sources);

  const sides = { peer: a.id, entries: fileA.entries, knows: (uuid: string) => ownA.knows(uuid) };
  const other = { peer: b.id, entries: fileB.entries, knows: (uuid: string) => ownB.knows(uuid) };

  // ---- merge
  const mergeOptions: MergeOptions = {
    history,
    heldAt: options.heldAt ?? HELD_AT,
    text: (path) => {
      const extension = extensionOf(path);
      return extension !== '' && text.includes(extension);
    },
    ...(options.conflictCopies !== undefined ? { conflictCopies: options.conflictCopies } : {}),
    ...(options.conflictName ? { conflictName: options.conflictName } : {}),
  };
  let merge = mergeEntries(sides, other, mergeOptions);

  // A conflict whose loser predates the active segment may not be one at all:
  // the link that would prove ancestry is in a closed archive. Reading it is the
  // one cold read in the protocol, and it is optional by design — it can only
  // ever *avoid* a conflict copy, never change what the state ends up being.
  if (options.archives !== false) {
    const oldest = coldest(merge.conflicts);
    if (oldest !== null) {
      const rows = [
        ...(await readArchives(a, fileA, oldest)),
        ...(await readArchives(b, fileB, oldest)),
      ];
      if (rows.length > 0) {
        history.add(rows);
        merge = mergeEntries(sides, other, mergeOptions);
      }
    }
  }

  // ---- text: try to settle a content conflict rather than park a copy
  const overlay = new Map<Hash, Uint8Array>();
  const extra: Array<Omit<LogRow, 'op'>> = [];
  const batch = randomId();
  const merged = await autoMergeText(a, b, merge, history, {
    overlay,
    rows: extra,
    batch,
    at,
    enabled: options.autoMerge !== false,
    ...(options.resolveText ? { resolveText: options.resolveText } : {}),
  });
  const mergedCount = merged.count;
  const mergedPaths = merged.paths;

  const target = merge.entries;

  const planA = planChanges(fileA.entries, target, a.id);
  const planB = planChanges(fileB.entries, target, b.id);
  const overlayHashes = new Set(overlay.keys());
  const remoteFromB = new Set(fileHashes(fileB.entries));
  const remoteForB = new Set([...fileHashes(target), ...fileHashes(fileA.entries)]);
  const previewTransferred = {
    toA: countTransfers(planA.writes, planA.localHashes, overlayHashes, remoteFromB),
    toB: countTransfers(planB.writes, planB.localHashes, overlayHashes, remoteForB),
  };
  const previewState = await stateDigest(target);

  const approve = options.approveMerge;
  if (approve) {
    const approved = await approve({
      changed:
        configChanged ||
        merge.conflicts.length > 0 ||
        mergedCount > 0 ||
        planA.actions.length > 0 ||
        planB.actions.length > 0,
      configChanged,
      conflicts: merge.conflicts,
      transferred: previewTransferred,
      merged: mergedCount,
      mergedPaths,
      actions: { toA: planA.actions, toB: planB.actions },
      state: previewState,
    });
    if (!approved) {
      return {
        changed: false,
        approved: false,
        conflicts: merge.conflicts,
        transferred: { toA: 0, toB: 0 },
        merged: mergedCount,
        state: null,
      };
    }
  }

  // ---- 6. content moves, verified on arrival
  const transferred = { toA: 0, toB: 0 };
  const beforeB = fileB.entries;
  await a.apply(target, chain(overlay, [{ node: b, entries: beforeB }], () => transferred.toA++));
  await b.apply(
    target,
    chain(
      overlay,
      [
        { node: a, entries: target },
        { node: a, entries: fileA.entries },
      ],
      () => transferred.toB++,
    ),
  );

  // ---- 7. close: content is on disk, then the logs, then the two headers
  const rowsForA = [...(await Promise.all(extra.map(makeRow)))];
  const rowsForB = [...rowsForA];
  if (rowsA.length > 0 || rowsB.length > 0) {
    rowsForA.push(...missingRows(rowsA, rowsB));
    rowsForB.push(...missingRows(rowsB, rowsA));
  }

  await a.adopt(target, fileA);
  await b.adopt(target, fileB);
  await close(a, b, fileA, fileB, rowsForA, rowsForB, at);

  return {
    changed: true,
    approved: true,
    conflicts: merge.conflicts,
    transferred,
    merged: mergedCount,
    state: previewState,
  };
}

/**
 * Computes what `sync(a, b)` would do, without writing either folder.
 *
 * It still scans both sides (like `sync` does through `commit`) so the preview
 * includes pending local edits, but it appends no log rows and performs no
 * content writes.
 */
export async function syncDryRun(
  a: VFSNode,
  b: VFSNode,
  options: SyncOptions = {},
): Promise<SyncDryRunResult> {
  if (a === b) {
    return {
      changed: false,
      configChanged: false,
      conflicts: [],
      transferred: { toA: 0, toB: 0 },
      merged: 0,
      mergedPaths: [],
      actions: { toA: [], toB: [] },
      state: await a.state(),
    };
  }

  const now = options.now ?? (() => Date.now());
  const at = now();
  const [scanA, scanB] = await Promise.all([a.scan(), b.scan()]);
  const fileA = await a.file();
  const fileB = await b.file();

  const entriesA = scanA.entries;
  const entriesB = scanB.entries;

  const storeId = [fileA.storeId, fileB.storeId].sort()[0] as string;
  const text = [...new Set([...fileA.text, ...fileB.text])].sort();
  const configChanged =
    fileA.storeId !== storeId ||
    fileB.storeId !== storeId ||
    fileA.text.join() !== text.join() ||
    fileB.text.join() !== text.join();

  const sources: Array<Iterable<LogRow> | Iterable<VFSEntry>> = [entriesA, entriesB, scanA.rows, scanB.rows];
  let rowsA: LogRow[] = [];
  let rowsB: LogRow[] = [];
  const ownA = History.from([entriesA, scanA.rows]);
  const ownB = History.from([entriesB, scanB.rows]);

  if (needsLog(entriesA, entriesB)) {
    rowsA = await a.store.logRows();
    rowsB = await readPeerLog(b, fileA.peers[b.id]);
    const snapA = await a.store.readSnapshot(fileA);
    const snapB = await b.store.readSnapshot(fileB);
    ownA.add(rowsA).add(snapA);
    ownB.add(rowsB).add(snapB);
    sources.push(rowsA, rowsB, snapA, snapB);
  }
  const history = History.from(sources);

  const sides = { peer: a.id, entries: entriesA, knows: (uuid: string) => ownA.knows(uuid) };
  const other = { peer: b.id, entries: entriesB, knows: (uuid: string) => ownB.knows(uuid) };

  const mergeOptions: MergeOptions = {
    history,
    heldAt: options.heldAt ?? HELD_AT,
    text: (path) => {
      const extension = extensionOf(path);
      return extension !== '' && text.includes(extension);
    },
    ...(options.conflictCopies !== undefined ? { conflictCopies: options.conflictCopies } : {}),
    ...(options.conflictName ? { conflictName: options.conflictName } : {}),
  };
  let merge = mergeEntries(sides, other, mergeOptions);

  if (options.archives !== false) {
    const oldest = coldest(merge.conflicts);
    if (oldest !== null) {
      const rows = [
        ...(await readArchives(a, fileA, oldest)),
        ...(await readArchives(b, fileB, oldest)),
      ];
      if (rows.length > 0) {
        history.add(rows);
        merge = mergeEntries(sides, other, mergeOptions);
      }
    }
  }

  const overlay = new Map<Hash, Uint8Array>();
  const merged = await autoMergeText(a, b, merge, history, {
    overlay,
    rows: [],
    batch: randomId(),
    at,
    enabled: options.autoMerge !== false,
    ...(options.resolveText ? { resolveText: options.resolveText } : {}),
  });
  const mergedCount = merged.count;
  const mergedPaths = merged.paths;

  const target = merge.entries;
  const planA = planChanges(entriesA, target, a.id);
  const planB = planChanges(entriesB, target, b.id);

  const overlayHashes = new Set(overlay.keys());
  const remoteFromB = new Set(fileHashes(entriesB));
  const remoteForB = new Set([...fileHashes(target), ...fileHashes(entriesA)]);

  const transferred = {
    toA: countTransfers(planA.writes, planA.localHashes, overlayHashes, remoteFromB),
    toB: countTransfers(planB.writes, planB.localHashes, overlayHashes, remoteForB),
  };

  const changed =
    configChanged ||
    merge.conflicts.length > 0 ||
    mergedCount > 0 ||
    planA.actions.length > 0 ||
    planB.actions.length > 0;

  return {
    changed,
    configChanged,
    conflicts: merge.conflicts,
    transferred,
    merged: mergedCount,
    mergedPaths,
    actions: { toA: planA.actions, toB: planB.actions },
    state: await stateDigest(target),
  };
}

interface PlannedChanges {
  actions: SyncDryRunAction[];
  writes: VFSEntry[];
  localHashes: Set<Hash>;
}

function planChanges(currentEntries: VFSEntry[], target: VFSEntry[], nodeId: string): PlannedChanges {
  const current = new Map(currentEntries.map((entry) => [entry.uuid, entry]));
  const currentLive = currentEntries.filter((entry) => !entry.deleted);
  const targetByUuid = new Set(target.map((entry) => entry.uuid));

  const actions: SyncDryRunAction[] = [];
  const writes: VFSEntry[] = [];

  for (const entry of target) {
    const before = current.get(entry.uuid);
    const wasLive = !!before && !before.deleted;
    if (entry.deleted) {
      if (wasLive && before) {
        actions.push({
          type: 'delete',
          uuid: before.uuid,
          kind: before.kind,
          path: before.path,
        });
      }
      continue;
    }
    if (entry.held && entry.held !== nodeId) continue;

    if (wasLive && before && before.path !== entry.path) {
      actions.push({
        type: 'rename',
        uuid: entry.uuid,
        kind: entry.kind,
        path: entry.path,
        from: before.path,
        to: entry.path,
      });
    }

    if (entry.kind === 'directory') {
      if (!wasLive) {
        actions.push({
          type: 'mkdir',
          uuid: entry.uuid,
          kind: 'directory',
          path: entry.path,
        });
      }
      continue;
    }

    if (!wasLive || before?.hash !== entry.hash) {
      writes.push(entry);
      actions.push({
        type: 'write',
        uuid: entry.uuid,
        kind: 'file',
        path: entry.path,
        ...(wasLive ? {} : { created: true }),
      });
    }
  }

  for (const entry of currentLive) {
    if (targetByUuid.has(entry.uuid)) continue;
    actions.push({
      type: 'delete',
      uuid: entry.uuid,
      kind: entry.kind,
      path: entry.path,
    });
  }

  const localHashes = new Set<Hash>();
  for (const entry of currentLive) {
    if (entry.kind !== 'file' || !entry.hash || entry.held) continue;
    localHashes.add(entry.hash);
  }

  return {
    actions: sortActions(actions),
    writes,
    localHashes,
  };
}

function fileHashes(entries: VFSEntry[]): Hash[] {
  const hashes: Hash[] = [];
  for (const entry of entries) {
    if (entry.deleted || entry.kind !== 'file' || !entry.hash || entry.held) continue;
    hashes.push(entry.hash);
  }
  return hashes;
}

function countTransfers(
  writes: VFSEntry[],
  localHashes: Set<Hash>,
  overlayHashes: Set<Hash>,
  remoteHashes: Set<Hash>,
): number {
  let count = 0;
  for (const entry of writes) {
    if (!entry.hash) continue;
    if (localHashes.has(entry.hash)) continue;
    if (overlayHashes.has(entry.hash)) continue;
    if (remoteHashes.has(entry.hash)) count++;
  }
  return count;
}

function sortActions(actions: SyncDryRunAction[]): SyncDryRunAction[] {
  return [...actions].sort(
    (x, y) =>
      (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) ||
      (x.type < y.type ? -1 : x.type > y.type ? 1 : 0) ||
      (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0),
  );
}

/**
 * Appends what each log is missing and writes both headers, in that order.
 *
 * The order is the recovery plan: if the process dies halfway, `vfs.json` comes
 * up short — declaring less than what is on disk — and the next reconciliation
 * catches up. The opposite, a `vfs.json` claiming content that never arrived,
 * must not be reachable.
 */
async function close(
  a: VFSNode,
  b: VFSNode,
  fileA: VFSFile,
  fileB: VFSFile,
  rowsForA: LogRow[],
  rowsForB: LogRow[],
  at: number,
): Promise<void> {
  if (rowsForA.length > 0) await a.store.append(rowsForA, fileA);
  if (rowsForB.length > 0) await b.store.append(rowsForB, fileB);

  fileA.peers[b.id] = {
    lastSync: at,
    segment: fileB.log.segment,
    offset: fileB.log.size,
    digest: fileB.log.digest,
  };
  fileB.peers[a.id] = {
    lastSync: at,
    segment: fileA.log.segment,
    offset: fileA.log.size,
    digest: fileA.log.digest,
  };
  await a.store.write(fileA);
  await b.store.write(fileB);
}

/**
 * Whether the log has to be opened at all.
 *
 * Two questions need it, and only two: an entry that exists on one side and not
 * the other may be a delete whose tombstone was pruned, and a hash divergence
 * has to be told apart from a propagation. Everything else `vfs.json` answers
 * on its own.
 */
function needsLog(left: VFSEntry[], right: VFSEntry[]): boolean {
  const byUuid = new Map(right.map((entry) => [entry.uuid, entry]));
  for (const entry of left) {
    const held = byUuid.get(entry.uuid);
    if (!held || held.hash !== entry.hash) return true;
  }
  const mine = new Set(left.map((entry) => entry.uuid));
  return right.some((entry) => !mine.has(entry.uuid));
}

/**
 * The `updated` of the oldest losing version among the conflicts a copy would be
 * kept for, or `null` when there is nothing an archive could help with.
 *
 * Location conflicts are excluded: they never keep a copy, so nothing is saved
 * by proving ancestry for them.
 */
function coldest(conflicts: ConflictReport[]): number | null {
  let oldest: number | null = null;
  for (const report of conflicts) {
    if (report.kind === 'location' || report.kind === 'kind') continue;
    const loser = report.winner === 'a' ? report.b : report.a;
    if (!loser) continue;
    if (oldest === null || loser.updated < oldest) oldest = loser.updated;
  }
  return oldest;
}

/**
 * Rows from the closed segments that could hold links at or after `since`.
 *
 * Segments are named for the moment they closed, so any archive stamped before
 * `since` is entirely older than the version in question and cannot contain the
 * link being looked for. They are immutable, so the store caches them for good —
 * and a segment that has been deleted (§3 says they are deletable) simply
 * contributes nothing, which degrades to the conflict copy that would have been
 * kept anyway.
 */
async function readArchives(node: VFSNode, file: VFSFile, since: number): Promise<LogRow[]> {
  const out: LogRow[] = [];
  for (const segment of file.log.archives ?? []) {
    if (segment < since) continue;
    out.push(...(await node.store.readArchive(segment)));
  }
  return out;
}

/** The tail of a peer's active segment, or the whole of it when the peer rotated. */
async function readPeerLog(peer: VFSNode, mark?: { segment: number; offset: number; digest: Hash }) {
  const file = await peer.file();
  if (mark && mark.digest === file.log.digest) return peer.store.logRows();
  if (!mark || mark.segment !== file.log.segment) return peer.store.logRows();
  return peer.store.rowsSince(mark.offset);
}

interface AutoMergeContext {
  overlay: Map<Hash, Uint8Array>;
  rows: Array<Omit<LogRow, 'op'>>;
  batch: string;
  at: number;
  enabled: boolean;
  resolveText?: (info: TextConflictInfo) => Promise<string | null>;
}

/**
 * Tries a three-way merge on the content conflicts the merge flagged as text.
 *
 * Computed on one side only — `sync()` has both nodes in front of it, so there
 * is no need for two implementations to agree byte for byte forever. The result
 * travels as an ordinary write whose row carries `prev` *and* `prev2`: two
 * parents, which is what stops a third peer from reclassifying the merge as a
 * fresh conflict on every pass.
 */
async function autoMergeText(
  a: VFSNode,
  b: VFSNode,
  merge: { entries: VFSEntry[]; conflicts: ConflictReport[] },
  history: History,
  context: AutoMergeContext,
): Promise<{ count: number; paths: string[] }> {
  let count = 0;
  const paths: string[] = [];
  for (const report of merge.conflicts) {
    if (!report.text || !report.a || !report.b) continue;
    if (!context.enabled && !context.resolveText) continue;
    const left = report.a;
    const right = report.b;
    if (left.size > MAX_TEXT_MERGE || right.size > MAX_TEXT_MERGE) continue;

    const ancestor = report.base ?? history.commonAncestor(report.uuid, left, right);
    const baseBytes = ancestor
      ? ((await a.baseOf(ancestor)) ?? (await b.baseOf(ancestor)))
      : null;
    const mine = await readAt(a, left.path);
    const theirs = await readAt(b, right.path);
    if (!mine || !theirs) continue;

    const baseText = baseBytes ? decodeText(baseBytes) : null;
    let text: string | null = null;
    if (context.enabled && baseText !== null) {
      const attempt = diff3(baseText, decodeText(mine), decodeText(theirs));
      if (attempt.ok) text = attempt.text;
    }
    if (text === null && context.resolveText) {
      text = await context.resolveText({
        path: report.path,
        base: baseText,
        a: decodeText(mine),
        b: decodeText(theirs),
        peerA: a.id,
        peerB: b.id,
      });
    }
    if (text === null) continue;

    const data = encodeText(text);
    const hash = await sha256(data);
    context.overlay.set(hash, data);

    const winner = report.winner === 'a' ? left : right;
    const loser = report.winner === 'a' ? right : left;
    const entry = merge.entries.find((item) => item.uuid === report.uuid);
    if (!entry) continue;
    entry.hash = hash;
    entry.size = data.byteLength;
    entry.updated = Math.max(context.at, left.updated, right.updated) + 1;
    entry.peer = a.id;
    entry.prev = winner.hash;
    if (loser.hash) entry.prev2 = loser.hash;

    // The copy was only ever the pending decision; the merge settled it.
    if (report.copy) {
      const at = merge.entries.indexOf(report.copy);
      if (at >= 0) merge.entries.splice(at, 1);
      delete report.copy;
    }
    report.text = true;
    context.rows.push({
      batch: context.batch,
      at: entry.updated,
      peer: a.id,
      uuid: entry.uuid,
      type: 'write',
      kind: 'file',
      path: entry.path,
      hash,
      size: data.byteLength,
      prev: winner.hash ?? null,
      ...(loser.hash ? { prev2: loser.hash } : {}),
    });
    count++;
    paths.push(report.path);
  }
  return { count, paths };
}

async function readAt(node: VFSNode, path: string): Promise<Uint8Array | null> {
  try {
    return await node.read(path);
  } catch {
    return null;
  }
}

interface Candidate {
  node: VFSNode;
  entries: VFSEntry[];
}

/** Overlay first, then each candidate holder in turn. `onHit` tallies transfers. */
function chain(
  overlay: Map<Hash, Uint8Array>,
  candidates: Candidate[],
  onHit: () => void,
): ContentSource {
  return {
    async open(hash: Hash): Promise<ContentHandle | null> {
      const held = overlay.get(hash);
      if (held) {
        return {
          size: held.byteLength,
          read: async () => held,
          stream: async () => new Response(held as BodyInit).body as ReadableStream<Uint8Array>,
        };
      }
      for (const candidate of candidates) {
        const entry = candidate.entries.find(
          (item) => !item.deleted && item.kind === 'file' && item.hash === hash && !item.held,
        );
        if (!entry) continue;
        const stat = await candidate.node.stat(entry.path);
        if (!stat || stat.kind !== 'file') continue;
        onHit();
        const path = entry.path;
        return {
          size: stat.size,
          read: () => candidate.node.read(path),
          stream: () => candidate.node.readStream(path),
        };
      }
      return null;
    },
  };
}

export interface MeshEdge {
  a: VFSNode;
  b: VFSNode;
}

export interface MeshResult {
  edge: MeshEdge;
  result: SyncResult;
}

/**
 * Runs every edge once, in order. Repeat until nothing changes to let updates
 * propagate down a chain — each pass moves a change one hop further.
 */
export async function syncMesh(edges: MeshEdge[], options: SyncOptions = {}): Promise<MeshResult[]> {
  const results: MeshResult[] = [];
  for (const edge of edges) results.push({ edge, result: await sync(edge.a, edge.b, options) });
  return results;
}

/** Repeats `syncMesh` until the mesh reaches a fixed point (or `maxRounds`). */
export async function syncUntilStable(
  edges: MeshEdge[],
  options: SyncOptions & { maxRounds?: number } = {},
): Promise<MeshResult[][]> {
  const maxRounds = options.maxRounds ?? 10;
  const rounds: MeshResult[][] = [];
  for (let round = 0; round < maxRounds; round++) {
    const results = await syncMesh(edges, options);
    rounds.push(results);
    if (!results.some((item) => item.result.changed)) break;
  }
  return rounds;
}
