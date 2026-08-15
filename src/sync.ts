import { decodeText, encodeText, randomId, sha256 } from './hash.js';
import { History } from './history.js';
import { MAX_TEXT_MERGE, diff3 } from './diff3.js';
import { makeRow, missingRows } from './log.js';
import { HELD_AT, copyForAnswer, mergeEntries } from './merge.js';
import type {
  ConflictCopyPolicy,
  ConflictNameInfo,
  ConflictReport,
  MergeOptions,
  TextMergeReason,
} from './merge.js';
import { CURRENT_VERSION, extensionOf, readable } from './vfs-file.js';
import { holds, materialised } from './vfs-node.js';
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

/**
 * Everything the engine can stop for. The contract is `docs/conflicts.yaml`.
 *
 * Two levels, one vocabulary: a `pairing` refusal is about the two folders and
 * there is at most one per pass, decided before the merge is computed; an
 * `entry` conflict is about one file and there are as many as there are files.
 * They differ in every mechanical way and in none of the ways a caller cares
 * about — both stop the pass, both need an answer, both leave the folders as
 * they were when the answer does not come.
 */
export type ConflictReason =
  | 'foreign-mesh'
  | 'peer-collision'
  | 'version-unreconcilable'
  | 'content'
  | 'delete-edit'
  | 'path-collision'
  | 'kind'
  | 'location';

/** One folder, as much of it as framing a pairing decision needs. */
export interface FolderContext {
  peerId: string;
  syncId: string | null;
  version: number;
  /** Live entries, so a caller can say "1,240 files against 890". */
  entries: number;
  log: { segment: number; digest: Hash };
  /** Whether this folder has ever completed a sync with anyone. */
  everSynced: boolean;
  /**
   * Whether this engine can read that folder's format at all.
   *
   * Not {@link VersionContext.readable}, which is about bytes on disk. `false`
   * means the format is beyond this engine; `true` on a folder that still
   * stopped the pass means it could be read but no migration covers it — two
   * different problems for whoever is being asked.
   */
  formatReadable: boolean;
}

/** One side of a file conflict, as much of it as framing the decision needs. */
export interface VersionContext {
  /**
   * Identity. Both sides share it for two versions of one file, and they differ
   * for two files colliding on a path — which is the difference between the two.
   */
  uuid: string;
  path: string;
  hash: Hash | null;
  size: number;
  updated: number;
  peerId: string;
  kind: EntryKind;
  deleted: boolean;
  /**
   * Whether these bytes can be read from the peer that holds this version.
   *
   * A UI cannot offer a diff, a preview or a hand-merge without it, and every
   * consumer would otherwise derive it from `held` and `mtime` in its own way.
   */
  readable: boolean;
  /**
   * Entries under this one, `0` for a file.
   *
   * The whole of a directory decision: renaming a folder aside takes everything
   * below it, and "this moves 412 files" is what a person needs to see before
   * saying yes.
   */
  subtree: number;
}

/**
 * What arrives at {@link SyncOptions.decide}, and what a {@link ConflictError}
 * carries one of per unanswered conflict.
 *
 * `'a'` and `'b'` always mean `ctxA` and `ctxB` **of this payload** — never the
 * arguments of `sync(a, b)`. A path collision is between two entries, and which
 * peer contributed each is not the question being answered.
 */
export interface ConflictPayload {
  reason: ConflictReason;
  level: 'pairing' | 'entry';
  /** What an answer names: the entry's uuid, or the `reason` for a pairing refusal. */
  id: string;
  /** Absent on a pairing refusal. */
  path?: string;
  /** The ancestor, when the chain turned one up. */
  base?: Hash;
  /** Why the three-way merge did not settle it, when one was attempted. */
  textReason?: TextMergeReason;
  /** The version this engine writes — `version-unreconcilable` only. */
  engine?: number;
  ctxA: FolderContext | VersionContext;
  ctxB: FolderContext | VersionContext;
}

/**
 * How a conflict is settled.
 *
 * **`side` names the side that stays as it is; the other yields.** The version
 * that survives, the peer that keeps its identity. Naming it `wins` would be a
 * trap — for `reidentify` the side named is the one that does *not* change.
 *
 * `adopt` is the exception and deliberately so: naming a side **authorises this
 * merge**, it does not choose the outcome. Which `syncId` survives is not the
 * caller's to pick — the smaller one does, so a mesh whose edges are authorised
 * separately by different people still settles on one value. What the side
 * proves is that you saw *this* collision, which is why it is not a boolean.
 */
export type ConflictAnswer =
  | { action: 'keep'; side: 'a' | 'b' }
  | { action: 'keep-both' }
  | { action: 'replace'; content: Uint8Array }
  | { action: 'adopt'; side: 'a' | 'b' }
  | { action: 'reidentify'; side: 'a' | 'b' }
  | { action: 'abort' };

export type ConflictAction = ConflictAnswer['action'];

/**
 * What may be answered to a given reason — `docs/conflicts.yaml` in code.
 *
 * It exists because a consumer building a dialog needs exactly this table, and
 * the only other copy is a YAML file no program can read. Without it every UI
 * re-derives the contract by hand, wrongly and quietly, the way every one of
 * them would have re-derived `readable`.
 *
 * `abort` is in every row: declining is always available, and returning nothing
 * means it.
 */
export function legalAnswers(reason: ConflictReason): ConflictAction[] {
  switch (reason) {
    case 'foreign-mesh':
      return ['adopt', 'abort'];
    case 'peer-collision':
      // Not `adopt`: merging two folders that claim one identity is not a
      // decision anyone can make well. One of them has to stop claiming it.
      return ['reidentify', 'abort'];
    case 'version-unreconcilable':
      // No `migrate` and no `override`. Both would mean rewriting a folder into
      // another format and that migration does not exist — an action in a
      // contract is a promise, and that one cannot be kept.
      return ['abort'];
    case 'content':
    case 'delete-edit':
      return ['keep', 'keep-both', 'replace', 'abort'];
    case 'path-collision':
    case 'kind':
      // No `replace`: bytes cannot answer which of two files keeps a name.
      // `keep-both` confirms rather than changes — both entries survive either
      // way — and it is admitted so that a "never lose anything" policy has an
      // answer here instead of a deadlock.
      return ['keep', 'keep-both', 'abort'];
    case 'location':
      return ['keep', 'abort'];
  }
}

