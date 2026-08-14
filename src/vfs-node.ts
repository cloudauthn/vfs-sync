import { MAX_TEXT_MERGE } from './diff3.js';
import { decodeText, randomId, sha256, sha256Stream } from './hash.js';
import { History } from './history.js';
import { IGNORE_FILE, excludesRulesFile, matchIgnore, parseIgnore } from './ignore.js';
import { makeRow } from './log.js';
import { Sha256 } from './sha256.js';
import { CONTROL_DIR, VFSStore } from './store.js';
import type { IgnoreRule } from './ignore.js';
import type { VFSStoreOptions } from './store.js';
import { STREAM_THRESHOLD, canStream, pump, readRange, readStream, writeStream } from './stream.js';
import { extensionOf } from './vfs-file.js';
import type {
  ByteRange,
  Hash,
  LogRow,
  PendingConflict,
  VFSAdapter,
  VFSEntry,
  VFSFile,
  VFSStat,
} from './types.js';
import { walk } from './walk.js';
import type { WalkedFile } from './walk.js';

export interface VFSNodeOptions {
  /** Stable peer id. Generated and persisted in `.vfs/vfs.json` if omitted. */
  id?: string;
  /** Return true to keep a path out of sync entirely. */
  ignore?: (path: string) => boolean;
  /**
   * Bytes this node keeps on disk. Everything else: the entry travels, the
   * content does not — the tree is complete, the folder is not. Absent means
   * materialise everything, which is what a node without a policy has always
   * done.
   *
   * ```ts
   * VFSNode.open(fs, { materialize: (entry) => entry.size < 10_000_000 });
   * ```
   *
   * The engine stores nothing about this and nothing about it travels, so the
   * policy can be anything the app knows and can change between two calls. Two
   * consequences worth knowing before relying on it:
   *
   * - It governs what **arrives**, never what is already here. Turning it
   *   `false` for content this node holds does not free the bytes; that is
   *   {@link VFSNode.dematerialize}, which is deliberate and verified.
   * - It is the steady state. {@link VFSNode.materialize} fetches against the
   *   policy, and a policy that still wants the entry will fetch it back on the
   *   next sync.
   */
  materialize?: (entry: VFSEntry) => boolean;
  /**
   * Paths this node treats as text, on top of the mesh-wide extension list
   * (§4). Selection by path is what the list cannot express:
   *
   * ```ts
   * VFSNode.open(fs, { text: (path) => path.startsWith('catalog/') });
   * ```
   *
   * Local like {@link VFSNodeOptions.materialize}: nothing about it travels and
   * the engine stores nothing about it. Two properties it must have to be worth
   * anything:
   *
   * - It is consulted at **commit** as well as at merge. A three-way merge needs
   *   a base, and the base is only there because the version was recorded as
   *   text when it was written — a predicate that arrived at merge time would
   *   classify conflicts it could never settle.
   * - It **adds**; it cannot subtract. `sync()` unions both nodes' answers, so a
   *   subtraction here would be overruled by the other side's list — a switch
   *   that works only when the peer agrees. To turn the merge off, that is
   *   `autoMerge: false` on the sync call: total, and per call.
   */
  text?: (path: string) => boolean;
  /** Injectable clock, mostly for tests. */
  now?: () => number;
  /**
   * Files at or above this many bytes are hashed and moved as streams instead
   * of being held whole. Defaults to {@link STREAM_THRESHOLD} (4 MiB). Only
   * takes effect on adapters that implement the streaming methods.
   */
  streamThreshold?: number;
  /** Active log segment size that triggers a rotation. */
  rotateAt?: number;
}

const TEMP_DIR = `${CONTROL_DIR}/tmp`;

/** Bytes for a hash, however the holder prefers to hand them over. */
export interface ContentHandle {
  size: number;
  read(): Promise<Uint8Array>;
  stream(): Promise<ReadableStream<Uint8Array>>;
  /**
   * Where the bytes actually are, when the holder is willing to vouch for them.
   *
   * This is a claim, not a coordinate. Present means *"the file is where the
   * tree says, and nothing has touched it since the scan recorded it"* — which
   * is the promise a caller needs before it copies natively and skips the hash
   * check. A holder that cannot make that promise omits it and the caller pumps
   * the bytes, which always works and always verifies.
   */
  origin?: { adapter: VFSAdapter; path: string };
}

/** Where `apply()` gets content it does not already have on disk. */
export interface ContentSource {
  open(hash: Hash, entry: VFSEntry): Promise<ContentHandle | null>;
}

/**
 * Whether this node has the file on disk. `mtime` is deleted on every adopt and
 * only ever re-set from a real `stat()`, so its presence means exactly that —
 * the invariant reconciliation leans on to tell a deletion from content that
 * was never here.
 *
 * One name for it because three places have to agree: `scan()` decides whether
 * absence is evidence, `apply()` and `planChanges()` decide whether a policy
 * that declines an entry is allowed to leave its bytes behind at a stale hash.
 */
export function materialised(entry: VFSEntry | undefined): boolean {
  return !!entry && !entry.deleted && entry.mtime !== undefined;
}

/**
 * Bytes for `hash` from whatever path `node` still holds them at.
 *
 * Every candidate path, not just the first: one of them missing from disk does
 * not mean the peer cannot serve the content. Duplicate content is ordinary,
 * and an entry can legitimately have no file behind it — bytes that never
 * travelled, or that this peer has not materialised.
 *
 * Disk is the ground truth here, not policy. A peer serves whatever it happens
 * to hold, whether or not its own predicate would have chosen to keep it.
 */
export async function holds(
  node: VFSNode,
  entries: VFSEntry[],
  hash: Hash,
): Promise<ContentHandle | null> {
  for (const entry of entries) {
    if (entry.deleted || entry.kind !== 'file' || entry.hash !== hash || entry.held) continue;
    const stat = await node.stat(entry.path);
    if (!stat || stat.kind !== 'file') continue;
    const path = entry.path;
    const handle: ContentHandle = {
      size: stat.size,
      read: () => node.read(path),
      stream: () => node.readStream(path),
    };
    // The only place holding both the recorded entry and a fresh stat of the
    // file, so the only place that can vouch for the bytes. `mtime` is the
    // *source's* — the merged entry that reaches `fetchContent()` carries this
    // node's, which is a different clock and would compare meaninglessly.
    if (stat.size === entry.size && entry.mtime !== undefined && stat.mtime === entry.mtime) {
      handle.origin = { adapter: node.adapter, path };
    }
    return handle;
  }
  return null;
}

export interface ScanResult {
  entries: VFSEntry[];
  /** One row per operation the scan discovered. Empty when nothing changed. */
  rows: LogRow[];
  batch: string;
}

