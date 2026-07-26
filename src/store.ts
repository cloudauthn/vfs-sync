import {
  decodeJSON,
  decodeText,
  encodeJSON,
  encodeText,
  hashJSON,
  randomId,
  sha256,
  sha256Stream,
} from './hash.js';
import { Sha256 } from './sha256.js';
import { pump, readStream, writeStream } from './stream.js';
import type { Commit, Hash, HashCache, NodeConfig, Tree, VFSAdapter } from './types.js';

/** Name of the control folder that lives inside every synced folder. */
export const CONTROL_DIR = '.vfs';

export interface KnownCommit {
  hash: Hash;
  timestamp: number;
  parents: Hash[];
}

/**
 * The `.vfs/` control folder: content-addressed objects, commits, the
 * known-commits index and the local hash cache.
 *
 * ```
 * .vfs/
 *   config.json
 *   objects/<hash[0:2]>/<hash>
 *   commits/<hash>.json
 *   known-commits.log
 *   hash-cache.json
 * ```
 */
export interface VFSStoreOptions {
  /**
   * Treat the working folder as the blob store: a blob whose content is already
   * a file in the working folder is not copied into `objects/` as well, and
   * reads reconstruct it from that file. Halves the writes on a backend where
   * every object is a network round trip (Google Drive), at the cost of a
   * hash→path lookup on read. Off by default — the ordinary layout keeps every
   * blob under `objects/`, reachable regardless of working-folder state.
   */
  reconstruct?: boolean;
}

/**
 * How many commits and trees a store keeps decoded in memory. A hash is its
 * content, so a memo of them can never be wrong — the bound is only about
 * memory. Note that *existence* is deliberately not remembered: an object or a
 * commit can vanish from disk, and noticing that is how the engine repairs it.
 */
const MEMO_LIMIT = 64;

/** Insertion order is eviction order: keep a bounded memo of the newest reads. */
function memoize<K, V>(map: Map<K, V>, key: K, value: V, limit: number): V {
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  return value;
}

export class VFSStore {
  readonly adapter: VFSAdapter;
  readonly root: string;
  readonly reconstruct: boolean;

  private knownIndex: Map<Hash, KnownCommit> | null = null;
  private cache: HashCache | null = null;
  private config: NodeConfig | null = null;
  /** Lazy hash→working-path index, rebuilt from the cache. Reconstruct mode only. */
  private reverse: Map<Hash, string> | null = null;
  /**
   * Decoded commits and trees, by hash. A hash *is* its content, so what came
   * back once can never have changed — and a sync walks the same commits and
   * trees several times over while it negotiates.
   */
  private readonly commits = new Map<Hash, Commit>();
  private readonly trees = new Map<Hash, Tree>();

  constructor(adapter: VFSAdapter, root = CONTROL_DIR, options: VFSStoreOptions = {}) {
    this.adapter = adapter;
    this.root = root;
    this.reconstruct = options.reconstruct ?? false;
  }

  /**
   * A working file whose content is `hash`, from the cache. Reconstruct mode only.
   *
   * `verify` confirms the file is still where the cache says, at the price of a
   * `stat` — a request of its own on a remote backend. A caller that copes with
   * a miss on its own (it reads through something that returns `null`, or falls
   * back to `objects/`) passes `false` and lets the read be the check.
   */
  private async reconstructPath(hash: Hash, verify = true): Promise<string | null> {
    if (!this.reconstruct) return null;
    if (!this.reverse) {
      const cache = await this.hashCache();
      this.reverse = new Map();
      for (const [path, entry] of Object.entries(cache.files)) this.reverse.set(entry.hash, path);
    }
    const path = this.reverse.get(hash);
    if (!path) return null;
    if (!verify) return path;
    // The cache can lag the disk; make sure the file is still there.
    return (await this.adapter.stat(path)) ? path : null;
  }

  private path(...parts: string[]): string {
    return [this.root, ...parts].join('/');
  }

  private objectPath(hash: Hash): string {
    return this.path('objects', hash.slice(0, 2), hash);
  }