/**
 * An answer that names an action its reason does not admit.
 *
 * A caller's mistake rather than a conflict, so it is thrown where it happens
 * instead of leaving the conflict outstanding. Silence was the first design and
 * it was wrong in a way only the intended shape shows: a consumer loops —
 * answer, sync again, answer what comes back — and an answer the engine quietly
 * declines to apply means the same conflict returns forever.
 */
export class AnswerError extends Error {
  readonly reason: ConflictReason;
  readonly action: ConflictAction;
  readonly allowed: ConflictAction[];

  constructor(reason: ConflictReason, action: ConflictAction, id: string) {
    const allowed = legalAnswers(reason);
    super(`'${action}' is not an answer to '${reason}' (${id}) — try ${allowed.join(', ')}`);
    this.name = 'AnswerError';
    this.reason = reason;
    this.action = action;
    this.allowed = allowed;
  }
}

/**
 * An answer handed back as data, for a UI that went away and came back.
 *
 * Same vocabulary as {@link SyncOptions.decide}, plus the two hashes the answer
 * was given about: pass them and an answer to a dispute that has **moved on**
 * since the user looked at it is ignored and reported again, rather than
 * applied to a version they never saw.
 */
export type SyncDecision = ConflictAnswer & {
  id: string;
  a?: Hash | null;
  b?: Hash | null;
};

export interface SyncOptions {
  /**
   * Settles conflicts a previous pass reported.
   *
   * A decision that names no live conflict is ignored, so a stale list costs
   * nothing. A partial one is ordinary — and what is left unanswered still stops
   * the pass, because half a decision is not a decision.
   */
  decisions?: SyncDecision[];
  /**
   * Asked once per conflict, before anything is written.
   *
   * Without it, a conflict nobody answered **throws** {@link ConflictError} with
   * all of them — because `pending` in a returned result can be ignored by
   * accident, and a pass that stopped for a conflict then looks exactly like a
   * pass that had nothing to do.
   *
   * With it, answering `{ action: 'abort' }` (or nothing) is an answer: the pass
   * returns with `applied: false` and writes nothing. A person cancelling a
   * dialog is an outcome, not a failure.
   */
  decide?: (conflict: ConflictPayload) => Promise<ConflictAnswer | null> | ConflictAnswer | null;
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
   * Plans the pass and reports it without writing anything to either folder.
   *
   * The same code path as a real sync up to the point where it would start
   * writing — one implementation, so a preview cannot describe a sync that would
   * not happen.
   */
  dryRun?: boolean;
  /**
   * Authorises merging two folders the pairing guard stopped, by naming one of
   * the two `syncId`s the {@link ConflictError} reported.
   *
   * Specific on purpose: a blanket `true` would disarm the guard at this call
   * site forever, including a different collision months later. A `peerId`
   * collision is **not** authorisable this way — merging two nodes with one
   * identity is not a decision anyone can make well, and the remedy lies
   * outside sync.
   */
  adopt?: { syncId: string };
}

/**
 * What a pass did, or — with `dryRun` — what it would have done.
 *
 * One type for both, because they are one computation: everything here is
 * decided before the first byte is written, and a dry run is that same
 * computation stopped at the seam.
 */
export interface SyncResult {
  /**
   * False when nothing was written: a dry run, or a conflict somebody declined.
   *
   * The only reason this field survives at all — a pass that returns has applied,
   * because anything a person had to settle throws instead.
   */
  applied: boolean;
  /** False when both folders were already identical. */
  changed: boolean;
  /** Whether the `text` config converged in this pass. */
  configChanged: boolean;
  conflicts: ConflictReport[];
  /**
   * What a person has to settle before anything is written, in the shape of the
   * contract — the same payloads {@link ConflictError} carries and `decide` is
   * asked about.
   *
   * A pairing refusal appears here too, which is why these are payloads and not
   * merge reports: it is about the two folders and there is no file to report.
   */
  pending: ConflictPayload[];
  /** Content copies, performed or predicted, in each direction. */
  transferred: { toA: number; toB: number };
  /** Text conflicts settled by a three-way merge instead of a copy. */
  merged: number;
  /** Paths settled by the text auto-merge. */
  mergedPaths: string[];
  /** File-system actions, performed or predicted, per peer. */
  actions: { toA: SyncAction[]; toB: SyncAction[] };
  /** The digest both peers end on, or `null` when the pair is empty. */
  state: Hash | null;
}

export type SyncActionType = 'write' | 'delete' | 'rename' | 'mkdir';

export interface SyncAction {
  type: SyncActionType;
  uuid: string;
  kind: EntryKind;
  path: string;
  /** Present on `write` actions that create a new file on that side. */
  created?: boolean;
  from?: string;
  to?: string;
}

/**
 * Everything a pass decided before it was allowed to write anything.
 *
 * This is the seam. `sync()` builds one of these and then either reports it
 * (`dryRun`) or carries it out — so the two can never describe different syncs,
 * which is what two implementations of this computation could not promise.
 */
interface SyncPlan {
  /** Both sides already agree: there is nothing to merge, transfer or write. */
  quiet: boolean;
  fileA: VFSFile;
  fileB: VFSFile;
  syncId: string;
  at: number;
  configChanged: boolean;
  conflicts: ConflictReport[];
  pending: ConflictPayload[];
  /** A conflict was put to somebody and they said no. Not the same as unanswered. */
  declined: boolean;
  /** What the refusal says, when the engine has better words than "needs a decision". */
  message?: string;
  /** The entry list both peers adopt. */
  target: VFSEntry[];
  /** Content minted during planning (auto-merged text), by hash. */
  overlay: Map<Hash, Uint8Array>;
  /** Log rows for the versions planning itself minted. */
  extra: Array<Omit<LogRow, 'op'>>;
  rowsA: LogRow[];
  rowsB: LogRow[];
  actions: { toA: SyncAction[]; toB: SyncAction[] };
  transferred: { toA: number; toB: number };
  merged: number;
  mergedPaths: string[];
  state: Hash | null;
  changed: boolean;
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
  const dry = options.dryRun === true;

  if (a === b) {
    // A node against itself still reconciles its own disk — that is what a sync
    // does first — and there is nothing else to decide.
    if (!dry) await a.commit();
    return {
      applied: !dry,
      changed: false,
      configChanged: false,
      conflicts: [],
      pending: [],
      transferred: { toA: 0, toB: 0 },
      merged: 0,
      mergedPaths: [],
      actions: { toA: [], toB: [] },
      state: await a.state(),
    };
  }