/**
 * One participant in the mesh: an adapter (the working folder) plus its `.vfs`
 * control folder. A node only ever knows the peers it syncs with directly.
 *
 * In v2 there is no object store and no commit graph. The working file *is* the
 * content, `vfs.json` is the mirror of the tree, and `commits` is an
 * append-only log of operations whose union across peers is idempotent.
 */
export class VFSNode {
  readonly adapter: VFSAdapter;
  readonly store: VFSStore;
  private id: string;
  /** Size from which content takes the streaming path. See {@link VFSNodeOptions}. */
  readonly streamThreshold: number;

  private readonly ignore: ((path: string) => boolean) | undefined;
  /** Compiled rules from `.vfsignore`, cached against its mtime+size. */
  private shared: IgnoreRule[] = [];
  private sharedStamp: string | null = null;
  private sharedText = '';
  /** Compiled rules from `local.ignore` in the header. */
  private local: IgnoreRule[] = [];
  private readonly policy: ((entry: VFSEntry) => boolean) | undefined;
  private readonly textPolicy: ((path: string) => boolean) | undefined;
  private readonly now: () => number;

  private constructor(adapter: VFSAdapter, id: string, options: VFSNodeOptions, store: VFSStore) {
    this.adapter = adapter;
    this.store = store;
    this.id = id;
    this.ignore = options.ignore;
    this.policy = options.materialize;
    this.textPolicy = options.text;
    this.now = options.now ?? (() => Date.now());
    this.streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  }

  /** Opens (creating `.vfs/` if needed) the folder behind `adapter`. */
  static async open(adapter: VFSAdapter, options: VFSNodeOptions = {}): Promise<VFSNode> {
    const storeOptions: VFSStoreOptions = { ...(options.now ? { now: options.now } : {}) };
    if (options.rotateAt !== undefined) storeOptions.rotateAt = options.rotateAt;
    const store = new VFSStore(adapter, CONTROL_DIR, storeOptions);
    const file = await store.init(options.id ? { peerId: options.id } : {});
    if (options.id && file.peerId !== options.id) {
      file.peerId = options.id;
      await store.write(file);
    }
    return new VFSNode(adapter, file.peerId, options, store);
  }

  get name(): string {
    return this.adapter.name;
  }

  /** This node's identity. Minted at init; only {@link VFSNode.reidentify} moves it. */
  get peerId(): string {
    return this.id;
  }

  /**
   * Mints a fresh identity for this node, and returns it.
   *
   * The remedy for a `peer-collision`, which `sync()` refuses to authorise —
   * merging two nodes with one identity is not a decision anyone can make well.
   * **It fixes one of the two causes.** A copied `.vfs` folder is repaired by
   * this; a caller passing a non-unique `options.id` is not, because the next
   * `open()` imposes the same id again. The library cannot tell those apart —
   * a clone predating the first sync and an imposed id look identical — so it
   * offers the operation and leaves the judgement to whoever knows.
   *
   * What deliberately does *not* change:
   *
   * - **`syncId`.** Reidentifying is not leaving the group, and for the case
   *   this actually fixes both copies are replicas of one mesh. Clearing it
   *   would turn a repairable collision into a `foreign-mesh`.
   * - **Entries and log rows.** Their `peerId` records who changed what. That
   *   is history, and the log is immutable in any case.
   *
   * One visible consequence: every peer that has met this node holds a mark
   * keyed by the old id, so the next sync with each of them re-reads the whole
   * log instead of the tail since an offset. Once per peer, then the new mark
   * takes over.
   */
  async reidentify(): Promise<string> {
    const file = await this.store.read();
    const minted = randomId();
    file.peerId = minted;
    this.id = minted;
    await this.store.write(file);
    return minted;
  }

  /** True when this content should go through the streaming path. */
  private streams(size: number): boolean {
    return size >= this.streamThreshold && canStream(this.adapter);
  }

  // ------------------------------------------------------------- the mirror

  file(): Promise<VFSFile> {
    return this.store.read();
  }

  /** The tree as recorded — no disk access. See §6: paint from here, reconcile apart. */
  async entries(): Promise<VFSEntry[]> {
    return (await this.store.read()).entries;
  }

  /** Live entries only, tombstones dropped. */
  async live(): Promise<VFSEntry[]> {
    return (await this.entries()).filter((entry) => !entry.deleted);
  }

  /** Digest of the live entries — one comparison answers "anything to sync?". */
  async state(): Promise<Hash> {
    return (await this.store.read()).state;
  }

  /**
   * The ancestry this node can answer from without paying for an archive: the
   * entries themselves, the active log segment and its cumulative snapshot.
   */
  async history(): Promise<History> {
    const file = await this.store.read();
    return History.from([
      file.entries,
      await this.store.logRows(),
      await this.store.readSnapshot(file),
    ]);
  }

  /**
   * True when this node's policy keeps this entry's bytes on disk. No policy
   * means everything, which is the behaviour a node has always had.
   *
   * Public because `planChanges()` has to ask the destination node the same
   * question `apply()` asks itself, and the two must not answer differently.
   */
  wants(entry: VFSEntry): boolean {
    return this.policy ? this.policy(entry) : true;
  }

  /**
   * True when this path gets a three-way merge (§4): its extension is on the
   * store's list, or this node's own policy claims it.
   */
  async isText(path: string): Promise<boolean> {
    if (this.marksText(path)) return true;
    const extension = extensionOf(path);
    return extension !== '' && (await this.store.read()).text.includes(extension);
  }

  /**
   * True when this node's own `text` policy claims this path, whatever the
   * mesh-wide list says.
   *
   * Public and synchronous because `sync()` has to fold both nodes' answers into
   * the single predicate the merge takes, and the merge is pure — it cannot stop
   * and ask a node anything.
   */
  marksText(path: string): boolean {
    return this.textPolicy ? this.textPolicy(path) : false;
  }

  // ------------------------------------------------------ external changes

