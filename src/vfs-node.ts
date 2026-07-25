import { randomId, sha256, sha256Stream } from './hash.js';
import { EMPTY_TREE, VFSStore, canonicalTree } from './store.js';
import {
  STREAM_THRESHOLD,
  canStream,
  pump,
  readRange,
  readStream,
  writeStream,
} from './stream.js';
import type { ByteRange, CachedFile, Commit, Hash, Tree, TreeEntry, VFSAdapter, VFSStat } from './types.js';
import { walk } from './walk.js';

export interface VFSNodeOptions {
  /** Stable peer id. Generated and persisted in `.vfs/config.json` if omitted. */
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
  /**
   * Use the working folder as the blob store instead of duplicating every
   * file's bytes under `.vfs/objects/`. Worth it on a backend where each object
   * is a network write (Google Drive); leave off for local backends where the
   * extra copy is cheap and the plain layout is simplest. See
   * {@link VFSStoreOptions.reconstruct}.
   */
  reconstructBlobs?: boolean;
}

export interface CommitOptions {
  parents?: Hash[];
  timestamp?: number;
  /** Commit even when the tree is identical to HEAD's. */
  force?: boolean;
}

const TEMP_DIR = '.vfs/tmp';

/**
 * One participant in the mesh: an adapter (the working folder) plus its `.vfs`
 * control folder. A node only ever knows the peers it syncs with directly.
 */
export class VFSNode {
  readonly adapter: VFSAdapter;
  readonly store: VFSStore;
  readonly id: string;
  /** Size from which blobs take the streaming path. See {@link VFSNodeOptions}. */
  readonly streamThreshold: number;

  private readonly ignore: ((path: string) => boolean) | undefined;
  private readonly now: () => number;

  private constructor(adapter: VFSAdapter, id: string, options: VFSNodeOptions) {
    this.adapter = adapter;
    this.store = new VFSStore(adapter, undefined, { reconstruct: options.reconstructBlobs ?? false });
    this.id = id;
    this.ignore = options.ignore;
    this.now = options.now ?? (() => Date.now());
    this.streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  }

  /** True when this file should go through the streaming path. */
  private streams(size: number): boolean {
    return size >= this.streamThreshold && canStream(this.adapter);
  }

  /** Opens (creating `.vfs/` if needed) the folder behind `adapter`. */
  static async open(adapter: VFSAdapter, options: VFSNodeOptions = {}): Promise<VFSNode> {
    const store = new VFSStore(adapter);
    const config = await store.init(options.id);
    const node = new VFSNode(adapter, config.id, options);
    return node;
  }

  get name(): string {
    return this.adapter.name;
  }

  head(): Promise<Hash | null> {
    return this.store.head();
  }

  async headTree(): Promise<Tree> {
    const head = await this.store.head();
    if (!head) return EMPTY_TREE;
    const commit = await this.store.getCommit(head);
    return this.store.getTree(commit.tree);
  }

  /** Commit history from HEAD, newest first, following first parents. */
  async log(limit = 50): Promise<Array<Commit & { hash: Hash }>> {
    const out: Array<Commit & { hash: Hash }> = [];
    let hash = await this.store.head();
    while (hash && out.length < limit) {
      const commit = await this.store.getCommit(hash);
      out.push({ ...commit, hash });
      hash = commit.parents[0] ?? null;
    }
    return out;
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

  /**
   * Reads `[start, end)` of a file without pulling in the rest — enough to
   * parse a header or a trailer out of a file far too big to load.
   *
   * ```ts
   * const header = await node.readRange('track.mp3', { end: 10 });   // ID3v2
   * const { size } = (await node.stat('track.mp3'))!;
   * const tail = await node.readRange('track.mp3', { start: size - 128 });
   * ```
   *
   * Backends that cannot seek fall back to reading the file and slicing, so
   * this is always correct, just not always cheap.
   */
  readRange(path: string, range?: ByteRange): Promise<Uint8Array> {
    return readRange(this.adapter, path, range);
  }

  /** Streams a file, or a range of it, out of the working folder. */
  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    return readStream(this.adapter, path, range);
  }