  const plan = await planSync(a, b, options, dry);
  const preview = report(plan, plan.transferred, false);
  if (dry) return preview;

  // Nothing is written while a conflict is waiting for a person. The whole plan
  // is known by now — including the 900 files that have nothing to do with the
  // dispute — and none of it lands, so the folder the user is looking at does
  // not change under them while they decide.
  //
  // Somebody was asked and said no: that is an answer, and an answer comes back
  // as a result. Nobody was asked at all: that throws, because a `pending` in a
  // returned result can be ignored by accident, and a pass that stopped for a
  // conflict then looks exactly like a pass that had nothing to do.
  if (plan.pending.length > 0) {
    if (plan.declined) return preview;
    throw new ConflictError(
      plan.pending,
      plan.message ??
        (plan.pending.length === 1
          ? `${plan.pending[0]?.path ?? plan.pending[0]?.reason} needs a decision`
          : `${plan.pending.length} conflicts need a decision`),
    );
  }


  return applyPlan(a, b, plan);
}

/**
 * Whether this conflict is one a person has to settle.
 *
 * Two kinds are excluded, and neither is a shortcut:
 *
 * - **settled** — the three-way merge (or a `resolveText` hook) already produced
 *   content both sides adopt. The report survives so the caller can see it
 *   happened, not because anything is outstanding.
 * - **`location`** — the same file renamed differently on each side. One path
 *   wins, deterministically, and no content is at risk: nobody has to choose
 *   between two versions, because there is only one.
 *
 * - **nothing at risk on either side** — neither version has content. This is a
 *   directory one peer removed and the other still had: a directory has no
 *   hash, so `descends()` cannot prove the removal is a propagation and the
 *   merge classifies it as a divergence. It is not one. Nothing can be lost by
 *   taking the winner, and there are no two versions for a person to compare.
 *   Any file that *was* under it is an entry of its own and conflicts on its
 *   own terms.
 *
 * What is left is `content`, `delete-edit` and `kind`: two versions, and no way
 * for the engine to know which one a person meant to keep.
 */
function needsDeciding(report: ConflictReport): boolean {
  if (report.settled || report.kind === 'location') return false;
  return !!report.a?.hash || !!report.b?.hash;
}

/** A plan turned into the shape callers see. */
function report(plan: SyncPlan, transferred: SyncResult['transferred'], applied: boolean): SyncResult {
  return {
    applied,
    changed: plan.changed,
    configChanged: plan.configChanged,
    conflicts: plan.conflicts,
    pending: plan.pending,
    transferred,
    merged: plan.merged,
    mergedPaths: plan.mergedPaths,
    actions: plan.actions,
    state: plan.state,
  };
}

/**
 * Everything a pass can decide without writing: what the two folders hold, which
 * of them may merge at all, the tree they will agree on, and the exact actions
 * that would follow.
 *
 * `dry` changes one thing only — whether the scan is persisted — and that
 * asymmetry is the reason it exists as a parameter instead of a second function:
 * a preview computed by different code than the sync it previews is a preview of
 * nothing in particular.
 */
