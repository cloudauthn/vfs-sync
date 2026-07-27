import { decodeText, encodeText, randomId, sha256 } from './hash.js';
import { History } from './history.js';
import { MAX_TEXT_MERGE, diff3 } from './diff3.js';
import { makeRow, missingRows } from './log.js';
import { HELD_AT, mergeEntries } from './merge.js';
import type { ConflictCopyPolicy, ConflictNameInfo, ConflictReport } from './merge.js';
import { extensionOf } from './vfs-file.js';
import type { ContentHandle, ContentSource, VFSNode } from './vfs-node.js';
import type { Hash, LogRow, VFSEntry, VFSFile } from './types.js';

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
   * Interactive resolution for a text conflict. Returning content settles it;
   * returning `null` — or leaving the hook out — takes the headless path of
   * last-writer-wins, a copy, and a pending decision.
   */
  resolveText?: (info: TextConflictInfo) => Promise<string | null>;
}

export interface SyncResult {
  /** False when both folders were already identical. */
  changed: boolean;
  conflicts: ConflictReport[];
  /** Content copies performed in each direction. */
  transferred: { toA: number; toB: number };
  /** Text conflicts settled by a three-way merge instead of a copy. */
  merged: number;
  /** The digest both peers end on, or `null` when the pair is empty. */
  state: Hash | null;
}

/**
 * Syncs one edge of the mesh (§5). No ancestor negotiation: both peers read the
 * other's header, compare one digest, and only go further if it differs.
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
  const merge = mergeEntries(sides, other, {
    history,
    heldAt: options.heldAt ?? HELD_AT,
    text: (path) => {
      const extension = extensionOf(path);
      return extension !== '' && text.includes(extension);
    },
    ...(options.conflictCopies !== undefined ? { conflictCopies: options.conflictCopies } : {}),
    ...(options.conflictName ? { conflictName: options.conflictName } : {}),
  });

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

  const target = merge.entries;

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
    conflicts: merge.conflicts,
    transferred,
    merged,
    state: (await a.file()).state,
  };
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
): Promise<number> {
  let count = 0;
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
  }
  return count;
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