  /**
   * Replaces a file from a stream, without ever holding it whole. `commit()`
   * afterwards to snapshot it — the write itself does not.
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
    const cache = await this.store.hashCache();
    cache.renames.push({ from, to });
    const cached = cache.files[from];
    if (cached) {
      cache.files[to] = cached;
      delete cache.files[from];
    }
    await this.store.writeHashCache(cache);
  }

  // ----------------------------------------------------------------- scan

  /**
   * Snapshots the working folder into a tree. Files whose `mtime`+`size` still
   * match the hash cache are not re-read; everything else is hashed and stored
   * as a blob.
   */
  async scan(): Promise<Tree> {
    const prev = await this.headTree();
    const prevById = new Map(prev.entries.map((e) => [e.id, e]));
    const prevLive = prev.entries.filter((e) => !e.deleted);
    const prevByPath = new Map(prevLive.map((e) => [e.path, e]));

    const cache = await this.store.hashCache();
    const files = await walk(this.adapter, this.ignore ? { ignore: this.ignore } : {});
    const now = this.now();

    // 1. resolve content hashes, using the mtime+size fast filter
    const resolved: Array<{ path: string; size: number; mtime: number; hash: Hash }> = [];
    for (const file of files) {
      const cached = cache.files[file.path];
      const streaming = this.streams(file.stat.size);
      let hash: Hash;
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        hash = cached.hash;
        if (!this.store.reconstruct && !(await this.store.hasObject(hash))) {
          if (streaming) {
            await this.store.putObjectStreamAt(hash, await readStream(this.adapter, file.path));
          } else {
            await this.store.putObjectAt(hash, await this.adapter.read(file.path));
          }
        }
      } else if (this.store.reconstruct) {
        // The working file is the blob, so hash it in place — no copy into objects/.
        hash = streaming
          ? await sha256Stream(await readStream(this.adapter, file.path))
          : await sha256(await this.adapter.read(file.path));
      } else if (streaming) {
        hash = await this.store.putObjectStream(() => readStream(this.adapter, file.path));
      } else {
        const data = await this.adapter.read(file.path);
        hash = await sha256(data);
        await this.store.putObjectAt(hash, data);
      }
      resolved.push({ path: file.path, size: file.stat.size, mtime: file.stat.mtime, hash });
    }

    // 2. work out which previously known files disappeared — rename candidates
    const livePaths = new Set(resolved.map((r) => r.path));
    const vanished = prevLive.filter((e) => !livePaths.has(e.path));
    const vanishedByHash = new Map<Hash, TreeEntry[]>();
    for (const entry of vanished) {
      if (!entry.hash) continue;
      const bucket = vanishedByHash.get(entry.hash);
      if (bucket) bucket.push(entry);
      else vanishedByHash.set(entry.hash, [entry]);
    }
    const pendingByTarget = new Map(cache.renames.map((r) => [r.to, r]));
    const renamedAway = new Set(cache.renames.map((r) => r.from));

    const usedIds = new Set<string>();
    const entries: TreeEntry[] = [];

    for (const file of resolved) {
      let source: TreeEntry | undefined;
      let id: string | undefined;

      const native = this.adapter.fileId ? await this.adapter.fileId(file.path) : null;
      if (native) {
        id = native;
        source = prevById.get(native);
      } else {
        // 1. A rename recorded through node.rename() is the strongest signal
        //    we have, so it outranks path continuity. It has to: in a swap
        //    (a -> b, b -> a) both paths still exist, and trusting the path
        //    would pin each identity to the wrong file.
        const pending = pendingByTarget.get(file.path);
        if (pending) source = prevByPath.get(pending.from);
        // 2. Same path as last time — the common case. Skipped when this path
        //    was itself renamed away, because then whatever sits here now is a
        //    different file that merely reused the name.
        if (!source && !renamedAway.has(file.path)) source = prevByPath.get(file.path);
        // 3. Same content under a path we no longer see: a move made outside
        //    the VFS, e.g. the user dragging the file in Finder.
        if (!source) source = takeVanished(vanishedByHash, file.hash, usedIds);
        // 4. Discovered but not yet committed: the id is already in the cache,
        //    so scanning twice does not mint a second identity.
        id = source?.id ?? cache.files[file.path]?.id;
        if (!source && id) source = prevById.get(id);
      }
      // Two files must never claim one identity; the loser starts a new one.
      if (id && usedIds.has(id)) {
        id = undefined;
        source = undefined;
      }
      id ??= randomId();
      usedIds.add(id);

      const prior = source; // const so the checks below narrow it
      const renamed = prior && !prior.deleted && prior.path !== file.path;
      const unchanged = prior && !prior.deleted && prior.hash === file.hash;

      // Logical mtime only moves when something actually happened: content
      // change -> the filesystem mtime, rename -> now, otherwise carry the
      // previous value so a peer's edit time survives the trip. Authorship
      // travels the same way.
      const mtime = unchanged ? (renamed ? now : prior.mtime) : file.mtime;
      const peer = unchanged ? (prior.peer ?? this.id) : this.id;

      const entry: TreeEntry = {
        id,
        path: file.path,
        hash: file.hash,
        size: file.size,
        mtime,
        peer,
      };
      if (renamed && source) entry.renamedFrom = source.path;
      entries.push(entry);
    }

    // 3. tombstones: everything previously known that is neither live nor
    //    already accounted for as a rename target
    for (const entry of prev.entries) {
      if (usedIds.has(entry.id)) continue;
      if (entry.deleted) {
        entries.push(entry); // keep history: a fresh peer must learn about it
        continue;
      }
      entries.push({
        id: entry.id,
        path: entry.path,
        hash: null,
        size: 0,
        mtime: now,
        deleted: true,
        peer: this.id,
      });
    }

    const live = new Map(entries.filter((e) => !e.deleted).map((e) => [e.path, e]));
    const nextFiles: Record<string, CachedFile> = {};
    for (const file of resolved) {
      nextFiles[file.path] = {
        hash: file.hash,
        mtime: file.mtime,
        size: file.size,
        ...(live.get(file.path) ? { id: (live.get(file.path) as TreeEntry).id } : {}),
      };
    }
    cache.files = nextFiles;
    cache.renames = [];
    await this.store.writeHashCache(cache);