async function planSync(
  a: VFSNode,
  b: VFSNode,
  options: SyncOptions,
  dry: boolean,
): Promise<SyncPlan> {
  const now = options.now ?? (() => Date.now());

  // Disk has to become entries either way. A pass that is going to write
  // persists that — which is all `commit()` is — and a dry run must not, so it
  // scans and carries the rows a commit *would* have appended into the history
  // below, where they answer the same questions.
  const scanned = dry ? await Promise.all([a.scan(), b.scan()]) : null;
  if (!scanned) {
    await a.commit();
    await b.commit();
  }
  const fileA = await a.file();
  const fileB = await b.file();
  const entriesA = scanned ? scanned[0].entries : fileA.entries;
  const entriesB = scanned ? scanned[1].entries : fileB.entries;

  // ---- 2. may these two folders merge at all? Nothing of the merge has been
  //         computed yet, let alone written, which is what makes stopping here
  //         safe — and what makes it answerable.
  const paired = await settlePairing(a, b, fileA, fileB, options);
  if ('refusal' in paired) {
    return {
      quiet: false,
      fileA,
      fileB,
      syncId: '',
      at: now(),
      configChanged: false,
      conflicts: [],
      pending: [paired.refusal],
      declined: paired.answered,
      message: paired.message,
      target: [],
      overlay: new Map(),
      extra: [],
      rowsA: [],
      rowsB: [],
      actions: { toA: [], toB: [] },
      transferred: { toA: 0, toB: 0 },
      merged: 0,
      mergedPaths: [],
      state: null,
      changed: false,
    };
  }
  const syncId = paired.syncId;

  // ---- 3. config converges: `text` by union. Computed always; written onto the
  //         two files only by a pass that is going to write anything at all.
  const config = convergeConfig(fileA, fileB);
  if (!scanned) applyConfig(fileA, fileB, config);

  // ---- 4. one comparison decides whether there is anything to do at all.
  //         A dry run cannot use it: `state` is what the *last* write recorded,
  //         and the scan this run just did was deliberately not written.
  const at = now();
  if (
    !scanned &&
    fileA.state === fileB.state &&
    fileA.log.digest === fileB.log.digest &&
    !refillable(a, fileA, fileB) &&
    !refillable(b, fileB, fileA)
  ) {
    return {
      quiet: true,
      fileA,
      fileB,
      syncId,
      at,
      configChanged: config.changed,
      conflicts: [],
      pending: [],
      declined: false,
      target: [],
      overlay: new Map(),
      extra: [],
      rowsA: [],
      rowsB: [],
      actions: { toA: [], toB: [] },
      transferred: { toA: 0, toB: 0 },
      merged: 0,
      mergedPaths: [],
      state: fileA.state,
      changed: config.changed,
    };
  }

  // ---- 5/6. entries, and the log only where the entries cannot answer alone
  const sources: Array<Iterable<LogRow> | Iterable<VFSEntry>> = [entriesA, entriesB];
  let rowsA: LogRow[] = [];
  let rowsB: LogRow[] = [];
  // Each side's *own* knowledge, which is what the path fallback turns on: the
  // shared history below is the union of both and would vouch for everything.
  const ownA = History.from([entriesA]);
  const ownB = History.from([entriesB]);
  if (scanned) {
    ownA.add(scanned[0].rows);
    ownB.add(scanned[1].rows);
    sources.push(scanned[0].rows, scanned[1].rows);
  }

  if (needsLog(entriesA, entriesB)) {
    rowsA = await a.store.logRows();
    rowsB = await readPeerLog(b, fileA.peers[b.peerId]);
    const snapA = await a.store.readSnapshot(fileA);
    const snapB = await b.store.readSnapshot(fileB);
    ownA.add(rowsA).add(snapA);
    ownB.add(rowsB).add(snapB);
    sources.push(rowsA, rowsB, snapA, snapB);
  }
  const history = History.from(sources);

  // `syncId === null` is "has never synced with anybody", and it is still the
  // pre-pass value here: `pair()` decided what the two will share, but neither
  // file has been written yet. A folder joining a mesh takes its identities.
  const sides = {
    peerId: a.peerId,
    entries: entriesA,
    knows: (uuid: string) => ownA.knows(uuid),
    joining: fileA.syncId === null,
  };
  const other = {
    peerId: b.peerId,
    entries: entriesB,
    knows: (uuid: string) => ownB.knows(uuid),
    joining: fileB.syncId === null,
  };

  // ---- merge
  const mergeOptions: MergeOptions = {
    history,
    heldAt: options.heldAt ?? HELD_AT,
    text: textPredicate(a, b, config.text),
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

  // ---- the shape of the tree, before its contents
  //
  // An answer about a *name* changes the tree the merge produces, so it is asked
  // first and fed back into a second merge — the aside rename, the subtree a
  // directory takes with it, and the fixed point all stay in the one function
  // that gets them right, instead of being unpicked afterwards.
  const answers = new Map<string, ConflictAnswer>();
  let declined = await collectAnswers(merge, options, isPathConflict, answers);
  const keepers = keepersFrom(merge.conflicts, answers);
  if (keepers.size > 0) merge = mergeEntries(sides, other, { ...mergeOptions, keepers });

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

  // ---- decisions: what a person settled, after the engine settled what it could
  if (await collectAnswers(merge, options, (report) => !isPathConflict(report), answers)) {
    declined = true;
  }
  const settled = await applyAnswers(a, merge, answers, options, {
    overlay,
    rows: extra,
    batch,
    at,
  });

  const target = merge.entries;
  const planA = planChanges(entriesA, target, a);
  const planB = planChanges(entriesB, target, b);

  const overlayHashes = new Set(overlay.keys());
  const remoteFromB = new Set(fileHashes(entriesB, b));
  const remoteForB = new Set([...fileHashes(target, a), ...fileHashes(entriesA, a)]);

  return {
    quiet: false,
    fileA,
    fileB,
    syncId,
    at,
    configChanged: config.changed,
    conflicts: merge.conflicts,
    pending: merge.conflicts
      .filter((report) => needsDeciding(report) && !settled.has(conflictKey(report)))
      .map((report) => entryPayload(report, target)),
    declined,
    target,
    overlay,
    extra,
    rowsA,
    rowsB,
    actions: { toA: planA.actions, toB: planB.actions },
    transferred: {
      toA: countTransfers(planA.writes, planA.localHashes, overlayHashes, remoteFromB),
      toB: countTransfers(planB.writes, planB.localHashes, overlayHashes, remoteForB),
    },
    merged: merged.count,
    mergedPaths: merged.paths,
    state: await stateDigest(target),
    changed:
      config.changed ||
      merge.conflicts.length > 0 ||
      merged.count > 0 ||
      planA.actions.length > 0 ||
      planB.actions.length > 0,
  };
}

/**
 * Carries out a plan: content first, then the logs, then the two headers.
 *
 * The order is not a preference. Content is on disk before anything claims it
 * is, and the headers land last because they are what makes the rest official —
 * an interruption anywhere leaves a state the next pass can still reconcile.
 */
async function applyPlan(a: VFSNode, b: VFSNode, plan: SyncPlan): Promise<SyncResult> {
  const { fileA, fileB, target, overlay } = plan;

  if (plan.quiet) {
    await close(a, b, fileA, fileB, [], [], plan.at, plan.syncId);
    return report(plan, { toA: 0, toB: 0 }, true);
  }

  // ---- content moves, verified on arrival
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

  // ---- close: content is on disk, then the logs, then the two headers
  const rowsForA = [...(await Promise.all(plan.extra.map(makeRow)))];
  const rowsForB = [...rowsForA];
  if (plan.rowsA.length > 0 || plan.rowsB.length > 0) {
    rowsForA.push(...missingRows(plan.rowsA, plan.rowsB));
    rowsForB.push(...missingRows(plan.rowsB, plan.rowsA));
  }

  await a.adopt(target, fileA);
  await b.adopt(target, fileB);
  await close(a, b, fileA, fileB, rowsForA, rowsForB, plan.at, plan.syncId);

  return {
    // A pass that got past the quiet check had something to reconcile, whatever
    // the plan's own prediction of `changed` says about the visible outcome.
    ...report(plan, transferred, true),
    changed: true,
  };
}

interface PlannedChanges {
  actions: SyncAction[];
  writes: VFSEntry[];
  localHashes: Set<Hash>;
}

function planChanges(currentEntries: VFSEntry[], target: VFSEntry[], node: VFSNode): PlannedChanges {
  const nodeId = node.peerId;
  const current = new Map(currentEntries.map((entry) => [entry.uuid, entry]));
  const currentLive = currentEntries.filter((entry) => !entry.deleted);
  const targetByUuid = new Set(target.map((entry) => entry.uuid));

  const actions: SyncAction[] = [];
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
    // The same rule `apply()` applies, and it has to be the same one or the
    // dry run describes a sync that will not happen: the policy decides what
    // arrives, never what is already on disk.
    if (!node.wants(entry) && !materialised(before)) continue;

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

    if (!wasLive || before?.hash !== entry.hash || !materialised(before)) {
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
    if (!materialised(entry)) continue; // the entry is here, the bytes are not
    localHashes.add(entry.hash);
  }

  return {
    actions: sortActions(actions),
    writes,
    localHashes,
  };
}

/**
 * Conflicts nobody answered.
 *
 * One error for both levels, because they are one question — a pairing refusal
 * is simply a `conflicts` of length one with `level: 'pairing'`. The engine's
 * other failures are strings for humans; a caller cannot build a decision out of
 * one of those, so this carries the cases and the data to frame them.
 *
 * Thrown only when there was no {@link SyncOptions.decide} to ask. A callback
 * that answered `abort` was asked and said no, which returns rather than throws.
 */
export class ConflictError extends Error {
  readonly conflicts: ConflictPayload[];

  constructor(conflicts: ConflictPayload[], message: string) {
    super(message);
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }

  /** True when the pass stopped over the two folders rather than over their files. */
  get pairing(): boolean {
    return this.conflicts.some((conflict) => conflict.level === 'pairing');
  }
}

/** Enough of one side to frame the decision the library will not make alone. */
type PairingSide = FolderContext;

function sideOf(file: VFSFile): PairingSide {
  return {
    peerId: file.peerId,
    syncId: file.syncId,
    version: file.version,
    entries: file.entries.filter((entry) => !entry.deleted).length,
    log: { segment: file.log.segment, digest: file.log.digest },
    // Which folder is the safe one to reidentify: one that never synced has no
    // peer holding marks against its id.
    everSynced: Object.keys(file.peers).length > 0,
    formatReadable: readable(file.version),
  };
}

/**
 * Whether these two folders may merge at all, and which group id survives if
 * they may.
 *
 * Two checks, in this order and not the other:
 *
 * 1. **version** — can I interpret this file? Reading `peerId` and `syncId`
 *    means nothing until you know which version wrote them, so this comes
 *    first. `decodeVFSFile` has already migrated everything it can, so a file
 *    still short of the current version is one no `migrate` covers.
 * 2. **identity** — should I merge with this group?
 *
 * The benign `syncId` combinations are not errors and are what ordinary use
 * looks like: equal (every sync after the first), both `null` (two virgin
 * folders, mint one), and one set against one `null` (a folder joining a
 * group — it has no affiliation to lose, so no tiebreak is needed).
 *
 * The library detects, describes and stops. It does not ask, and it does not
 * decide: that is coherent with not interpreting content, and the question is
 * not "which folder wins" — there is no such mode. Resolution stays per file
 * and per version, with ancestry above the clock. The only thing decided here
 * is **whether to merge at all**.
 */
function pair(
  fileA: VFSFile,
  fileB: VFSFile,
  adopt?: { syncId: string },
): { syncId: string } | { refusal: ConflictPayload; message: string } {
  const a = sideOf(fileA);
  const b = sideOf(fileB);

  for (const side of [a, b]) {
    if (side.version === CURRENT_VERSION) continue;
    return {
      refusal: { ...pairingPayload('version-unreconcilable', a, b), engine: CURRENT_VERSION },
      message: readable(side.version)
        ? `a version ${side.version} folder did not migrate to ${CURRENT_VERSION}`
        : `version ${side.version} cannot be read by an engine that writes ${CURRENT_VERSION}`,
    };
  }

  if (a.peerId === b.peerId) {
    // Not a bet against chance — `randomId()` is a UUIDv4 and a random
    // collision is negligible. The collisions that happen are certainties: a
    // copied `.vfs`, or a caller deriving `options.id` from something that is
    // not unique. Deliberately one code for both, because a clone predating
    // the first sync and an imposed id are identical from here; the log digests
    // travel in the error so a caller can tell them apart without the library
    // committing to a conclusion it would be guessing at.
    return {
      refusal: pairingPayload('peer-collision', a, b),
      message: `both folders identify as peer ${a.peerId}: one of them is a copy, or the id was imposed`,
    };
  }

  if (a.syncId !== null && b.syncId !== null && a.syncId !== b.syncId) {
    // Authorisation is specific: naming one of the two ids proves the caller
    // saw *this* collision. `{ adopt: true }` would disarm the guard at this
    // call site forever, including a different collision months later. It is
    // the idiom `writeIf(path, data, tag)` already uses.
    if (!adopt || (adopt.syncId !== a.syncId && adopt.syncId !== b.syncId)) {
      return {
        refusal: pairingPayload('foreign-mesh', a, b),
        message: `these folders belong to different groups (${a.syncId} and ${b.syncId})`,
      };
    }
  }

  // The smaller survives — deterministic and transitive, so a whole mesh
  // settles on one value without coordinating. Minting needs no agreement
  // either: `sync()` has both files in front of it and hands one id to both.
  if (a.syncId !== null && b.syncId !== null) {
    return { syncId: [a.syncId, b.syncId].sort()[0] as string };
  }
  return { syncId: a.syncId ?? b.syncId ?? randomId() };
}

/**
 * The pairing question, put to whoever can answer it.
 *
 * Answering `adopt` or `reidentify` is not a merge decision — it repairs the
 * relationship between the two folders so that a merge is possible at all — so
 * it is applied here, before the merge is computed. A `reidentify` therefore
 * lands even if a file conflict stops the pass a moment later, and that is
 * correct: the identity was broken, the caller said which side fixes it, and
 * retrying the pass is free.
 */
async function settlePairing(
  a: VFSNode,
  b: VFSNode,
  fileA: VFSFile,
  fileB: VFSFile,
  options: SyncOptions,
): Promise<{ syncId: string } | { refusal: ConflictPayload; message: string; answered: boolean }> {
  let adopt = options.adopt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const paired = pair(fileA, fileB, adopt);
    if ('syncId' in paired) return paired;
    if (attempt > 0) return { ...paired, answered: false };

    const given = (options.decisions ?? []).find((decision) => decision.id === paired.refusal.reason);
    const answer = given ?? (options.decide ? await options.decide(paired.refusal) : null);
    if (!answer || answer.action === 'abort') {
      return { ...paired, answered: !!answer || (!given && !!options.decide) };
    }
    if (!legalAnswers(paired.refusal.reason).includes(answer.action)) {
      throw new AnswerError(paired.refusal.reason, answer.action, paired.refusal.id);
    }

    const side = 'side' in answer ? answer.side : 'a';
    if (answer.action === 'adopt') {
      const chosen = (side === 'a' ? paired.refusal.ctxA : paired.refusal.ctxB) as FolderContext;
      if (!chosen.syncId) return { ...paired, answered: false };
      adopt = { syncId: chosen.syncId };
      continue;
    }
    if (answer.action === 'reidentify') {
      // `side` is the one that keeps its id, so the *other* node mints a new one.
      await (side === 'a' ? b : a).reidentify();
      const refreshed = await (side === 'a' ? b : a).file();
      if (side === 'a') fileB.peerId = refreshed.peerId;
      else fileA.peerId = refreshed.peerId;
      continue;
    }
    return { ...paired, answered: false };
  }
  return { ...pair(fileA, fileB, adopt) } as never;
}

