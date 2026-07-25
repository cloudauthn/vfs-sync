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
export class VFSStore {
  readonly adapter: VFSAdapter;
  readonly root: string;

  private knownIndex: Map<Hash, KnownCommit> | null = null;
  private cache: HashCache | null = null;
  private config: NodeConfig | null = null;

  constructor(adapter: VFSAdapter, root = CONTROL_DIR) {
    this.adapter = adapter;
    this.root = root;
  }

  private path(...parts: string[]): string {
    return [this.root, ...parts].join('/');
  }

  private objectPath(hash: Hash): string {
    return this.path('objects', hash.slice(0, 2), hash);
  }

  private async readFile(path: string): Promise<Uint8Array | null> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.kind !== 'file') return null;
    return this.adapter.read(path);
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
      const config = await this.readConfig();
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

  async hasObject(hash: Hash): Promise<boolean> {
    const stat = await this.adapter.stat(this.objectPath(hash));
    return stat !== null;
  }

  async getObject(hash: Hash): Promise<Uint8Array> {
    const data = await this.readFile(this.objectPath(hash));
    if (!data) throw new Error(`missing object ${hash} in ${this.adapter.name}`);
    return data;
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

  /** Size on disk of a stored blob, or 0 when it is not here. */
  async objectSize(hash: Hash): Promise<number> {
    return (await this.adapter.stat(this.objectPath(hash)))?.size ?? 0;
  }

  async getObjectStream(hash: Hash): Promise<ReadableStream<Uint8Array>> {
    if (!(await this.hasObject(hash))) {
      throw new Error(`missing object ${hash} in ${this.adapter.name}`);
    }
    return readStream(this.adapter, this.objectPath(hash));
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
    return decodeJSON<Tree>(await this.getObject(hash));
  }

  async putTree(tree: Tree): Promise<Hash> {
    const canonical = canonicalTree(tree);
    const hash = await hashJSON(canonical);
    await this.putObjectAt(hash, encodeJSON(canonical));
    return hash;
  }

  // ----------------------------------------------------------- commits

  async getCommit(hash: Hash): Promise<Commit> {
    const data = await this.readFile(this.path('commits', `${hash}.json`));
    if (!data) throw new Error(`missing commit ${hash} in ${this.adapter.name}`);
    return decodeJSON<Commit>(data);
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
    await this.adapter.write(this.path('hash-cache.json'), encodeJSON(cache));
  }

  /** Drops memoised state so the next read hits the adapter again. */
  invalidate(): void {
    this.knownIndex = null;
    this.cache = null;
    this.config = null;
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
