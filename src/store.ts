import { decodeJSON, encodeJSON, randomId } from './hash.js';
import { encodeRows, missingRows, parseRows, xorDigest } from './log.js';
import { concat, readRange } from './stream.js';
import {
  DEFAULT_TEXT_EXTENSIONS,
  HEADER_PROBE,
  ZERO_DIGEST,
  decodeVFSFile,
  emptyFile,
  encodeVFSFile,
  headerOf,
  normalizeFile,
  parseHeader,
} from './vfs-file.js';
import type { Hash, LogRow, VFSAdapter, VFSEntry, VFSFile, VFSHeader } from './types.js';

/** Name of the control folder that lives inside every synced folder. */
export const CONTROL_DIR = '.vfs';

/**
 * How big the active log segment is allowed to get before it rotates.
 *
 * This is literally "how much am I willing to re-upload on every sync": Drive
 * has no append, so extending the log rewrites the whole active segment. 256 KB
 * is the design's starting point. Rotation is also forced after a bulk import,
 * which produces thousands of rows in one go.
 */
export const ROTATE_AT = 256 * 1024;

export interface VFSStoreOptions {
  /** Segment size that triggers rotation. Defaults to {@link ROTATE_AT}. */
  rotateAt?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * The `.vfs/` control folder in v2 — two files on the normal path.
 *
 * ```
 * .vfs/
 *   vfs.json                # mutable: header + the mirror of the tree
 *   commits                 # append-only: the active segment of the log
 *   commits-<ts>            # closed segments, immutable
 *   vfs-<ts>.json           # cumulative snapshot taken when each segment closed
 *   base/<hash>             # local only: previous text content, for diff3
 * ```
 *
 * There is no object store: the working file *is* the content. What is left
 * here is metadata, an append-only log of operations, and a local scratch area
 * for three-way merges that never travels.
 */
export class VFSStore {
  readonly adapter: VFSAdapter;
  readonly root: string;
  readonly rotateAt: number;

  private file: VFSFile | null = null;
  /** Active segment, in arrival order — the order it has on disk. */
  private rows: LogRow[] | null = null;
  /** Cumulative snapshot of the last rotation, decoded. */
  private snapshot: VFSEntry[] | null = null;
  /** Closed segments are immutable, so what came back once is kept for good. */
  private readonly archives = new Map<number, LogRow[]>();
  private readonly now: () => number;

  constructor(adapter: VFSAdapter, root = CONTROL_DIR, options: VFSStoreOptions = {}) {
    this.adapter = adapter;
    this.root = root;
    this.rotateAt = options.rotateAt ?? ROTATE_AT;
    this.now = options.now ?? (() => Date.now());
  }

  path(...parts: string[]): string {
    return [this.root, ...parts].join('/');
  }

  /**
   * Reads a control file, or `null` when it is not there. Reads first and asks
   * afterwards: a hit is one call instead of `stat` + `read`, and the `stat`
   * only happens on the miss, where it still separates "absent" from "broken".
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

  // ------------------------------------------------------------- vfs.json

  get filePath(): string {
    return this.path('vfs.json');
  }

  async read(): Promise<VFSFile> {
    if (this.file) return this.file;
    const data = await this.readFile(this.filePath);
    if (!data) throw new Error(`no vfs store in ${this.adapter.name}`);
    this.file = decodeVFSFile(data);
    return this.file;
  }

  /** The decoded file if it is already in hand, without touching the backend. */
  peek(): VFSFile | null {
    return this.file;
  }

  /**
   * Header only — `state`, `log`, `peers` — from a range read of the top of the
   * file. This is the "one read per peer" of a quiet sync: `entries` can run to
   * megabytes and none of it is needed to find out that nothing changed.
   */
  async header(): Promise<VFSHeader> {
    if (this.file) return headerOf(this.file);
    for (let probe = HEADER_PROBE; probe <= HEADER_PROBE * 16; probe *= 4) {
      const prefix = await readRange(this.adapter, this.filePath, { end: probe });
      const header = parseHeader(prefix);
      if (header) return header;
      if (prefix.byteLength < probe) break; // that was the whole file already
    }
    // Pathological header (hundreds of peers): fall back to reading it all.
    return this.read();
  }

  /** Sorts, re-digests and writes. The only way `vfs.json` changes on disk. */
  async write(file: VFSFile): Promise<VFSFile> {
    const normalized = await normalizeFile(file);
    this.file = normalized;
    await this.adapter.write(this.filePath, encodeVFSFile(normalized));
    return normalized;
  }

