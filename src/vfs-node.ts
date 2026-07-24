import { randomId, sha256 } from './hash.js';
import { EMPTY_TREE, VFSStore, canonicalTree } from './store.js';
import type { CachedFile, Commit, Hash, Tree, TreeEntry, VFSAdapter } from './types.js';
import { walk } from './walk.js';

export interface VFSNodeOptions {
  /** Stable peer id. Generated and persisted in `.vfs/config.json` if omitted. */
  id?: string;
  /** Return true to keep a path out of sync entirely. */
  ignore?: (path: string) => boolean;
  /** Injectable clock, mostly for tests. */
  now?: () => number;
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

  private readonly ignore: ((path: string) => boolean) | undefined;
  private readonly now: () => number;

  private constructor(adapter: VFSAdapter, id: string, options: VFSNodeOptions) {
    this.adapter = adapter;
    this.store = new VFSStore(adapter);
    this.id = id;
    this.ignore = options.ignore;
    this.now = options.now ?? (() => Date.now());
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
      let hash: Hash;
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        hash = cached.hash;
        if (!(await this.store.hasObject(hash))) {
          await this.store.putObjectAt(hash, await this.adapter.read(file.path));
        }
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
    const writes: Array<{ path: string; hash: Hash }> = [];
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
        writes.push({ path: entry.path, hash: entry.hash as Hash });
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
      await this.adapter.write(write.path, await this.store.getObject(write.hash));
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