/** A pairing refusal in the shape every other conflict arrives in. */
function pairingPayload(reason: ConflictReason, a: PairingSide, b: PairingSide): ConflictPayload {
  // `id` is the reason itself: there is at most one pairing refusal per pass, so
  // it needs nothing to tell it from another one.
  return { reason, level: 'pairing', id: reason, ctxA: a, ctxB: b };
}

interface ConvergedConfig {
  text: string[];
  changed: boolean;
}

/**
 * The config both files have to agree on, and whether they already do.
 *
 * `text` converges by **union**, so no peer loses a classification another one
 * added. Group identity is deliberately not here: `syncId` is decided by the
 * pairing guard and written in `close()`, because affiliation records a sync
 * that happened rather than one that was attempted.
 *
 * Computed without writing, because a `dryRun` has to answer the same question
 * without touching either folder. One implementation for both: a second copy is
 * a second answer.
 */
function convergeConfig(fileA: VFSFile, fileB: VFSFile): ConvergedConfig {
  const text = [...new Set([...fileA.text, ...fileB.text])].sort();
  return {
    text,
    changed: fileA.text.join() !== text.join() || fileB.text.join() !== text.join(),
  };
}

/**
 * The single predicate the merge takes, folded out of three sources: the
 * converged extension list, and each node's own `text` policy.
 *
 * Union, and it has to be. The base comes from whichever peer kept one —
 * `autoMergeText` asks `a` and then `b` — so one side having classified the path
 * as text is enough for both to get the merge. It also means a node's policy can
 * only ever add: what it declines, the other side's list may still claim.
 */