  /**
   * Reads a file of the store, or `null` when it is not there. Reads first and
   * asks afterwards: a hit is one call instead of `stat` + `read`, which on a
   * remote backend halves the cost of every object, commit and config read. The
   * `stat` only happens when the read failed, where it still decides whether the
   * file was simply absent or the backend genuinely broke.
   */
  private async readFile(path: string): Promise<Uint8Array | null> {
    try {
      return await this.adapter.read(path);
    } catch (error) {
      const stat = await this.adapter.stat(path);
      if (stat && stat.kind === 'file') throw error;
      return null;
    }
  }

  // ---------------------------------------------------------------- config

  async readConfig(): Promise<NodeConfig> {
    if (this.config) return this.config;
    const data = await this.readFile(this.path('config.json'));
    this.config = data
      ? decodeJSON<NodeConfig>(data)
      : { id: randomId(), storeId: randomId(), head: null, peers: {} };
    return this.config;
  }

  async writeConfig(config: NodeConfig): Promise<void> {
    this.config = config;
    await this.adapter.write(this.path('config.json'), encodeJSON(config));
  }

  async init(id?: string): Promise<NodeConfig> {
    const existing = await this.readFile(this.path('config.json'));
    if (existing) {
      // Decode what we just read rather than asking readConfig, which would
      // fetch the same file a second time before memoizing it.
      const config = decodeJSON<NodeConfig>(existing);
      this.config = config;
      // stores written before storeId existed pick one up on first open
      if (!config.storeId) {
        config.storeId = randomId();
        await this.writeConfig(config);
      }
      return config;
    }
    const config: NodeConfig = { id: id ?? randomId(), storeId: randomId(), head: null, peers: {} };
    await this.writeConfig(config);
    return config;
  }

  async head(): Promise<Hash | null> {
    return (await this.readConfig()).head;
  }

  async setHead(hash: Hash | null): Promise<void> {
    const config = await this.readConfig();
    config.head = hash;
    await this.writeConfig(config);
  }

  async recordPeer(peerId: string, head: Hash | null, at: number): Promise<void> {
    const config = await this.readConfig();
    config.peers[peerId] = { lastSync: at, head };
    await this.writeConfig(config);
  }

  /**
   * The end of a sync moves the head and records the peer at once. Kept as one
   * config write rather than a `setHead` + `recordPeer` pair, which on a remote
   * backend like Drive is two round trips for what is a single new state.
   */
  async finalizeSync(head: Hash | null, peerId: string, peerHead: Hash | null, at: number): Promise<void> {
    const config = await this.readConfig();
    config.head = head;
    config.peers[peerId] = { lastSync: at, head: peerHead };
    await this.writeConfig(config);
  }

  // --------------------------------------------------------------- objects

  /** True only when the blob is stored under `objects/`, ignoring reconstruction. */
  async hasStoredObject(hash: Hash): Promise<boolean> {
    return (await this.adapter.stat(this.objectPath(hash))) !== null;
  }

  async hasObject(hash: Hash): Promise<boolean> {
    if (await this.hasStoredObject(hash)) return true;
    return (await this.reconstructPath(hash)) !== null;
  }

  async getObject(hash: Hash): Promise<Uint8Array> {
    // In reconstruct mode the working folder *is* the blob store, so read from
    // there first: `objects/` only holds what the working tree cannot supply, and
    // probing it first spends a miss — a lookup per path segment — on every blob.
    //
    // The bytes are checked against the address they were asked for, which is
    // what makes the order safe: the hash→path index can be *stale in content*,
    // not just in existence (a conflict loser is pinned into `objects/` precisely
    // because its working file is about to be overwritten). A mismatch falls
    // through to `objects/` rather than handing back the wrong blob.
    if (this.reconstruct) {
      const working = await this.reconstructPath(hash, false);
      const reconstructed = working ? await this.readFile(working) : null;
      if (reconstructed && (await sha256(reconstructed)) === hash) return reconstructed;
    }
    const data = await this.readFile(this.objectPath(hash));
    if (data) return data;
    // No unverified last resort: the working file has already been tried above,
    // and reading it again without checking the digest is how a stale hash cache
    // hands back the wrong blob.
    throw new Error(`missing object ${hash} in ${this.adapter.name}`);
  }

  /** Stores a blob and returns its content address. Writes are idempotent. */
  async putObject(data: Uint8Array): Promise<Hash> {
    const hash = await sha256(data);
    await this.putObjectAt(hash, data);
    return hash;
  }