  /** Opens an existing store, or lays down a fresh one. */
  async init(options: { peer?: string; storeId?: string } = {}): Promise<VFSFile> {
    const data = await this.readFile(this.filePath);
    if (data) {
      this.file = decodeVFSFile(data);
      return this.file;
    }
    return this.write(
      emptyFile(options.peer ?? randomId(), options.storeId ?? randomId(), this.now(), [
        ...DEFAULT_TEXT_EXTENSIONS,
      ]),
    );
  }

  async exists(): Promise<boolean> {
    if (this.file) return true;
    return (await this.adapter.stat(this.filePath)) !== null;
  }

  // ------------------------------------------------------------ commit log

  segmentPath(segment?: number): string {
    return segment === undefined ? this.path('commits') : this.path(`commits-${segment}`);
  }

  /** The whole active segment, in arrival order. */
  async logRows(): Promise<LogRow[]> {
    if (this.rows) return this.rows;
    const data = await this.readFile(this.segmentPath());
    this.rows = data ? parseRows(data) : [];
    return this.rows;
  }

  /**
   * Rows of the active segment from a byte offset — one range read instead of
   * the whole file. Returning a superset is always safe (union deduplicates by
   * `op`), so a cached segment answers from memory.
   */
  async rowsSince(offset: number): Promise<LogRow[]> {
    if (this.rows || offset <= 0) return this.logRows();
    const data = await readRange(this.adapter, this.segmentPath(), { start: offset }).catch(
      () => null,
    );
    return data ? parseRows(data) : [];
  }

  /**
   * Adds the rows the segment does not already hold and refreshes `log.*`.
   *
   * There is only one writer per store, and a shared file means two concurrent
   * appenders lose rows, so the mitigation is explicit: compare the file's size
   * against what the header claims and, if it grew underneath us, fold the tail
   * in before writing. Where the backend offers a conditional write, that
   * check-then-act becomes atomic rather than merely likely.
   */
  async append(rows: LogRow[], file?: VFSFile): Promise<VFSFile> {
    const target = file ?? (await this.read());
    const existing = await this.logRows();

    const onDisk = (await this.adapter.stat(this.segmentPath()))?.size ?? 0;
    if (onDisk > target.log.size) {
      const extra = parseRows(
        await readRange(this.adapter, this.segmentPath(), { start: target.log.size }).catch(
          () => new Uint8Array(),
        ),
      );
      for (const row of missingRows(existing, extra)) existing.push(row);
    }

    const fresh = missingRows(existing, rows);
    if (fresh.length > 0) {
      await this.appendBytes(this.segmentPath(), encodeRows(fresh));
      for (const row of fresh) existing.push(row);
    }
    this.rows = existing;

    target.log.rows = existing.length;
    target.log.digest = xorDigest(existing);
    target.log.size = (await this.adapter.stat(this.segmentPath()))?.size ?? target.log.size;
    return target;
  }

  /** Native append where the backend has one, read-concat-write where it does not. */
  private async appendBytes(path: string, data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return;
    if (this.adapter.append) {
      await this.adapter.append(path, data);
      return;
    }
    const held = (await this.readFile(path)) ?? new Uint8Array();
    if (this.adapter.writeIf && this.adapter.tag) {
      const tag = held.byteLength > 0 ? await this.adapter.tag(path) : null;
      if ((await this.adapter.writeIf(path, concat([held, data]), tag)) !== null) return;
      // Lost the race: whoever won is on disk now, so re-read and fold in on top.
      const again = (await this.readFile(path)) ?? new Uint8Array();
      await this.adapter.write(path, concat([again, data]));
      return;
    }
    await this.adapter.write(path, concat([held, data]));
  }

  // -------------------------------------------------------------- rotation

  /** True when the active segment has outgrown the threshold. */
  async shouldRotate(file?: VFSFile): Promise<boolean> {
    return (file ?? (await this.read())).log.size >= this.rotateAt;
  }