function textPredicate(a: VFSNode, b: VFSNode, list: string[]): (path: string) => boolean {
  return (path) => {
    const extension = extensionOf(path);
    if (extension !== '' && list.includes(extension)) return true;
    return a.marksText(path) || b.marksText(path);
  };
}

/** Writes a converged config onto both files. `sync()` only — never the dry run. */
function applyConfig(fileA: VFSFile, fileB: VFSFile, config: ConvergedConfig): void {
  fileA.text = [...config.text];
  fileB.text = [...config.text];
}

/**
 * Content `node` wants, does not have, and the other side looks able to hand
 * over.
 *
 * The `state` comparison cannot see this. Which bytes a node stores is local
 * policy and is deliberately outside the digest — it has to be, or two peers
 * with different policies would never agree on `state` and would sync forever.
 * So two peers can hold identical trees while one is still missing files it
 * wants, and the fast path would skip the transfer that fixes it.
 *
 * It is checked against what the other side actually holds, not just against
 * the wish: a mesh where nobody has the bytes stays on the fast path instead of
 * re-planning a transfer nobody can serve on every pass. Entry inspection only,
 * no I/O, and the common case — nothing missing — never looks at the far side.
 */
function refillable(node: VFSNode, own: VFSFile, other: VFSFile): boolean {
  const missing: Hash[] = [];
  for (const entry of own.entries) {
    if (entry.deleted || entry.kind !== 'file' || !entry.hash) continue;
    if (entry.held && entry.held !== node.peerId) continue;
    if (materialised(entry) || !node.wants(entry)) continue;
    missing.push(entry.hash);
  }
  if (missing.length === 0) return false;

  const available = new Set<Hash>();
  for (const entry of other.entries) {
    if (entry.deleted || entry.kind !== 'file' || !entry.hash || entry.held) continue;
    if (materialised(entry)) available.add(entry.hash);
  }
  return missing.some((hash) => available.has(hash));
}

/**
 * Hashes `node` can serve: what it holds now, plus what its policy will make it
 * hold. Only feeds the dry run's transfer estimate, so erring here misreports a
 * number rather than losing anything.
 */