    return canonicalTree({ entries });
  }

  /**
   * Scans and records a commit. Returns `null` when the tree is unchanged, so
   * a quiet sync loop does not grow the history.
   */
  async commit(options: CommitOptions = {}): Promise<Hash | null> {
    const tree = await this.scan();
    const treeHash = await this.store.putTree(tree);
    const head = await this.store.head();

    if (!options.force && !options.parents) {
      if (head) {
        const current = await this.store.getCommit(head);
        if (current.tree === treeHash) return null;
      } else if (tree.entries.length === 0) {
        // An empty folder that has never been committed has no history to
        // record; a root commit here would only be noise for peers to merge.
        return null;
      }
    }

    const commit: Commit = {
      tree: treeHash,
      parents: options.parents ?? (head ? [head] : []),
      timestamp: options.timestamp ?? this.now(),
      peer: this.id,
    };
    const hash = await this.store.putCommit(commit);
    await this.store.setHead(hash);
    return hash;
  }

  // ---------------------------------------------------------------- apply

  /**
   * Makes the working folder match `target`. Every blob referenced by `target`
   * must already be in this node's object store — `sync()` transfers them
   * first.
   */
  async applyTree(target: Tree): Promise<void> {
    const current = await this.headTree();
    const currentById = new Map(current.entries.map((e) => [e.id, e]));
    const livePaths = new Set(current.entries.filter((e) => !e.deleted).map((e) => e.path));

    const renames: Array<{ from: string; to: string; id: string }> = [];
    const writes: Array<{ path: string; hash: Hash; size: number }> = [];
    const deletes: string[] = [];

    for (const entry of target.entries) {
      const before = currentById.get(entry.id);
      const wasLive = before && !before.deleted;

      if (entry.deleted) {
        if (wasLive) deletes.push(before.path);
        continue;
      }
      if (wasLive && before.path !== entry.path) {
        renames.push({ from: before.path, to: entry.path, id: entry.id });
      }
      if (!wasLive || before.hash !== entry.hash) {
        writes.push({ path: entry.path, hash: entry.hash as Hash, size: entry.size });
      }
    }

    // In reconstruct mode a blob about to be written may only exist as a working
    // file that this apply is about to overwrite (a conflict loser is the peer's
    // own current content). Pin those before touching anything, so the write
    // phase can still read them.
    if (this.store.reconstruct) {
      for (const write of writes) {
        if (await this.store.hasStoredObject(write.hash)) continue;
        if (this.streams(write.size)) {
          await this.store.materializeStream(write.hash, await this.store.getObjectStream(write.hash));
        } else {
          await this.store.materialize(write.hash, await this.store.getObject(write.hash));
        }
      }
    }

    for (const path of deletes) {
      await this.adapter.delete(path);
      livePaths.delete(path);
    }

    // A rename whose destination is still occupied (a swap, or a chain) has to
    // step through a scratch path first.
    const parked: Array<{ temp: string; to: string }> = [];
    for (const rename of renames) {
      if (livePaths.has(rename.to)) {
        const temp = `${TEMP_DIR}/${rename.id}`;
        await this.adapter.rename(rename.from, temp);
        livePaths.delete(rename.from);
        parked.push({ temp, to: rename.to });
      }
    }
    for (const rename of renames) {
      if (parked.some((p) => p.to === rename.to)) continue;
      await this.adapter.rename(rename.from, rename.to);
      livePaths.delete(rename.from);
      livePaths.add(rename.to);
    }
    for (const park of parked) {
      await this.adapter.rename(park.temp, park.to);
      livePaths.add(park.to);
    }

    for (const write of writes) {
      if (this.streams(write.size)) {
        await pump(
          await this.store.getObjectStream(write.hash),
          await writeStream(this.adapter, write.path),
        );
      } else {
        await this.adapter.write(write.path, await this.store.getObject(write.hash));
      }
    }

    await this.refreshCache(target);
  }

  /**
   * Re-points the hash cache at the freshly written files, so the next scan
   * short-circuits on mtime+size instead of re-reading everything.
   */
  private async refreshCache(tree: Tree): Promise<void> {
    const cache = await this.store.hashCache();
    const files: Record<string, CachedFile> = {};
    for (const entry of tree.entries) {
      if (entry.deleted || !entry.hash) continue;
      const stat = await this.adapter.stat(entry.path);
      if (!stat) continue;
      files[entry.path] = { hash: entry.hash, mtime: stat.mtime, size: stat.size, id: entry.id };
    }
    cache.files = files;
    cache.renames = [];
    await this.store.writeHashCache(cache);
  }
}

function takeVanished(
  byHash: Map<Hash, TreeEntry[]>,
  hash: Hash,
  usedIds: Set<string>,
): TreeEntry | undefined {
  const bucket = byHash.get(hash);
  if (!bucket) return undefined;
  while (bucket.length) {
    const candidate = bucket.shift() as TreeEntry;
    if (!usedIds.has(candidate.id)) return candidate;
  }
  return undefined;
}