  /**
   * Closes the active segment and takes a cumulative snapshot.
   *
   * The order is the whole point, and it is what makes tombstone pruning safe:
   * **rotate and photograph first, prune `vfs.json` afterwards**. The snapshot
   * is *previous snapshot ∪ current entries*, tombstones included — not "the
   * tree at this moment" but "the last known state of every uuid that has ever
   * existed". A snapshot that was merely the current tree would drop a delete
   * whose tombstone had been pruned two segments ago, and the file would
   * resurrect on the next peer that still had it.
   */
  async rotate(file?: VFSFile): Promise<VFSFile> {
    const target = file ?? (await this.read());
    const closing = target.log.segment;
    const rows = await this.logRows();

    const merged = new Map<string, VFSEntry>();
    for (const entry of await this.readSnapshot(target)) merged.set(entry.uuid, entry);
    for (const entry of target.entries) {
      const held = merged.get(entry.uuid);
      if (!held || entry.updated >= held.updated) merged.set(entry.uuid, entry);
    }
    const entries = [...merged.values()];

    const stamp = Math.max(this.now(), closing + 1);
    const snapshot = `vfs-${stamp}.json`;
    await this.adapter.write(this.path(snapshot), encodeJSON({ entries }));

    const archives = [...(target.log.archives ?? [])];
    if (rows.length > 0) {
      await this.adapter.rename(this.segmentPath(), this.segmentPath(closing));
      archives.push(closing);
    } else {
      await this.adapter.delete(this.segmentPath()).catch(() => undefined);
    }

    this.snapshot = entries;
    this.rows = [];
    target.log = {
      segment: stamp,
      digest: ZERO_DIGEST,
      rows: 0,
      size: 0,
      snapshot,
      ...(archives.length > 0 ? { archives } : {}),
    };
    return target;
  }

  /** Entries of the cumulative snapshot named in the header, or `[]`. */
  async readSnapshot(file?: VFSFile | VFSHeader): Promise<VFSEntry[]> {
    if (this.snapshot) return this.snapshot;
    const name = (file ?? (await this.read())).log.snapshot;
    if (!name) return (this.snapshot = []);
    const data = await this.readFile(this.path(name));
    this.snapshot = data ? (decodeJSON<{ entries: VFSEntry[] }>(data).entries ?? []) : [];
    return this.snapshot;
  }

  /**
   * Rows of a closed segment. Immutable, so it is cached for good — and it is
   * only ever read to *avoid* a conflict copy, never to decide state, so a
   * missing archive costs a spurious copy and nothing else.
   */
  async readArchive(segment: number): Promise<LogRow[]> {
    const held = this.archives.get(segment);
    if (held) return held;
    const data = await this.readFile(this.segmentPath(segment));
    const rows = data ? parseRows(data) : [];
    this.archives.set(segment, rows);
    return rows;
  }

  // ------------------------------------------------------------------ base

  basePath(hash: Hash): string {
    return this.path('base', hash);
  }

  /** Keeps the text content that is about to be overwritten, for a later diff3. */
  async putBase(hash: Hash, data: Uint8Array): Promise<void> {
    await this.adapter.write(this.basePath(hash), data);
  }

  async getBase(hash: Hash): Promise<Uint8Array | null> {
    return this.readFile(this.basePath(hash));
  }

  /**
   * Drops base copies nothing can still need.
   *
   * `keep` is derived from a signal that already exists — content still
   * referenced back to the oldest `peers[*].lastSync` — so retention prunes
   * itself at the pace of syncing. `limit` is the hard stop for the risk the
   * design calls out: a peer configured once and forgotten would otherwise hold
   * the window open forever. Over-pruning only degrades a text merge to LWW
   * plus a copy.
   */
  async pruneBase(keep: Set<Hash>, limit = 256): Promise<void> {
    const listing = (await this.adapter.list(this.path('base')).catch(() => [])).filter(
      (entry) => entry.kind === 'file',
    );
    const doomed = listing.filter((entry) => !keep.has(entry.name));

    // Over the hard cap even after dropping the unreferenced ones: give up the
    // oldest of what is left. Losing a base only costs a merge that falls back
    // to LWW plus a copy, so an unbounded folder is the worse outcome.
    const held = listing.filter((entry) => keep.has(entry.name));
    const overflow = held.length - limit;
    if (overflow > 0) {
      doomed.push(
        ...[...held].sort((x, y) => (x.stat?.mtime ?? 0) - (y.stat?.mtime ?? 0)).slice(0, overflow),
      );
    }
    for (const entry of doomed) await this.adapter.delete(entry.path).catch(() => undefined);
  }

  /** Drops memoised state so the next read hits the backend again. */
  invalidate(): void {
    this.file = null;
    this.rows = null;
    this.snapshot = null;
  }
}