function fileHashes(entries: VFSEntry[], node: VFSNode): Hash[] {
  const hashes: Hash[] = [];
  for (const entry of entries) {
    if (entry.deleted || entry.kind !== 'file' || !entry.hash || entry.held) continue;
    if (!node.wants(entry) && !materialised(entry)) continue;
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

function sortActions(actions: SyncAction[]): SyncAction[] {
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
  syncId: string,
): Promise<void> {
  if (rowsForA.length > 0) await a.store.append(rowsForA, fileA);
  if (rowsForB.length > 0) await b.store.append(rowsForB, fileB);

  fileA.peers[b.peerId] = {
    lastSync: at,
    segment: fileB.log.segment,
    offset: fileB.log.size,
    digest: fileB.log.digest,
  };
  fileB.peers[a.peerId] = {
    lastSync: at,
    segment: fileA.log.segment,
    offset: fileA.log.size,
    digest: fileA.log.digest,
  };
  // Affiliation lands here, with the peer marks, for two reasons: both files are
  // written in the same pass, so there is no window where one is affiliated and
  // the other is not; and a sync that fails before reaching this point leaves
  // neither affiliated — the `syncId` records a sync that happened, not one that
  // was attempted.
  fileA.syncId = fileB.syncId = syncId;
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
    if (left.size > MAX_TEXT_MERGE || right.size > MAX_TEXT_MERGE) {
      report.textReason = 'size';
      continue;
    }

    const ancestor = report.base ?? history.commonAncestor(report.uuid, left, right);
    const baseBytes = ancestor
      ? ((await a.baseOf(ancestor)) ?? (await b.baseOf(ancestor)))
      : null;
    const mine = await readAt(a, left.path);
    const theirs = await readAt(b, right.path);
    // One of the two peers does not hold the bytes — dematerialised, or held on
    // the peer that made the copy. Nothing to merge from, and it is not a
    // refusal: the same conflict merges once the content is fetched.
    if (!mine || !theirs) {
      report.textReason = 'unreadable';
      continue;
    }

    const baseText = baseBytes ? decodeText(baseBytes) : null;
    let text: string | null = null;
    // Why it did not merge, kept until the hook has had its turn: a hook that
    // settles it makes the reason moot.
    let refused: TextMergeReason | undefined;
    if (context.enabled) {
      if (baseText === null) refused = 'no-base';
      else {
        const attempt = diff3(baseText, decodeText(mine), decodeText(theirs));
        if (attempt.ok) text = attempt.text;
        else refused = attempt.reason;
      }
    }
    if (text === null && context.resolveText) {
      text = await context.resolveText({
        path: report.path,
        base: baseText,
        a: decodeText(mine),
        b: decodeText(theirs),
        peerA: a.peerId,
        peerB: b.peerId,
      });
    }
    if (text === null) {
      if (refused) report.textReason = refused;
      // The copy was labelled by a merge that had not read a byte, so anything
      // not a delete or a kind collision was called `binary`. By here the bytes
      // have been read and diff3 has had its turn, and `binary` would be false
      // three ways: it was text, a merge was attempted, and the lines collided.
      // That distinction is what a resolver reads months later to decide between
      // offering "keep mine / keep theirs" and offering a three-way view.
      //
      // Only `block` crosses over. `eol` and `size` have no durable value, and
      // giving them one would widen a type that travels to every peer.
      if (refused === 'block' && report.copy) report.copy.reason = 'block';
      continue;
    }

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
    entry.peerId = a.peerId;
    entry.prev = winner.hash;
    if (loser.hash) entry.prev2 = loser.hash;

    // The copy was only ever the pending decision; the merge settled it.
    if (report.copy) {
      const at = merge.entries.indexOf(report.copy);
      if (at >= 0) merge.entries.splice(at, 1);
      delete report.copy;
    }
    report.text = true;
    report.settled = true;
    context.rows.push({
      batch: context.batch,
      at: entry.updated,
      peerId: a.peerId,
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

/**
 * A conflict in the shape the contract describes, so `decide` and
 * `ConflictError` hand out the same thing.
 */
function entryPayload(report: ConflictReport, target: VFSEntry[] = []): ConflictPayload {
  const context = (entry: VFSEntry): VersionContext => ({
    uuid: entry.uuid,
    path: entry.path,
    hash: entry.hash,
    size: entry.size,
    updated: entry.updated,
    peerId: entry.peerId,
    kind: entry.kind,
    deleted: !!entry.deleted,
    // Disk is the ground truth: the side that recorded this version can serve
    // it when the file is still there. `held` is the other way to have an entry
    // and not the bytes.
    readable: !entry.deleted && !!entry.hash && materialised(entry) && !entry.held,
    subtree:
      entry.kind === 'directory'
        ? target.filter((item) => !item.deleted && item.path.startsWith(`${entry.path}/`)).length
        : 0,
  });
  return {
    reason: report.kind,
    level: 'entry',
    id: report.uuid,
    path: report.path,
    ...(report.base ? { base: report.base } : {}),
    ...(report.textReason ? { textReason: report.textReason } : {}),
    ctxA: context(report.a as VFSEntry),
    ctxB: context(report.b as VFSEntry),
  };
}

/**
 * A collision over a **name**, rather than over the contents of a file.
 *
 * Both come out of one merge and both are answered through one callback, but
 * they are not the same question and cannot share a code path: here the two
 * sides are different files with their own uuids and their own histories,
 * nothing is at risk, and the answer only says which of them keeps the name.
 */
function isPathConflict(report: ConflictReport): boolean {
  return report.kind === 'path-collision' || report.kind === 'kind';
}

/**
 * What an answer is filed under.
 *
 * A content dispute is filed under the file — one uuid, two versions of it. A
 * path collision is filed under the **name**, because answering it swaps which
 * of the two entries yields: the report that comes back from the second merge
 * names the other uuid, and it is not a new question, it is the same one already
 * answered.
 */
function conflictKey(report: ConflictReport): string {
  return isPathConflict(report) ? `path:${report.path}` : report.uuid;
}

/**
 * Gathers what somebody answered, without settling anything yet.
 *
 * Answers arrive two ways and both land here: as `decisions` from a UI that went
 * away and came back, and from `decide` asked in the moment. The array wins when
 * both answer the same conflict — it is the answer a person has already seen and
 * confirmed, while the callback may be a policy that never looked.
 *
 * Asking is separate from applying because the two dimensions settle in order:
 * an answer about a *name* changes the tree the merge produces, so it has to be
 * known before the tree is final, while an answer about *contents* is applied to
 * that tree afterwards. Each conflict is still put to somebody exactly once —
 * `answers` carries across both rounds and an entry already in it is not
 * asked again.
 */
async function collectAnswers(
  merge: { entries: VFSEntry[]; conflicts: ConflictReport[] },
  options: SyncOptions,
  wanted: (report: ConflictReport) => boolean,
  answers: Map<string, ConflictAnswer>,
): Promise<boolean> {
  let declined = false;
  const given = new Map<string, SyncDecision>();
  for (const decision of options.decisions ?? []) given.set(decision.id, decision);

  for (const report of merge.conflicts) {
    if (!needsDeciding(report) || !wanted(report) || !report.a || !report.b) continue;
    const key = conflictKey(report);
    if (answers.has(key)) continue;
    let answer: ConflictAnswer | null | undefined = given.get(report.uuid);

    if (answer) {
      const decision = answer as SyncDecision;
      // Answered about a dispute that has moved on: ask again rather than settle
      // it on the user's behalf with a version they never saw.
      const stale =
        (decision.a !== undefined && decision.a !== (report.a.hash ?? null)) ||
        (decision.b !== undefined && decision.b !== (report.b.hash ?? null));
      if (stale) answer = null;
    }
    if (!answer && options.decide) answer = await options.decide(entryPayload(report, merge.entries));
    if (!answer || answer.action === 'abort') {
      if (answer || options.decide) declined = true;
      continue;
    }
    if (!legalAnswers(report.kind).includes(answer.action)) {
      throw new AnswerError(report.kind, answer.action, report.uuid);
    }
    answers.set(key, answer);
  }
  return declined;
}

/**
 * The entries a person put in charge of a name they were contesting.
 *
 * Derived from the first merge's reports and never from a later one: after the
 * swap the same collision is reported with the two sides exchanged, and reading
 * `side` off *that* would flip the answer back on every pass.
 */
function keepersFrom(
  conflicts: ConflictReport[],
  answers: Map<string, ConflictAnswer>,
): Set<string> {
  const keepers = new Set<string>();
  for (const report of conflicts) {
    if (!isPathConflict(report) || !report.b) continue;
    const answer = answers.get(conflictKey(report));
    // `a` is the entry the merge left on the path, so naming it asks for what
    // already happened. Only `b` — the one renamed aside — is a change.
    if (answer?.action === 'keep' && answer.side === 'b') keepers.add(report.b.uuid);
  }
  return keepers;
}

/**
 * Settles the conflicts somebody answered, and reports which ones those were.
 *
 * **A decision mints a new version.** Adopting the chosen side's entry as it
 * stands would not survive: the loser carries the older `updated`, so the next
 * peer to meet this mesh redoes the same arithmetic the engine did, reaches the
 * same answer, and puts the other version back. The decision would quietly undo
 * itself, days later, on a machine nobody was looking at.
 *
 * So the new version carries **two parents** — the winner's hash and the
 * loser's — which is exactly what the automatic text merge records, and for
 * exactly the same reason. A decision is a merge performed by a person and has
 * to leave the same trace as one performed by `diff3`.
 */
async function applyAnswers(
  a: VFSNode,
  merge: { entries: VFSEntry[]; conflicts: ConflictReport[] },
  answers: Map<string, ConflictAnswer>,
  options: SyncOptions,
  context: { overlay: Map<Hash, Uint8Array>; rows: Array<Omit<LogRow, 'op'>>; batch: string; at: number },
): Promise<Set<string>> {
  const settled = new Set<string>();
  if (answers.size === 0) return settled;

  for (const report of merge.conflicts) {
    if (!needsDeciding(report) || !report.a || !report.b) continue;
    const key = conflictKey(report);
    const answer = answers.get(key);
    if (!answer) continue;

    // A name is not a version. Which entry keeps the path was carried out by the
    // merge — the other one is at its aside name with its subtree, nothing was
    // overwritten to get there, and there is no shared identity to mint a
    // version of. Both answers this reason admits say the same thing about the
    // tree, so both are simply confirmations.
    if (isPathConflict(report)) {
      settled.add(key);
      continue;
    }
    // Nothing else can arrive: `collectAnswers` rejected every action this
    // reason does not admit before any of them got here.
    if (answer.action === 'adopt' || answer.action === 'reidentify' || answer.action === 'abort') continue;

    const entry = merge.entries.find((item) => item.uuid === report.uuid);
    if (!entry) continue;
    const winner = report.winner === 'a' ? report.a : report.b;
    const loser = report.winner === 'a' ? report.b : report.a;
    const at = Math.max(context.at, report.a.updated, report.b.updated) + 1;

    let chosen: VFSEntry;
    if (answer.action === 'replace') {
      const data = answer.content;
      const hash = await sha256(data);
      context.overlay.set(hash, data);
      chosen = { ...winner, hash, size: data.byteLength, path: entry.path };
      delete chosen.deleted;
    } else if (answer.action === 'keep') {
      chosen = answer.side === 'a' ? report.a : report.b;
    } else {
      // Keep both: the winner stays where it is and the loser is parked beside
      // it. Still a decision, and it mints like every other one — without that,
      // the next peer holding the loser reaches the engine's original answer and
      // raises the question a person has already been asked.
      chosen = winner;
    }

    entry.kind = chosen.kind;
    entry.hash = chosen.hash;
    entry.size = chosen.size;
    entry.updated = at;
    entry.peerId = a.peerId;
    entry.prev = winner.hash;
    if (loser.hash) entry.prev2 = loser.hash;
    if (chosen.deleted) entry.deleted = true;
    else delete entry.deleted;

    if (answer.action === 'keep-both') {
      // The merge parks a copy by policy, and a winning delete under `'edits'`
      // parks none — so `keep-both` on a delete-versus-edit would keep only the
      // deletion. The answer is more specific than the policy: mint it here.
      const copy = report.copy ?? copyForAnswer(report, mergeCopyOptions(options));
      if (copy && !merge.entries.some((item) => item.uuid === copy.uuid)) merge.entries.push(copy);
      if (copy) report.copy = copy;
    } else if (report.copy) {
      // The copy existed only to hold the pending decision. It has been made.
      const at = merge.entries.indexOf(report.copy);
      if (at >= 0) merge.entries.splice(at, 1);
      delete report.copy;
    }

    context.rows.push({
      batch: context.batch,
      at: entry.updated,
      peerId: a.peerId,
      uuid: entry.uuid,
      type: entry.deleted ? 'delete' : 'write',
      kind: entry.kind,
      path: entry.path,
      hash: entry.hash,
      size: entry.size,
      prev: winner.hash ?? null,
      ...(loser.hash ? { prev2: loser.hash } : {}),
    });
    settled.add(key);
  }
  return settled;
}

/** The two options that shape a conflict copy, wherever one is minted. */
function mergeCopyOptions(options: SyncOptions): MergeOptions {
  return {
    ...(options.conflictName ? { conflictName: options.conflictName } : {}),
    ...(options.heldAt !== undefined ? { heldAt: options.heldAt } : {}),
  };
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
        const handle = await holds(candidate.node, candidate.entries, hash);
        if (!handle) continue;
        onHit();
        return handle;
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
  /** Absent when this edge threw — see {@link MeshResult.error}. */
  result?: SyncResult;
  /** The edge failed. Every other edge in the pass still ran. */
  error?: Error;
}

/**
 * Runs every edge once, in order. Repeat until nothing changes to let updates
 * propagate down a chain — each pass moves a change one hop further.
 */
export async function syncMesh(edges: MeshEdge[], options: SyncOptions = {}): Promise<MeshResult[]> {
  const results: MeshResult[] = [];
  for (const edge of edges) {
    // Per edge, because one badly paired pair must not paralyse the mesh. A
    // throw used to abort the loop and lose every result already collected: in
    // a mesh of five folders with one foreign pairing, none of them synced.
    try {
      results.push({ edge, result: await sync(edge.a, edge.b, options) });
    } catch (error) {
      results.push({ edge, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
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
    // An edge that threw is not progress. Counting it as change would keep the
    // loop going to `maxRounds` on every call, for a failure that repeats
    // identically each time.
    if (!results.some((item) => item.result?.changed)) break;
  }
  return rounds;
}