  /** Stores a blob whose hash is already known (skips re-hashing). */
  async putObjectAt(hash: Hash, data: Uint8Array): Promise<void> {
    if (await this.hasObject(hash)) return;
    await this.adapter.write(this.objectPath(hash), data);
  }

  /**
   * Force a blob into `objects/` even when reconstruction would otherwise cover
   * it — used to pin a blob that is about to be overwritten in the working
   * folder (a conflict loser), so it stays readable through the change.
   */
  async materialize(hash: Hash, data: Uint8Array): Promise<void> {
    if (await this.hasStoredObject(hash)) return;
    await this.adapter.write(this.objectPath(hash), data);
  }

  /** Size of a blob, from its stored object or the working file it reconstructs from. */
  async objectSize(hash: Hash): Promise<number> {
    const stored = (await this.adapter.stat(this.objectPath(hash)))?.size;
    if (stored !== undefined) return stored;
    const path = await this.reconstructPath(hash);
    if (path) return (await this.adapter.stat(path))?.size ?? 0;
    return 0;
  }

  async getObjectStream(hash: Hash): Promise<ReadableStream<Uint8Array>> {
    if (await this.hasStoredObject(hash)) return readStream(this.adapter, this.objectPath(hash));
    const path = await this.reconstructPath(hash);
    if (path) return readStream(this.adapter, path);
    throw new Error(`missing object ${hash} in ${this.adapter.name}`);
  }

  /**
   * Streams a blob whose hash is already known straight to its content address,
   * digesting on the way past. Because the destination path is known up front
   * there is no staging file and no rename — which matters, since `rename()`
   * falls back to copy+delete on backends without a native move, and that would
   * put the whole blob back in memory.
   *
   * The digest is verified rather than trusted: a mismatch means the source
   * lied or changed underneath us, and the half-written object is removed.
   */
  async putObjectStreamAt(hash: Hash, source: ReadableStream<Uint8Array>): Promise<void> {
    if (await this.hasObject(hash)) {
      await source.cancel().catch(() => {
        // nothing to drain
      });
      return;
    }
    await this.storeStream(hash, source);
  }

  /** Streaming counterpart of {@link materialize}: pins even reconstructible blobs. */
  async materializeStream(hash: Hash, source: ReadableStream<Uint8Array>): Promise<void> {
    if (await this.hasStoredObject(hash)) {
      await source.cancel().catch(() => {
        // nothing to drain
      });
      return;
    }
    await this.storeStream(hash, source);
  }

  private async storeStream(hash: Hash, source: ReadableStream<Uint8Array>): Promise<void> {
    const path = this.objectPath(hash);
    const hasher = new Sha256();
    try {
      await pump(source, await writeStream(this.adapter, path), (chunk) => hasher.update(chunk));
    } catch (error) {
      await this.adapter.delete(path);
      throw error;
    }
    const actual = hasher.digest();
    if (actual !== hash) {
      await this.adapter.delete(path);
      throw new Error(`object ${hash} arrived as ${actual} in ${this.adapter.name}`);
    }
  }

  /**
   * Stores a blob that has to be streamed, when its hash is not known yet.
   *
   * `open()` is called twice — once to hash, once to store — because the
   * content address has to be known before a byte can be written to it. That
   * trades a second read of the source for never holding the blob and never
   * needing a staging file. Sources here are always files at a known path, so
   * re-reading them is cheap.
   */
  async putObjectStream(open: () => Promise<ReadableStream<Uint8Array>>): Promise<Hash> {
    const hash = await sha256Stream(await open());
    if (!(await this.hasObject(hash))) await this.putObjectStreamAt(hash, await open());
    return hash;
  }

  // ------------------------------------------------------------ trees

  async getTree(hash: Hash): Promise<Tree> {
    const held = this.trees.get(hash);
    if (held) return held;
    // A tree is always written into `objects/` and is never a working file, so
    // read it straight from there: going through getObject would load the
    // reconstruction index for nothing. The fallback covers the pathological
    // case where a working file happened to hold these very bytes, which would
    // have let putTree skip the write.
    const data = (await this.readFile(this.objectPath(hash))) ?? (await this.getObject(hash));
    return memoize(this.trees, hash, decodeJSON<Tree>(data), MEMO_LIMIT);
  }

  async putTree(tree: Tree): Promise<Hash> {
    const canonical = canonicalTree(tree);
    const hash = await hashJSON(canonical);
    await this.putObjectAt(hash, encodeJSON(canonical));
    memoize(this.trees, hash, canonical, MEMO_LIMIT);
    return hash;
  }