  /**
   * What has changed under this root since the last look, from the backend's
   * change feed — one request instead of a listing per folder.
   *
   * `null` means the backend has no feed, or its token expired, and the caller
   * has to fall back to a full walk (`commit()`). That fallback is not an error
   * path: it is the way this has always worked, and the feed is an optimisation
   * on top of it.
   *
   * Two filters make the answer usable. The feed is **account-wide** on the
   * backend that motivates it, so changes are attributed to entries by their
   * `native` id — which is what that field is for — and anything that cannot be
   * attributed is dropped until the next walk. And **our own writes come back in
   * the feed**, so a change whose size still matches what the mirror records is
   * discarded; without that, every write this node makes looks external.
   */
  async externalChanges(): Promise<string[] | null> {
    if (!this.adapter.changes) return null;
    const file = await this.store.read();
    const token = file.local.driveChangeToken;
    if (token === undefined) {
      const started = await this.adapter.changes(null);
      file.local.driveChangeToken = started.token;
      await this.store.write(file);
      return null; // no baseline yet — this walk is the baseline
    }

    const feed = await this.adapter.changes(token);
    file.local.driveChangeToken = feed.token;
    // The token is persisted when the cycle closes, not per page: on Drive every
    // write of `vfs.json` is a full re-upload.
    await this.store.write(file);
    if (feed.reset) return null;

    const byNative = new Map<string, VFSEntry>();
    const byPath = new Map<string, VFSEntry>();
    for (const entry of file.entries) {
      if (entry.deleted) continue;
      if (entry.native) byNative.set(entry.native, entry);
      byPath.set(entry.path, entry);
    }

    const out = new Set<string>();
    for (const change of feed.changes) {
      const known = byNative.get(change.native) ?? (change.path ? byPath.get(change.path) : undefined);
      const path = known?.path ?? change.path;
      if (!path) continue;
      if (this.excluded(path)) continue;
      if (path === CONTROL_DIR || path.startsWith(`${CONTROL_DIR}/`)) continue;
      // A change we cannot attribute is a file in a folder we have never
      // resolved: honestly out of reach until the next walk.
      if (!known && !change.path) continue;
      if (change.removed) {
        if (known) out.add(path);
        continue;
      }
      // Ours, echoed back: the mirror already describes exactly this.
      if (known && change.stat && change.stat.size === known.size && known.mtime === change.stat.mtime) {
        continue;
      }
      out.add(path);
    }
    return [...out].sort();
  }

  /**
   * Hybrid logical clock: never behind anything already in the store, so two
   * peers that have met once have their dates ordered against each other and a
   * lagging clock cannot "lose against the past".
   */
  private stamp(file: VFSFile): number {
    let highest = 0;
    for (const entry of file.entries) if (entry.updated > highest) highest = entry.updated;
    return Math.max(this.now(), highest + 1);
  }

  // ------------------------------------------------------- working folder

  read(path: string): Promise<Uint8Array> {
    return this.adapter.read(path);
  }

  write(path: string, data: Uint8Array): Promise<void> {
    return this.adapter.write(path, data);
  }

  stat(path: string): Promise<VFSStat | null> {
    return this.adapter.stat(path);
  }

  /** Creates an empty folder. v2 syncs those, which v1 could not. */
  async mkdir(path: string): Promise<void> {
    await this.adapter.mkdir?.(path);
  }

