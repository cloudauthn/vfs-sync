import { MAX_TEXT_MERGE } from './diff3.js';
import { randomId, sha256, sha256Stream } from './hash.js';
import { History } from './history.js';
import { makeRow } from './log.js';
import { Sha256 } from './sha256.js';
import { CONTROL_DIR, VFSStore } from './store.js';
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

export interface VFSNodeOptions {
  /** Stable peer id. Generated and persisted in `.vfs/vfs.json` if omitted. */
  id?: string;
  /** Return true to keep a path out of sync entirely. */
  ignore?: (path: string) => boolean;
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
}

/** Where `apply()` gets content it does not already have on disk. */
export interface ContentSource {
  open(hash: Hash, entry: VFSEntry): Promise<ContentHandle | null>;
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
  readonly id: string;
  /** Size from which content takes the streaming path. See {@link VFSNodeOptions}. */
  readonly streamThreshold: number;

  private readonly ignore: ((path: string) => boolean) | undefined;
  private readonly now: () => number;

  private constructor(adapter: VFSAdapter, id: string, options: VFSNodeOptions, store: VFSStore) {
    this.adapter = adapter;
    this.store = store;
    this.id = id;
    this.ignore = options.ignore;
    this.now = options.now ?? (() => Date.now());
    this.streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  }

  /** Opens (creating `.vfs/` if needed) the folder behind `adapter`. */
  static async open(adapter: VFSAdapter, options: VFSNodeOptions = {}): Promise<VFSNode> {
    const storeOptions: VFSStoreOptions = { ...(options.now ? { now: options.now } : {}) };
    if (options.rotateAt !== undefined) storeOptions.rotateAt = options.rotateAt;
    const store = new VFSStore(adapter, CONTROL_DIR, storeOptions);
    const file = await store.init(options.id ? { peer: options.id } : {});
    if (options.id && file.peer !== options.id) {
      file.peer = options.id;
      await store.write(file);
    }
    return new VFSNode(adapter, file.peer, options, store);
  }

  get name(): string {
    return this.adapter.name;
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

  /** True when this path's extension is on the store's text list (§4). */
  async isText(path: string): Promise<boolean> {
    const extension = extensionOf(path);
    return extension !== '' && (await this.store.read()).text.includes(extension);
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
      if (this.ignore?.(path)) continue;
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

    const walked = await walk(this.adapter, {
      directories: true,
      ...(this.ignore ? { ignore: this.ignore } : {}),
    });

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

    // 2. what disappeared — the pool a move outside the VFS is matched against
    const alive = new Set(seen.map((item) => item.path));
    const vanished = live.filter((entry) => !alive.has(entry.path));
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
        peer: changed || moved ? this.id : (prior?.peer ?? this.id),
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
          peer: this.id,
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

    // 3. tombstones for everything previously known that is neither live nor
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
        peer: this.id,
        deleted: true,
        prev: entry.hash,
      });
      rows.push({
        batch,
        at,
        peer: this.id,
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
   */
  private async keepText(entries: VFSEntry[], file: VFSFile): Promise<void> {
    const text = file.text;
    if (text.length === 0) return;
    const before = new Map(file.entries.map((entry) => [entry.uuid, entry.hash]));
    const keep = new Set<Hash>();
    let wrote = 0;
    for (const entry of entries) {
      if (entry.deleted || entry.kind !== 'file' || !entry.hash) continue;
      const extension = extensionOf(entry.path);
      if (extension === '' || !text.includes(extension)) continue;
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
      if (entry.held && entry.held !== this.id) continue;
      if (wasLive && before.path !== entry.path) {
        renames.push({ from: before.path, to: entry.path, uuid: entry.uuid });
      }
      if (entry.kind === 'directory') {
        if (!wasLive) mkdirs.push(entry);
        continue;
      }
      if (!wasLive || before.hash !== entry.hash) writes.push(entry);
    }

    // Content this node already holds, from *before* anything moved. A conflict
    // copy is the peer's own current file, and a duplicate is a file that is
    // still sitting somewhere else — neither has to come over the wire.
    const local = new Map<Hash, { path: string; size: number }>();
    for (const entry of current.values()) {
      if (entry.deleted || entry.kind !== 'file' || !entry.hash || local.has(entry.hash)) continue;
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

    // Deepest first, so a directory is only removed once it is empty.
    deletes.sort((x, y) => y.path.length - x.path.length);
    for (const doomed of deletes) {
      await this.adapter.delete(doomed.path);
      livePaths.delete(doomed.path);
    }

    // A rename whose destination is still occupied (a swap, or a chain) has to
    // step through a scratch path first.
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
      const handle = await source.open(hash, entry);
      if (!handle) continue;
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
    }

    for (const temp of parkedContent.values()) await this.adapter.delete(temp).catch(() => undefined);
  }

  private async copy(from: string, to: string, size: number): Promise<void> {
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
      // Nothing this apply touched: the two node-local fields still describe
      // the file on disk, so carry them over. On Drive re-statting an untouched
      // entry is a round trip per file, which for a catalogue is the whole cost.
      if (before && !entry.deleted && before.path === entry.path && before.hash === entry.hash) {
        if (before.mtime !== undefined) next.mtime = before.mtime;
        if (before.native) next.native = before.native;
      } else if (!entry.deleted && !(entry.held && entry.held !== this.id)) {
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

  /** Content this node can hand to a peer, keyed by hash. */
  async handle(hash: Hash): Promise<ContentHandle | null> {
    const entry = (await this.live()).find((item) => item.hash === hash && item.kind === 'file');
    if (!entry) return null;
    const stat = await this.adapter.stat(entry.path);
    if (!stat) return null;
    const path = entry.path;
    return {
      size: stat.size,
      read: () => this.adapter.read(path),
      stream: () => readStream(this.adapter, path),
    };
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
        peer: entry.peer,
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

    if (choice === 'theirs' && copy.held && copy.held !== this.id) {
      // The copy was too big to travel (§4), so its bytes are still on the peer
      // that made it. Say so, rather than failing on a read of a file that was
      // never going to be here.
      throw new Error(`the losing version of ${copy.path} is held on ${copy.held}`);
    }
    if (choice !== 'mine' && disputed) {
      const data = choice instanceof Uint8Array ? choice : await this.adapter.read(copy.path);
      await this.adapter.write(disputed.path, data);
    }
    await this.adapter.delete(copy.path).catch(() => undefined);
    await this.commit();
  }

  /**
   * Keeps the previous content of a text entry, so a later three-way merge has
   * a base. Local only — it never travels and no peer reads it.
   */
  async keepBase(hash: Hash, data: Uint8Array): Promise<void> {
    await this.store.putBase(hash, data);
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
      !!held.deleted === !!entry.deleted
    );
  });
}