  // ----------------------------------------------------------- commits

  async getCommit(hash: Hash): Promise<Commit> {
    const held = this.commits.get(hash);
    if (held) return held;
    const data = await this.readFile(this.path('commits', `${hash}.json`));
    if (!data) throw new Error(`missing commit ${hash} in ${this.adapter.name}`);
    return memoize(this.commits, hash, decodeJSON<Commit>(data), MEMO_LIMIT);
  }

  async hasCommit(hash: Hash): Promise<boolean> {
    return (await this.adapter.stat(this.path('commits', `${hash}.json`))) !== null;
  }

  async putCommit(commit: Commit): Promise<Hash> {
    const hash = await hashJSON(commit);
    await this.putCommitAt(hash, commit);
    return hash;
  }

  async putCommitAt(hash: Hash, commit: Commit): Promise<void> {
    if (!(await this.hasCommit(hash))) {
      await this.adapter.write(this.path('commits', `${hash}.json`), encodeJSON(commit));
    }
    memoize(this.commits, hash, commit, MEMO_LIMIT);
    await this.addKnown({ hash, timestamp: commit.timestamp, parents: commit.parents });
  }

  // ------------------------------------------------------ known-commits

  /**
   * Flat index of every commit this node has ever seen — its own plus the ones
   * learned from peers. Turns common-ancestor negotiation into a set
   * intersection instead of a walk of the DAG.
   */
  async known(): Promise<Map<Hash, KnownCommit>> {
    if (this.knownIndex) return this.knownIndex;
    const index = new Map<Hash, KnownCommit>();
    const data = await this.readFile(this.path('known-commits.log'));
    if (data) {
      for (const line of decodeText(data).split('\n')) {
        if (!line.trim()) continue;
        const [hash, timestamp, parents] = line.split(' ');
        if (!hash || !timestamp) continue;
        index.set(hash, {
          hash,
          timestamp: Number(timestamp),
          parents: parents ? parents.split(',').filter(Boolean) : [],
        });
      }
    }
    this.knownIndex = index;
    return index;
  }

  async addKnown(entry: KnownCommit): Promise<void> {
    const index = await this.known();
    if (index.has(entry.hash)) return;
    index.set(entry.hash, entry);
    await this.flushKnown();
  }

  private async flushKnown(): Promise<void> {
    const index = await this.known();
    const lines = [...index.values()]
      .sort((a, b) => a.timestamp - b.timestamp || (a.hash < b.hash ? -1 : 1))
      .map((c) => `${c.hash} ${c.timestamp} ${c.parents.join(',')}`);
    await this.adapter.write(this.path('known-commits.log'), encodeText(`${lines.join('\n')}\n`));
  }

  // ------------------------------------------------------- hash cache

  async hashCache(): Promise<HashCache> {
    if (this.cache) return this.cache;
    const data = await this.readFile(this.path('hash-cache.json'));
    const parsed = data ? decodeJSON<Partial<HashCache>>(data) : null;
    this.cache = { files: parsed?.files ?? {}, renames: parsed?.renames ?? [] };
    return this.cache;
  }

  async writeHashCache(cache: HashCache): Promise<void> {
    this.cache = cache;
    this.reverse = null; // the working set changed; the hash→path index is stale
    await this.adapter.write(this.path('hash-cache.json'), encodeJSON(cache));
  }

  /** Drops memoised state so the next read hits the adapter again. */
  invalidate(): void {
    this.knownIndex = null;
    this.cache = null;
    this.config = null;
    this.reverse = null;
  }
}

/** Sorts entries and strips falsy optionals so encoding is byte-stable. */
export function canonicalTree(tree: Tree): Tree {
  return {
    entries: [...tree.entries]
      .map((entry) => {
        const out: Record<string, unknown> = {
          id: entry.id,
          path: entry.path,
          hash: entry.hash,
          size: entry.size,
          mtime: entry.mtime,
        };
        if (entry.deleted) out.deleted = true;
        if (entry.renamedFrom) out.renamedFrom = entry.renamedFrom;
        if (entry.peer) out.peer = entry.peer;
        return out as unknown as Tree['entries'][number];
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export const EMPTY_TREE: Tree = { entries: [] };