  /**
   * Reads `[start, end)` of a file without pulling in the rest — enough to
   * parse a header or a trailer out of a file far too big to load.
   *
   * ```ts
   * const header = await node.readRange('track.mp3', { end: 10 });   // ID3v2
   * const { size } = (await node.stat('track.mp3'))!;
   * const tail = await node.readRange('track.mp3', { start: size - 128 });
   * ```
   */
  readRange(path: string, range?: ByteRange): Promise<Uint8Array> {
    return readRange(this.adapter, path, range);
  }

  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    return readStream(this.adapter, path, range);
  }

  /**
   * Replaces a file from a stream, without ever holding it whole. `commit()`
   * afterwards to record it — the write itself does not.
   */
  writeStream(path: string): Promise<WritableStream<Uint8Array>> {
    return writeStream(this.adapter, path);
  }

  delete(path: string): Promise<void> {
    return this.adapter.delete(path);
  }

  /**
   * Renames through the node rather than the adapter so the intent is recorded.
   * The hash heuristic in `scan()` is only a fallback for renames that happened
   * outside the VFS (the user moving a file in Finder, say).
   */
  async rename(from: string, to: string): Promise<void> {
    await this.adapter.rename(from, to);
    const file = await this.store.read();
    const pending = file.local.pendingRenames ?? (file.local.pendingRenames = []);
    pending.push({ from, to });
    await this.store.write(file);
  }

  // ----------------------------------------------------------------- scan

  /**
   * The union of the three sources: the shared `.vfsignore`, this node's
   * `local.ignore`, and the constructor predicate. Ignored by any one of them,
   * ignored — no precedence to define, because without negation no two rules
   * can disagree.
   */
  private ignores(path: string): boolean {
    if (path === IGNORE_FILE) return false; // never excluded; see walk()
    if (matchIgnore(this.shared, path)) return true;
    if (matchIgnore(this.local, path)) return true;
    return this.ignore?.(path) ?? false;
  }

  /**
   * Whether the current rules keep this path out of the walk.
   *
   * The walk prunes at the directory and never descends, so a rule covering
   * `.cache` also excludes `.cache/x` even when the predicate says nothing
   * about the child. Testing the leaf alone would read those children as
   * vanished, which is the very thing this exists to prevent.
   */
  private excluded(path: string): boolean {
    if (this.ignores(path)) return true;
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      if (this.ignores(path.slice(0, cut))) return true;
    }
    return false;
  }

  /**
   * Refreshes the shared rules from what the walk just saw, and reports whether
   * they changed.
   *
   * `.vfsignore` is ordinary content, so reading it is an adapter call — on
   * Drive a round trip, on the one path built to avoid them. It is not read on
   * every scan: the walk already carries its `mtime` and `size`, which is the
   * same evidence the scan trusts to skip re-reading every other file, so it is
   * the cache key here too.
   *
   * **Not the recorded hash**, which was the obvious choice and is circular:
   * the hash lives in the entry, the entry does not exist until a scan has
   * produced it, so a hand-written `.vfsignore` could not take effect in the
   * pass it appeared in — and the file it was meant to exclude got tracked in
   * that pass instead. Phase 1 then preserves the tracked entry for good, so
   * the rule never excludes what it was written for.
   */
  private async refreshShared(walked: WalkedFile[]): Promise<boolean> {
    const seen = walked.find((item) => item.path === IGNORE_FILE);
    if (!seen) {
      const had = this.shared.length > 0;
      this.shared = [];
      this.sharedStamp = null;
      return had;
    }
    const stamp = `${seen.stat.mtime}:${seen.stat.size}`;
    if (stamp === this.sharedStamp) return false;
    this.sharedStamp = stamp;
    let text = '';
    try {
      text = decodeText(await this.adapter.read(IGNORE_FILE));
    } catch {
      // Recorded but not on disk: an entry this node never materialised, or a
      // file that went missing. Missing rules are no rules, not a failed scan.
      this.sharedStamp = null;
    }
    if (text === this.sharedText) return false; // touched, same content
    this.sharedText = text;
    this.shared = parseIgnore(text);
    return true;
  }


  /**
   * Replaces this node's local exclusion rules. They do not travel.
   *
   * Throws when the patterns would exclude `.vfsignore`. The engine never
   * excludes it in any case (see `walk()`), but here the caller is present and
   * can be told — which is the difference between this door and the one rules
   * arrive through from a peer.
   */
  async setLocalIgnore(patterns: string[]): Promise<void> {
    if (excludesRulesFile(patterns)) {
      throw new Error(`a rule may not exclude ${IGNORE_FILE}: the mesh needs it to converge`);
    }
    const file = await this.store.read();
    file.local.ignore = [...patterns];
    this.local = parseIgnore(patterns.join('\n'));
    await this.store.write(file);
  }

  /**
   * Reconciles the working folder into entries, and reports what changed as log
   * rows. Files whose `mtime`+`size` still match what was recorded are not
   * re-read — with catalogues of hundred-megabyte ROMs that filter stops being
   * an optimisation and becomes the difference between a sync and a full read.
   */
  async scan(): Promise<ScanResult> {
    const file = await this.store.read();
    const at = this.stamp(file);
    const batch = randomId();

    const prev = file.entries;
    const live = prev.filter((entry) => !entry.deleted);
    const byPath = new Map(live.map((entry) => [entry.path, entry]));
    const byNative = new Map(
      live.filter((entry) => entry.native).map((entry) => [entry.native as string, entry]),
    );

    this.local = parseIgnore((file.local.ignore ?? []).join('\n'));
    const listing = { directories: true, ignore: (path: string) => this.ignores(path) };
    // The walk prunes with the rules in hand, so an excluded subtree is never
    // listed. `.vfsignore` is exempt from exclusion, so it always comes back —
    // and if it has changed, the pass is redone under the new rules. That costs
    // a second walk only when the rules actually moved, and it is what lets a
    // rule take effect in the same pass it appears in.
    let walked = await walk(this.adapter, listing);
    if (await this.refreshShared(walked)) walked = await walk(this.adapter, listing);

    // 1. content hashes, through the mtime+size filter
    const seen: Array<{ path: string; stat: VFSStat; hash: Hash | null; prior?: VFSEntry }> = [];
    for (const item of walked) {
      const known = byPath.get(item.path);
      let hash: Hash | null = null;
      if (item.stat.kind === 'file') {
        if (known && known.mtime === item.stat.mtime && known.size === item.stat.size && known.hash) {
          hash = known.hash;
        } else if (this.streams(item.stat.size)) {
          hash = await sha256Stream(await readStream(this.adapter, item.path));
        } else {
          hash = await sha256(await this.adapter.read(item.path));
        }
      }
      seen.push({ path: item.path, stat: item.stat, hash });
    }

    // 2. what disappeared — the pool a move outside the VFS is matched against.
    //
    //    Absence from the walk is not by itself evidence of deletion. There are
    //    three reasons a path does not come back, and only the first is a
    //    delete: the user removed it, the current rule filters it, or this node
    //    never materialised the bytes. `mtime` separates them — it is deleted
    //    on every adopt and only ever re-set from a real `stat()`, so it means
    //    "this node has seen the file on disk", and it is absent exactly on the
    //    entries whose bytes deliberately never travelled.
    //
    //    Erring here is asymmetric: a missed deletion is picked up on the next
    //    pass, an invented one destroys the file on every other peer.
    const alive = new Set(seen.map((item) => item.path));
    const absent = live.filter((entry) => !alive.has(entry.path));
    const preserved = absent.filter((entry) => this.excluded(entry.path) || entry.mtime === undefined);
    const kept = new Set(preserved.map((entry) => entry.uuid));
    const vanished = absent.filter((entry) => !kept.has(entry.uuid));
    // Preserved entries stay out of the pool below on purpose: still in it, a
    // new file with the same content elsewhere would read as a move of one of
    // them and would carry the entry away from the path it is holding.
    const vanishedByHash = new Map<Hash, VFSEntry[]>();
    for (const entry of vanished) {
      if (!entry.hash) continue;
      const bucket = vanishedByHash.get(entry.hash);
      if (bucket) bucket.push(entry);
      else vanishedByHash.set(entry.hash, [entry]);
    }
    // Renames recorded through `node.rename()`, collapsed to where each file
    // *started*. A chain has to collapse: a swap goes a -> tmp -> b -> a, and
    // reading one hop at a time pins each identity to the wrong file.
    const origin = new Map<string, string>();
    for (const rename of file.local.pendingRenames ?? []) {
      const source = origin.get(rename.from) ?? rename.from;
      origin.delete(rename.from);
      if (source !== rename.to) origin.set(rename.to, source);
    }
    const movedAway = new Set(origin.values());

    const used = new Set<string>();
    const entries: VFSEntry[] = [];
    const rows: Array<Omit<LogRow, 'op'>> = [];

    for (const item of seen) {
      const native = this.adapter.fileId ? await this.adapter.fileId(item.path) : null;
      let prior: VFSEntry | undefined;
      if (native) prior = byNative.get(native);
      if (!prior) {
        // 1. A rename recorded through node.rename() is the strongest signal
        //    there is, so it outranks path continuity — in a swap (a -> b,
        //    b -> a) both paths still exist and the path would pin each
        //    identity to the wrong file.
        const from = origin.get(item.path);
        if (from) prior = byPath.get(from);
        // 2. Same path as last time, unless this path was itself renamed away:
        //    whatever sits here now would be a different file reusing the name.
        if (!prior && !movedAway.has(item.path)) prior = byPath.get(item.path);
        // 3. Same content under a path we no longer see: a move made outside
        //    the VFS, e.g. the user dragging the file in Finder.
        if (!prior && item.hash) prior = takeVanished(vanishedByHash, item.hash, used);
      }
      if (prior && used.has(prior.uuid)) prior = undefined;

      const uuid = prior?.uuid ?? randomId();
      used.add(uuid);

      const moved = prior !== undefined && prior.path !== item.path;
      const changed = prior === undefined || prior.hash !== item.hash || prior.kind !== item.stat.kind;

      const entry: VFSEntry = {
        uuid,
        kind: item.stat.kind,
        path: item.path,
        hash: item.hash,
        size: item.stat.kind === 'file' ? item.stat.size : 0,
        created: prior?.created ?? at,
        updated: changed || moved ? at : (prior?.updated ?? at),
        peerId: changed || moved ? this.peerId : (prior?.peerId ?? this.peerId),
        mtime: item.stat.mtime,
      };
      if (changed) entry.prev = prior?.hash ?? null;
      else if (prior?.prev !== undefined) entry.prev = prior.prev;
      if (!changed && prior?.prev2) entry.prev2 = prior.prev2;
      if (moved && prior) entry.prevPath = prior.path;
      else if (!moved && prior?.prevPath) entry.prevPath = prior.prevPath;
      if (native) entry.native = native;
      // A file the user edited by hand is no longer somebody's conflict copy.
      if (prior?.conflictOf && !changed) {
        entry.conflictOf = prior.conflictOf;
        if (prior.reason) entry.reason = prior.reason;
        if (prior.base) entry.base = prior.base;
        if (prior.held) entry.held = prior.held;
      }
      entries.push(entry);

      if (changed || moved) {
        rows.push({
          batch,
          at,
          peerId: this.peerId,
          uuid,
          type: changed ? 'write' : 'rename',
          kind: entry.kind,
          path: entry.path,
          hash: entry.hash,
          size: entry.size,
          ...(changed ? { prev: prior?.hash ?? null } : {}),
          ...(moved && prior ? { prevPath: prior.path } : {}),
        });
      }
    }

    // 3. entries the walk did not return and that are not deletions, carried
    //    over verbatim. Not `updated`, not `peer`: re-stamping would let an
    //    entry nobody touched win a tiebreak by date it has not won. Marking
    //    them `used` is what keeps the loop below from tombstoning them, and
    //    the claim above from handing their uuid to another file.
    //
    //    Preserving is not an operation, so it emits no log rows.
    for (const entry of preserved) {
      if (used.has(entry.uuid)) continue; // already claimed above as a rename
      used.add(entry.uuid);
      entries.push(entry);
    }

    // 4. tombstones for everything previously known that is neither live nor
    //    accounted for as a rename target
    for (const entry of prev) {
      if (used.has(entry.uuid)) continue;
      if (entry.deleted) {
        entries.push(entry); // history a fresh peer still has to learn
        continue;
      }
      entries.push({
        uuid: entry.uuid,
        kind: entry.kind,
        path: entry.path,
        hash: null,
        size: 0,
        created: entry.created,
        updated: at,
        peerId: this.peerId,
        deleted: true,
        prev: entry.hash,
      });
      rows.push({
        batch,
        at,
        peerId: this.peerId,
        uuid: entry.uuid,
        type: 'delete',
        kind: entry.kind,
        path: entry.path,
        hash: null,
        prev: entry.hash,
      });
    }

    return { entries, rows: await Promise.all(rows.map(makeRow)), batch };
  }

  /**
   * Scans, appends what changed to the log and writes `vfs.json`.
   *
   * Returns the batch id, or `null` when nothing moved — a quiet sync loop must
   * not grow the log.
   */
  async commit(): Promise<string | null> {
    const { entries, rows, batch } = await this.scan();
    const file = await this.store.read();
    const unchanged = rows.length === 0 && sameEntries(file.entries, entries);
    if (unchanged) {
      if (file.local.pendingRenames?.length) {
        file.local.pendingRenames = [];
        await this.store.write(file);
      }
      return null;
    }

    await this.keepText(entries, file);
    file.entries = entries;
    file.local.pendingRenames = [];
    file.local.verifiedAt = this.now();
    if (rows.length > 0) await this.store.append(rows, file);
    await this.settle(file);
    return batch;
  }

  /**
   * Keeps a copy of every text version this node records, under `base/<hash>`.
   *
   * A three-way merge needs base + A + B. A and B are free — the working file
   * *is* the content — and this is where the base comes from. It has to be
   * written when a version is *recorded*, not when it is about to be lost: by
   * the time a scan notices the user edited `gamelist.xml`, the previous bytes
   * are already gone.
   *
   * Local by construction: it never travels and no peer reads it. Missing a
   * base degrades the merge to LWW plus a copy, which costs nothing but a file.
   *
   * This is also why {@link VFSNodeOptions.text} is a node option rather than a
   * sync one: retention has to have happened here, versions ago, for a merge to
   * be possible at all later.
   */
  private async keepText(entries: VFSEntry[], file: VFSFile): Promise<void> {
    const text = file.text;
    if (text.length === 0 && !this.textPolicy) return;
    const before = new Map(file.entries.map((entry) => [entry.uuid, entry.hash]));
    const keep = new Set<Hash>();
    let wrote = 0;
    for (const entry of entries) {
      if (entry.deleted || entry.kind !== 'file' || !entry.hash) continue;
      const extension = extensionOf(entry.path);
      if (!(extension !== '' && text.includes(extension)) && !this.marksText(entry.path)) continue;
      keep.add(entry.hash);
      if (entry.prev) keep.add(entry.prev);
      if (entry.prev2) keep.add(entry.prev2);
      if (entry.size > MAX_TEXT_MERGE || before.get(entry.uuid) === entry.hash) continue;
      const data = await this.adapter.read(entry.path).catch(() => null);
      if (!data) continue;
      await this.store.putBase(entry.hash, data);
      wrote++;
    }
    // Retention only needs revisiting when something was added — listing
    // `base/` on every quiet commit would be a round trip for nothing.
    if (wrote > 0) await this.store.pruneBase(keep);
  }

  /**
   * Rotates when the segment has outgrown its budget, prunes what the rotation
   * has made safe to prune, then writes.
   *
   * The order is the invariant of §3 and §4: photograph first, prune after. The
   * cumulative snapshot holds the last known state of every uuid that has ever
   * existed, so a tombstone dropped from `vfs.json` afterwards can still be
   * proved to a peer that shows up with the file still alive.
   */
  private async settle(file: VFSFile): Promise<void> {
    if (await this.store.shouldRotate(file)) await this.store.rotate(file);
    file.entries = await this.pruneTombstones(file);
    await this.store.write(file);
  }

  /**
   * Drops tombstones every known peer has already seen, but only those the log
   * or the snapshot can still vouch for. What is dropped here is recoverable;
   * what is not is the difference between a delete and a resurrection.
   */
  private async pruneTombstones(file: VFSFile): Promise<VFSEntry[]> {
    const marks = Object.values(file.peers);
    if (marks.length === 0) return file.entries;
    const floor = Math.min(...marks.map((mark) => mark.lastSync));
    const provable = new Set<string>();
    for (const row of await this.store.logRows()) if (row.type === 'delete') provable.add(row.uuid);
    for (const entry of await this.store.readSnapshot(file)) {
      if (entry.deleted) provable.add(entry.uuid);
    }
    return file.entries.filter(
      (entry) => !entry.deleted || entry.updated >= floor || !provable.has(entry.uuid),
    );
  }

  // ---------------------------------------------------------------- apply

  /**
   * Makes the working folder match `target`, pulling whatever content is
   * missing from `source`.
   *
   * Everything that arrives is re-hashed against the hash `vfs.json` declares.
   * v1 got that for free — `putObjectStreamAt` verified on the way to the
   * content address — and dropping content addressing means paying for it
   * explicitly. Without it a truncated upload lands as "the newest version".
   */
  async apply(target: VFSEntry[], source: ContentSource): Promise<void> {
    const file = await this.store.read();
    const current = new Map(file.entries.map((entry) => [entry.uuid, entry]));
    const livePaths = new Set(file.entries.filter((e) => !e.deleted).map((e) => e.path));

    const renames: Array<{ from: string; to: string; uuid: string }> = [];
    const writes: VFSEntry[] = [];
    const mkdirs: VFSEntry[] = [];
    const deletes: Array<{ path: string; kind: string }> = [];

    for (const entry of target) {
      const before = current.get(entry.uuid);
      const wasLive = before && !before.deleted;
      if (entry.deleted) {
        if (wasLive) deletes.push({ path: before.path, kind: before.kind });
        continue;
      }
      // Content the far peer chose to keep to itself (§4): the entry travels,
      // the bytes do not, and the explorer paints it as remote.
      if (entry.held && entry.held !== this.peerId) continue;
      // Content this node's policy declines. The `materialised` half is not
      // optional: a policy that turns false for something already on disk must
      // not skip the write, or the file would sit at the old hash while the
      // tree records the new one — and `scan()`'s mtime filter, seeing an
      // untouched file, would never look at it again. Nothing would ever
      // disagree with itself about it. The predicate governs what arrives;
      // releasing what is already here is `dematerialize()`.
      if (!this.wants(entry) && !materialised(before)) continue;
      if (wasLive && before.path !== entry.path) {
        renames.push({ from: before.path, to: entry.path, uuid: entry.uuid });
      }
      if (entry.kind === 'directory') {
        if (!wasLive) mkdirs.push(entry);
        continue;
      }
      // `!materialised` is the refill: an entry this node wants but has no
      // bytes for is a write, even though nothing about it changed. Without it
      // the policy is only ever a filter — pinning a folder that nobody has
      // edited since would download nothing, and there would be two unrelated
      // ways to ask for the same content.
      if (!wasLive || before.hash !== entry.hash || !materialised(before)) writes.push(entry);
    }

    // Content this node already holds, from *before* anything moved. A conflict
    // copy is the peer's own current file, and a duplicate is a file that is
    // still sitting somewhere else — neither has to come over the wire.
    const local = new Map<Hash, { path: string; size: number }>();
    for (const entry of current.values()) {
      if (entry.deleted || entry.kind !== 'file' || !entry.hash || local.has(entry.hash)) continue;
      // An entry is not a file. One with no bytes behind it would send the copy
      // below reading a path that holds nothing — the same confusion `chain()`
      // had on the serving side, here on the receiving one.
      if (!materialised(entry)) continue;
      local.set(entry.hash, { path: entry.path, size: entry.size });
    }

    // Any of those paths that this apply is about to disturb has to be parked
    // first — otherwise the "copy" would be of whatever landed on top.
    const disturbed = new Set<string>([
      ...deletes.map((item) => item.path),
      ...renames.flatMap((item) => [item.from, item.to]),
      ...writes.map((entry) => entry.path),
    ]);
    const parkedContent = new Map<Hash, string>();
    for (const entry of writes) {
      const held = entry.hash ? local.get(entry.hash) : undefined;
      if (!held || !disturbed.has(held.path) || parkedContent.has(entry.hash as Hash)) continue;
      const temp = `${TEMP_DIR}/${entry.hash}`;
      await this.copy(held.path, temp, held.size);
      parkedContent.set(entry.hash as Hash, temp);
    }

    // Doomed files go first: a rename may be waiting for its destination to be
    // freed. Doomed *directories* wait until the renames have run — deleting
    // one while a file is still on its way out takes the file with it, and the
    // loss then travels as an ordinary delete. `roms` removed before
    // `roms/game.bin -> moved/0/game.bin` is exactly that.
    const doomedFiles = deletes.filter((item) => item.kind !== 'directory');
    const doomedDirs = deletes.filter((item) => item.kind === 'directory');
    for (const doomed of doomedFiles) {
      await this.adapter.delete(doomed.path);
      livePaths.delete(doomed.path);
    }

    // A rename whose destination is still occupied (a swap, a chain, or a
    // folder that is about to go) has to step through a scratch path first.
    const parked: Array<{ temp: string; to: string }> = [];
    for (const rename of renames) {
      if (!livePaths.has(rename.to)) continue;
      const temp = `${TEMP_DIR}/${rename.uuid}`;
      await this.adapter.rename(rename.from, temp);
      livePaths.delete(rename.from);
      parked.push({ temp, to: rename.to });
    }
    for (const rename of renames) {
      if (parked.some((item) => item.to === rename.to)) continue;
      await this.adapter.rename(rename.from, rename.to);
      livePaths.delete(rename.from);
      livePaths.add(rename.to);
    }

    // Deepest first, so a directory is only removed once it is empty — and now
    // that whatever was leaving it has left.
    doomedDirs.sort((x, y) => y.path.length - x.path.length);
    for (const doomed of doomedDirs) {
      await this.adapter.delete(doomed.path);
      livePaths.delete(doomed.path);
    }

    // Last, so a rename onto a path a delete had to free lands on empty ground.
    for (const item of parked) {
      await this.adapter.rename(item.temp, item.to);
      livePaths.add(item.to);
    }

    for (const entry of mkdirs) await this.adapter.mkdir?.(entry.path);

    for (const entry of writes) {
      const hash = entry.hash as Hash;
      const staged = parkedContent.get(hash) ?? local.get(hash)?.path;
      if (staged !== undefined && staged !== entry.path) {
        await this.copy(staged, entry.path, entry.size);
        continue;
      }
      await this.fetchContent(entry, source);
    }

    for (const temp of parkedContent.values()) await this.adapter.delete(temp).catch(() => undefined);
  }

  /**
   * Writes `entry`'s content from `source`, verified against the hash the tree
   * declares. False when no holder could serve it.
   *
   * One implementation, because `materialize()` needs exactly this and a second
   * copy is a second place for the two to drift on the check that matters.
   */
  private async fetchContent(entry: VFSEntry, source: ContentSource): Promise<boolean> {
    const hash = entry.hash as Hash;
    const handle = await source.open(hash, entry);
    if (!handle) return false;
    if (await this.copyNative(handle.origin, entry.path, entry.size)) return true;
    if (this.streams(handle.size)) {
      const hasher = new Sha256();
      await pump(await handle.stream(), await writeStream(this.adapter, entry.path), (chunk) =>
        hasher.update(chunk),
      );
      if (hasher.digest() !== hash) {
        await this.adapter.delete(entry.path);
        throw new Error(`${entry.path} arrived as ${hasher.digest()} in ${this.adapter.name}`);
      }
    } else {
      const data = await handle.read();
      const actual = await sha256(data);
      if (actual !== hash) throw new Error(`${entry.path} arrived as ${actual} in ${this.adapter.name}`);
      await this.adapter.write(entry.path, data);
    }
    return true;
  }

  /**
   * Lets the backend copy its own object, when the bytes are already inside it.
   * False means it did not happen and the caller must pump — which is always
   * correct, only slower.
   *
   * `origin` is the holder's promise that the source file still matches what
   * the tree recorded ({@link ContentHandle.origin}); this adds the other half,
   * that the size which landed is the size expected. Together they are what
   * stands in for the hash check the fast path skips: a copy that disagrees is
   * deleted and pumped instead, and the pump then re-hashes and throws exactly
   * as it does today.
   */
  private async copyNative(
    origin: ContentHandle['origin'],
    to: string,
    size: number,
  ): Promise<boolean> {
    if (!origin) return false;
    const source = origin.adapter;
    if (!this.adapter.copyFrom || !this.adapter.backendId || !source.backendId) return false;
    const [mine, theirs] = await Promise.all([this.adapter.backendId(), source.backendId()]);
    if (mine === null || mine !== theirs) return false;
    const written = await this.adapter.copyFrom(source, origin.path, to);
    if (written === null) return false;
    if (written !== size) {
      await this.adapter.delete(to).catch(() => undefined);
      return false;
    }
    return true;
  }

  /**
   * Copies within this node's own folder, staging a conflict copy.
   *
   * Intra-adapter by construction, so it asks no identity question — and it
   * gives up no verification either, because it never did any: the fast path
   * here is strictly more checked than the pump it replaces.
   */
  private async copy(from: string, to: string, size: number): Promise<void> {
    const written = await this.adapter.copyFrom?.(this.adapter, from, to);
    if (written !== null && written !== undefined) {
      if (written === size) return;
      await this.adapter.delete(to).catch(() => undefined);
    }
    if (this.streams(size)) {
      await pump(await readStream(this.adapter, from), await writeStream(this.adapter, to));
      return;
    }
    await this.adapter.write(to, await this.adapter.read(from));
  }

  /**
   * Adopts `target` as the recorded tree, re-stamping the two per-node fields —
   * the backend id and the disk `mtime` the fast filter compares against.
   */
  async adopt(target: VFSEntry[], file?: VFSFile): Promise<VFSFile> {
    const held = file ?? (await this.store.read());
    const current = new Map(held.entries.map((entry) => [entry.uuid, entry]));
    const entries: VFSEntry[] = [];
    for (const entry of target) {
      const next: VFSEntry = { ...entry };
      delete next.native;
      delete next.mtime;
      const before = current.get(entry.uuid);
      // Whether this node has the file on disk once the apply is done, which is
      // the same question `apply()` asked: the policy decides what arrives, and
      // bytes already here are kept current whatever it says.
      const onDisk =
        !(entry.held && entry.held !== this.peerId) && (this.wants(entry) || materialised(before));
      // Nothing this apply touched: the two node-local fields still describe
      // the file on disk, so carry them over. On Drive re-statting an untouched
      // entry is a round trip per file, which for a catalogue is the whole cost
      // — and an entry with no bytes here is exactly the one not to pay it for.
      if (
        before &&
        !entry.deleted &&
        before.path === entry.path &&
        before.hash === entry.hash &&
        materialised(before)
      ) {
        if (before.mtime !== undefined) next.mtime = before.mtime;
        if (before.native) next.native = before.native;
      } else if (!entry.deleted && onDisk) {
        const stat = await this.adapter.stat(entry.path);
        if (stat) next.mtime = stat.mtime;
        if (this.adapter.fileId) {
          const native = await this.adapter.fileId(entry.path);
          if (native) next.native = native;
        }
      }
      entries.push(next);
    }
    await this.keepText(entries, held);
    held.entries = entries;
    held.local.verifiedAt = this.now();
    return held;
  }

  // ------------------------------------------------------ materialisation

  /** The live file entry at `path`, or an error naming what is wrong with it. */
  private async fileEntry(path: string): Promise<{ file: VFSFile; entry: VFSEntry }> {
    const file = await this.store.read();
    const entry = file.entries.find((item) => !item.deleted && item.path === path);
    if (!entry) throw new Error(`no live entry at ${path}`);
    if (entry.kind !== 'file' || !entry.hash) throw new Error(`${path} is not a file`);
    return { file, entry };
  }

  /**
   * Fetches the bytes for a path this node has the entry for but not the
   * content — declined by its own policy, or kept by the peer that made it (§4).
   *
   * Verified against the declared hash, exactly as a sync would be. Once the
   * bytes are on disk the entry is ordinary again, and the `mtime` stamped here
   * is what makes it so: reconciliation stops treating it as content that was
   * never here.
   *
   * It fetches *against* the policy, not through it — the caller is overriding
   * a standing decision. A policy that still declines the entry leaves it alone
   * from here on; one that wants it would have fetched it on the next sync.
   */
  async materialize(path: string, from: VFSNode): Promise<void> {
    const { file, entry } = await this.fileEntry(path);
    const available = await from.live();
    const source: ContentSource = { open: (hash) => holds(from, available, hash) };
    if (!(await this.fetchContent(entry, source))) {
      throw new Error(`${from.name} cannot serve ${path}`);
    }
    // Stamped here rather than through `commit()`: the bytes match the hash the
    // entry already declares, so a walk would emit no row and would cost the
    // full listing the mtime filter exists to avoid.
    const stat = await this.adapter.stat(path);
    if (stat) entry.mtime = stat.mtime;
    if (this.adapter.fileId) {
      const native = await this.adapter.fileId(path);
      if (native) entry.native = native;
    }
    await this.store.write(file);
  }

  /**
   * Releases the bytes for a path and keeps the entry. Nothing about it travels
   * and no log row is written: which content a node stores is a local storage
   * decision, not an operation on the mesh. `state` does not change either —
   * `mtime` is outside the digest.
   *
   * `from` has to be able to serve the content first. Dematerialising the last
   * copy would leave the entry live across the mesh with the bytes nowhere, and
   * the library cannot see that on its own, because nothing about
   * materialisation travels. It is a sanity check and not a guarantee — the
   * peer could lose the bytes a moment later — but the case it catches is the
   * realistic one. If no peer holds it, what is wanted is a deletion, and a
   * deletion says so with a tombstone.
   *
   * **The order of the two writes is not a preference.** The record that this
   * node no longer holds the bytes lands *before* the bytes go. Interrupted the
   * other way round, the next `scan()` would find the file gone with an `mtime`
   * still saying it had been seen here, and would tombstone it on every peer —
   * the deletion-by-inference this engine exists to not do. Interrupted this
   * way it heals: the scan finds the file, the hash is unchanged, and it
   * re-stamps the `mtime` with no row and no re-dating.
   */
  async dematerialize(path: string, from: VFSNode): Promise<void> {
    const { file, entry } = await this.fileEntry(path);
    const available = await from.live();
    if (!(await holds(from, available, entry.hash as Hash))) {
      throw new Error(`${from.name} cannot serve ${path}: releasing it here would leave no copy`);
    }
    if (materialised(entry)) {
      delete entry.mtime;
      delete entry.native;
      await this.store.write(file);
    }
    await this.adapter.delete(path).catch(() => undefined);
  }

  // ------------------------------------------------------------ conflicts

  /**
   * Conflicts waiting for a person. No network and no sync: the pending state
   * *is* the conflict copy, which is an ordinary entry in the file that is read
   * anyway, so "are there conflicts?" is "any entry with `conflictOf`?".
   */
  async conflicts(): Promise<PendingConflict[]> {
    const entries = await this.entries();
    const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
    const out: PendingConflict[] = [];
    for (const entry of entries) {
      if (!entry.conflictOf || entry.deleted) continue;
      const disputed = byUuid.get(entry.conflictOf);
      out.push({
        uuid: entry.uuid,
        of: entry.conflictOf,
        reason: entry.reason ?? 'binary',
        path: disputed?.path ?? entry.path,
        copyPath: entry.path,
        peerId: entry.peerId,
        ...(entry.held ? { held: entry.held } : {}),
        ...(entry.base ? { base: entry.base } : {}),
        mine: {
          hash: disputed?.hash ?? null,
          size: disputed?.size ?? 0,
          updated: disputed?.updated ?? 0,
        },
        theirs: { hash: entry.hash, size: entry.size, updated: entry.updated },
      });
    }
    return out;
  }

  /**
   * Settles one pending conflict: writes the winner and deletes the copy, in a
   * single batch. Two operations the engine already knows how to do, so the
   * resolution propagates like any other write — and two people resolving the
   * same thing on different peers is an ordinary write conflict, decided by the
   * ordinary rules. There is no state machine.
   */
  async resolve(uuid: string, choice: 'mine' | 'theirs' | Uint8Array): Promise<void> {
    const file = await this.store.read();
    const copy = file.entries.find((entry) => entry.uuid === uuid && entry.conflictOf);
    if (!copy) throw new Error(`no pending conflict ${uuid}`);
    const disputed = file.entries.find((entry) => entry.uuid === copy.conflictOf);

    // Whether the bytes of the losing version are actually here. Two ways they
    // are not: the copy was too big to travel (§4) and stayed on the peer that
    // made it, or this node's policy declined to materialise it.
    const here = materialised(copy);
    if (choice === 'theirs' && !here) {
      // Say so, rather than failing on a read of a file that was never going to
      // be here.
      const why = copy.held && copy.held !== this.peerId ? `held on ${copy.held}` : 'not materialised here';
      throw new Error(`the losing version of ${copy.path} is ${why}`);
    }
    if (choice !== 'mine' && disputed) {
      const data = choice instanceof Uint8Array ? choice : await this.adapter.read(copy.path);
      await this.adapter.write(disputed.path, data);
    }
    await this.adapter.delete(copy.path).catch(() => undefined);
    // A copy whose bytes are not here has no file to remove, and the scan reads
    // absence as evidence only for content this node actually held. Deleting it
    // therefore has to be said, not shown — otherwise the copy is immortal:
    // nothing on disk to remove, and nothing for reconciliation to notice.
    if (!here) await this.retire(copy.uuid);
    await this.commit();
  }

  /**
   * Tombstones an entry outright, for the deletions `scan()` cannot see: an
   * entry with no file behind it looks the same before and after.
   */
  private async retire(uuid: string): Promise<void> {
    const file = await this.store.read();
    const doomed = file.entries.find((entry) => entry.uuid === uuid);
    if (!doomed || doomed.deleted) return;
    const at = this.stamp(file);
    file.entries = file.entries.map((entry) =>
      entry.uuid === uuid
        ? {
            uuid,
            kind: doomed.kind,
            path: doomed.path,
            hash: null,
            size: 0,
            created: doomed.created,
            updated: at,
            peerId: this.peerId,
            deleted: true,
            prev: doomed.hash,
          }
        : entry,
    );
    const row = await makeRow({
      batch: randomId(),
      at,
      peerId: this.peerId,
      uuid,
      type: 'delete',
      kind: doomed.kind,
      path: doomed.path,
      hash: null,
      prev: doomed.hash,
    });
    await this.store.append([row], file);
    await this.settle(file);
  }

  async baseOf(hash: Hash): Promise<Uint8Array | null> {
    return this.store.getBase(hash);
  }
}

function takeVanished(
  byHash: Map<Hash, VFSEntry[]>,
  hash: Hash,
  used: Set<string>,
): VFSEntry | undefined {
  const bucket = byHash.get(hash);
  if (!bucket) return undefined;
  while (bucket.length > 0) {
    const candidate = bucket.shift() as VFSEntry;
    if (!used.has(candidate.uuid)) return candidate;
  }
  return undefined;
}

/** Cheap equality over what a commit would actually change. */
function sameEntries(left: VFSEntry[], right: VFSEntry[]): boolean {
  if (left.length !== right.length) return false;
  const byUuid = new Map(left.map((entry) => [entry.uuid, entry]));
  return right.every((entry) => {
    const held = byUuid.get(entry.uuid);
    return (
      held !== undefined &&
      held.path === entry.path &&
      held.hash === entry.hash &&
      held.size === entry.size &&
      !!held.deleted === !!entry.deleted &&
      // Not the `mtime` value — a touched file with the same content is not a
      // change worth a write. Whether there is an `mtime` at all is: it is the
      // record of whether this node holds the bytes, and losing that record
      // makes reconciliation read the file as content that was never here.
      materialised(held) === materialised(entry)
    );
  });
}
