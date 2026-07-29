import {
  CONTROL_DIR,
  HEADER_PROBE,
  FSAAdapter,
  GDriveAdapter,
  MemoryAdapter,
  OPFSAdapter,
  ScopedAdapter,
  VFSNode,
  basename,
  dirname,
  isOPFSAvailable,
  joinPath,
  normalizePath,
  parseHeader,
  readRange,
  sha256,
  sha256Stream,
  sync,
  syncUntilStable,
  walk,
} from '../../src/index';
import {
  clearGoogleToken,
  googleTokenExpiry,
  googleTokenProvider,
  hasCachedGoogleToken,
} from './gis';
import type {
  ConflictReport,
  Hash,
  MeshEdge,
  PeerMark,
  PendingConflict,
  SyncDryRunResult,
  VFSEntry,
  VFSAdapter,
  VFSListEntry,
  VFSStat,
  WalkedFile,
} from '../../src/index';
import { formatAgo, formatBytes, isTextMime, looksTextual, mimeOf } from './format';

export type LogKind = 'info' | 'ok' | 'warn' | 'conflict';

export interface ExplorerOptions {
  /** Subfolder of OPFS the browser starts at. `''` (the default) is the origin root. */
  opfsRoot?: string;
  /** Written to the first root you open when it is brand new and empty. `null` disables it. */
  seed?: Record<string, string> | null;
  /** Interval the auto-sync switch runs at. */
  autoSyncMs?: number;
  /** Offer the card that opens a folder from disk through the File System Access API. */
  localFolder?: boolean;
  /**
   * Public OAuth client id that enables the Google Drive backend. When set, the
   * new-tab switcher offers a "Connect Drive" button. Leave unset to hide it.
   */
  gdriveClientId?: string;
  /**
   * OAuth scope requested for Drive. Defaults to `drive.file`, which only lets
   * the app see files it created — enough to sync its own folders, but it means
   * the rest of My Drive is invisible. Use `.../auth/drive` to browse and sync
   * the user's whole Drive.
   */
  gdriveScope?: string;
  /** Draw the footer's sync controls — target, sync, auto-sync. */
  toolbar?: boolean;
  /** Offer the activity drawer the status bar opens. */
  activityLog?: boolean;
  /** Every log line, so a host page can mirror it somewhere of its own. */
  onLog?: (message: string, kind: LogKind) => void;
}

export const DEFAULT_SEED: Record<string, string> = {
  'notes.md': '# Notes\n\nEdit me on any tab.\n',
  'todo.md': '- [ ] sync the chain\n',
  'docs/getting-started.md': 'Folders sync too.\n',
};

/** Above this the details pane streams the checksum instead of holding the file. */
const STREAM_HASH_OVER = 4 * 1024 * 1024;
/** How much decoded text the read cache may hold before the oldest is dropped. */
const PEEK_BUDGET = 4 * 1024 * 1024;
/** And how many entries, so hash-only ones (which hold no text) stay bounded too. */
const PEEK_LIMIT = 512;
/** Above this a file is not compared against the other roots byte for byte. */
const COMPARE_LIMIT = 8 * 1024 * 1024;
/** Above this the editor refuses to open a file, however text-like it is. */
export const EDIT_LIMIT = 512 * 1024;
/** Sentinel target: sync the whole chain rather than one pair. */
export const ALL_ROOTS = '*';

export type Backend = 'OPFS' | 'memory' | 'local folder' | 'GDrive';

export const BACKEND_ICON: Record<Backend, string> = {
  OPFS: '🗄',
  memory: '🧠',
  'local folder': '📁',
  GDrive: '☁',
};

/** One line per backend, shown when a root is open with nothing selected. */
export const BLURB: Record<Backend, string> = {
  OPFS:
    'Origin Private File System — private to this origin, survives reloads, ' +
    'and never prompts. The natural home for a background sync loop.',
  memory:
    'MemoryAdapter — paths to bytes in a Map. It is what the test-suite runs on, ' +
    'and it disappears when you reload.',
  'local folder':
    'File System Access API — a real folder on your disk. Permission is revoked ' +
    'on reload, so it has to be re-granted from a click.',
  GDrive:
    'Google Drive over its REST API, straight from the browser — no server of ' +
    'your own. Its native fileId tracks renames and moves with certainty.',
};

/** Shown when the read-only `.vfs` view, or anything inside it, is selected. */
export const CONTROL_BLURB =
  'The sync store. vfs.json is the mirror of this folder — a header, then a row ' +
  'per path — and commits is the append-only log of operations behind it. There ' +
  'is no object store: the working file is the content. The explorer only reads ' +
  'this folder — the engine is its writer.';

export interface Peer {
  key: string;
  label: string;
  backend: Backend;
  adapter: VFSAdapter;
  node: VFSNode;
  /** Only local-folder roots, whose permission can lapse mid-session. */
  fsa?: FSAAdapter;
  /** Directories this root has folded away. */
  collapsed: Set<string>;
  /**
   * Rows unfolded inside the read-only `.vfs` view — including `.vfs` itself,
   * which is what makes its listing worth reading at all. Inverted against
   * {@link collapsed} on purpose: the store's own files start folded away, so an
   * `objects/` folder of thousands is never listed unless it is asked for.
   */
  controlExpanded: Set<string>;
}

/** What one render pass needs to know about a root. */
export interface Snapshot {
  files: WalkedFile[];
  /**
   * The store, one folder's listing per unfolded row, keyed by folder path —
   * `null` while `.vfs` itself is folded. A level at a time on purpose:
   * `objects/` is a folder per two-character hash prefix, so walking it whole is
   * a request per bucket on a remote backend, and a store of a few hundred blobs
   * would spend hundreds of them on one click.
   */
  control: Map<string, VFSListEntry[]> | null;
  /** Digest of the live entries — two roots agree when these match. */
  state: Hash | null;
  /** The mirror, by path: what `vfs.json` says about each file. */
  tracked: Map<string, VFSEntry>;
  peers: Record<string, PeerMark>;
  /** Conflicts waiting for a person, straight out of `vfs.json`. */
  conflicts: PendingConflict[];
  /** When the mirror was last checked against the disk (§6). */
  verifiedAt: number | null;
  bytes: number;
}

export interface Selection {
  peer: string;
  path: string;
  kind: 'file' | 'directory';
}

/** How one other root compares on the selected path. */
export interface Across {
  key: string;
  label: string;
  backend: Backend;
  state: 'same' | 'differs' | 'missing' | 'unknown';
  detail: string;
}

/** Everything the right-hand column shows about the current selection. */
export interface Details {
  peer: string;
  path: string;
  kind: 'file' | 'directory';
  stat: VFSStat | null;
  mime: string;
  hash: Hash | null;
  entry: VFSEntry | undefined;
  across: Across[];
  /** Inside `.vfs`: the store's own metadata, which the explorer only reads. */
  control: boolean;
  /** Loaded file text, or `null` when the file is binary or too large. */
  text: string | null;
  /** Directory rollup. */
  count: number;
  bytes: number;
}

/** One filesystem the new-tab view can browse. */
export interface BrowseSource {
  key: string;
  label: string;
  icon: string;
  backend: Backend;
  /** `null` when the backend is unavailable here; `error` says why. */
  adapter: VFSAdapter | null;
  error?: string;
  /** Local folders keep their FSAAdapter around for permission re-grants. */
  fsa?: FSAAdapter;
  /** Picked local folders can be dropped from the switcher again. */
  removable?: boolean;
  /** Directories this view has unfolded. */
  expanded: Set<string>;
}

export interface BrowseSel {
  source: string;
  path: string;
  kind: 'file' | 'directory';
}

/** One row of the new-tab folder tree, flattened for synchronous rendering. */
export interface BrowseRow {
  kind: 'file' | 'directory';
  path: string;
  name: string;
  depth: number;
  /** Directory rows only. */
  childCount: number;
  /** Directory rows only: the `.vfs` store inside, if any. */
  info: { storeId: string } | null;
  expanded: boolean;
}

/** The right-hand info pane of the new-tab view, precomputed. */
export type BrowseDetailsData =
  | { kind: 'intro' }
  | { kind: 'file'; path: string; name: string; mime: string; stat: VFSStat }
  | {
      kind: 'directory';
      path: string;
      name: string;
      /** Immediate children only — a recursive walk is too costly on Drive. */
      count: number;
      info: { storeId: string } | null;
    };

/** Everything the new-tab view draws, computed off the browsing thread. */
export interface NewTabView {
  sourceKey: string;
  /** `null` when the source has no usable adapter. */
  rows: BrowseRow[] | null;
  /** Message shown in place of rows (unavailable, empty, or an error). */
  notice: string | null;
  details: BrowseDetailsData;
}

export interface LogEntry {
  time: string;
  message: string;
  kind: LogKind;
}

export interface ExplorerDialog {
  kind: 'confirm' | 'prompt';
  title: string;
  message: string;
  sections?: Array<{ title: string; items: string[] }>;
  value?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

/** One folder's cached children, plus the `.vfs` probe that rides along. */
interface BrowseListing {
  entries: VFSListEntry[];
  /** `undefined` until this folder has been probed for a store. */
  info?: { storeId: string } | null;
  expiresAt: number;
}

/** One file, read once: its checksum and its text if it has any. */
interface Peek {
  hash: Hash | null;
  text: string | null;
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

/**
 * How much of a file the details pane wants back. `text` decodes because the
 * name says it is text; `sniff` decodes only if the bytes read as text (a blob
 * under `.vfs/objects/` is named after its hash, so there is nothing to go by);
 * `hash` never decodes — it is what the across-roots comparison needs.
 */
type PeekMode = 'text' | 'sniff' | 'hash';

/**
 * The explorer's whole state and behaviour, with no dependency on how it is
 * drawn. It mutates in place and calls {@link subscribe}rs on every change; a
 * Preact tree reads these fields and repaints. Every value the view needs is
 * plain data here — the async work (walking folders, hashing, probing `.vfs`
 * stores) happens in these methods so rendering stays synchronous.
 */
export class ExplorerModel {
  readonly opfsRoot: string;
  readonly seed: Record<string, string> | null;
  readonly autoSyncMs: number;
  readonly wantsLocalFolder: boolean;
  readonly wantsControls: boolean;
  readonly wantsLog: boolean;
  readonly gdriveClientId: string | undefined;
  readonly gdriveScope: string;

  peers: Peer[] = [];
  edges: MeshEdge[] = [];
  /** Key of the open root; `''` is the new-tab view. */
  active = '';
  syncTargetKey = ALL_ROOTS;
  selection: Selection | null = null;
  details: Details | null = null;
  /** Shown while the details of a fresh selection are still loading. */
  detailsLoading = false;
  syncing = false;
  lastSyncAt: number | null = null;
  dirty = false;
  logOpen = false;
  logCount = 0;
  lastMessage = 'ready';
  lastKind: LogKind = 'info';
  logs: LogEntry[] = [];
  snapshots = new Map<string, Snapshot>();
  dialog: ExplorerDialog | null = null;

  sources: BrowseSource[] = [];
  /** Key of the filesystem the new-tab view is browsing. */
  activeSource = '';
  /** Entry picked in the new-tab tree; drives the right-hand info pane. */
  browseSel: BrowseSel | null = null;
  /** Shown while a fresh new-tab selection's info pane is still loading. */
  browseDetailsLoading = false;
  /** Shown while switching browse source and its folder tree is still loading. */
  newTabLoading = false;
  /** Shown while an opened peer tab's file tree (its first walk) is loading. */
  treeLoading = false;
  /** A tab that has been clicked but whose peer (store open + first walk) is still loading. */
  pendingTab: { key: string; label: string; backend: Backend } | null = null;
  newTab: NewTabView | null = null;

  readonly autoSyncBoxId = `vfs-auto-${Math.random().toString(36).slice(2, 8)}`;

  private readonly options: ExplorerOptions;
  private readonly listeners = new Set<() => void>();
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  /**
   * Browse-tree listings, keyed `sourceKey:path`. Rebuilding the tree on every
   * structural change would otherwise re-list every visible folder — a network
   * round trip each on Drive. Cleared whenever the new-tab view is (re)opened,
   * and invalidated per-path on our own mutations, so it never shows stale data
   * from an edit made here; a change made elsewhere shows on the next reopen.
   */
  private readonly browseCache = new Map<string, BrowseListing>();
  /** Browse-tree folders whose children are still being listed, keyed `sourceKey:path`. */
  private readonly browseLoading = new Set<string>();
  /**
   * Files already read for the details pane, keyed by root, path, mtime and size
   * — the same identity the engine's own hash cache trusts, so an edited file
   * misses on its new key instead of needing invalidation. Re-selecting a file,
   * or comparing it against another root, then costs nothing rather than a
   * download and a re-hash each. Bounded by {@link PEEK_BUDGET}.
   */
  private readonly peeks = new Map<string, Peek>();
  /** Decoded text currently held in {@link peeks}, in UTF-16 units. */
  private peekBytes = 0;

  /** Bumped on every selection change; a stale async load drops its result. */
  private detailToken = 0;
  /** Bumped on every new-tab selection; a stale details load drops its result. */
  private browseSeq = 0;
  /** Bumped on every browse-source switch; a stale tree build drops its result. */
  private newTabSeq = 0;
  /** Bumped on every render; a stale async recompute drops its result. */
  private renderSeq = 0;
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  private fsaSeq = 0;
  private gdriveSeq = 0;
  /** The one Drive source's token provider, reused so a refresh reaches its adapter. */
  private gdriveToken: (() => Promise<string>) | null = null;
  private dialogResolve: ((answer: boolean | string | null) => void) | null = null;

  constructor(options: ExplorerOptions = {}) {
    this.options = options;
    this.opfsRoot = normalizePath(options.opfsRoot ?? '');
    this.seed = options.seed === undefined ? DEFAULT_SEED : options.seed;
    this.autoSyncMs = options.autoSyncMs ?? 3000;
    this.wantsLocalFolder = options.localFolder ?? true;
    this.wantsControls = options.toolbar ?? true;
    this.wantsLog = options.activityLog ?? true;
    this.gdriveClientId = options.gdriveClientId || undefined;
    // `||` not `??`: an empty VITE_GDRIVE_SCOPE (set but blank) must fall back,
    // or GIS rejects with "Missing required parameter scope".
    this.gdriveScope = options.gdriveScope || 'https://www.googleapis.com/auth/drive.file';
  }

  /** True when the Google Drive backend is configured with a client id. */
  get canGDrive(): boolean {
    return Boolean(this.gdriveClientId);
  }

  /** True once a Google Drive source is in the switcher. */
  get gdriveConnected(): boolean {
    return this.sources.some((source) => source.backend === 'GDrive');
  }

  // -------------------------------------------------------------- subscribe

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // --------------------------------------------------------------- bootstrap

  /** Some sandboxes leave `getDirectory()` pending forever rather than reject. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OPFS timed out')), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async boot(): Promise<void> {
    this.sources.push({
      key: 'mem',
      label: 'MemFS',
      icon: BACKEND_ICON.memory,
      backend: 'memory',
      adapter: new MemoryAdapter('memfs'),
      expanded: new Set(),
    });
    const opfs: BrowseSource = {
      key: 'opfs',
      label: this.opfsRoot ? `OPFS / ${this.opfsRoot}` : 'OPFS',
      icon: BACKEND_ICON.OPFS,
      backend: 'OPFS',
      adapter: null,
      expanded: new Set(),
    };
    if (!isOPFSAvailable()) {
      opfs.error = 'This browser has no Origin Private File System.';
    } else {
      try {
        opfs.adapter = await this.withTimeout(
          OPFSAdapter.open({ path: this.opfsRoot, name: 'opfs' }),
          3000,
        );
      } catch {
        opfs.error =
          'OPFS is blocked or stalled here (private window, sandboxed iframe). ' +
          'MemFS still works.';
      }
    }
    this.sources.push(opfs);
    this.activeSource = opfs.adapter ? 'opfs' : 'mem';
    if (opfs.error) this.log(opfs.error, 'warn');
    this.restoreGDrive();
    await this.render();
  }

  private async addPeer(
    key: string,
    label: string,
    adapter: VFSAdapter,
    backend: Backend,
    fsa?: FSAAdapter,
  ): Promise<Peer> {
    const node = await VFSNode.open(adapter, { id: label });
    const peer: Peer = {
      key,
      label,
      backend,
      adapter,
      node,
      collapsed: new Set(),
      controlExpanded: new Set(),
    };
    if (fsa) peer.fsa = fsa;
    this.peers.push(peer);
    this.rebuildEdges();
    return peer;
  }

  private rebuildEdges(): void {
    this.edges = this.peers
      .slice(0, -1)
      .map((p, i) => ({ a: p.node, b: (this.peers[i + 1] as Peer).node }));
  }

  /**
   * The demo files, written only to the very first root when it starts blank —
   * and only to MemFS, which is throwaway. Seeding any persistent backend
   * (OPFS, a picked disk folder, Google Drive) would write real files the user
   * can see and would look like a phantom sync; those must start empty until
   * the user syncs into them.
   */
  private async maybeSeed(peer: Peer, fresh: boolean): Promise<void> {
    if (!this.seed || !fresh || this.peers.length !== 1) return;
    if (peer.backend !== 'memory') return;
    for (const [path, text] of Object.entries(this.seed)) {
      await peer.node.write(path, this.encoder.encode(text));
    }
    const count = Object.keys(this.seed).length;
    this.log(`seeded ${peer.label} with ${count} file${count === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------------ render

  activePeer(): Peer | undefined {
    return this.peers.find((peer) => peer.key === this.active);
  }

  private peerOf(key: string | undefined): Peer | undefined {
    return this.peers.find((peer) => peer.key === key);
  }

  private async readSnapshot(peer: Peer, freshControl = false): Promise<Snapshot> {
    const files = await walk(peer.adapter);
    const tracked = new Map<string, VFSEntry>();
    let state: Hash | null = null;
    let peers: Record<string, PeerMark> = {};
    let conflicts: PendingConflict[] = [];
    let verifiedAt: number | null = null;
    try {
      // §6: the tree is painted from `vfs.json`, never from a walk of the
      // store. One read carries entries, peers and the pending conflicts.
      const file = await peer.node.file();
      for (const entry of file.entries) if (!entry.deleted) tracked.set(entry.path, entry);
      state = file.state;
      peers = file.peers ?? {};
      verifiedAt = file.local.verifiedAt ?? null;
      conflicts = await peer.node.conflicts();
    } catch {
      // a root whose store is unreadable still lists its files
    }
    return {
      files,
      control: peer.controlExpanded.has(CONTROL_DIR)
        ? await this.readControl(peer, this.snapshots.get(peer.key)?.control ?? null, freshControl)
        : null,
      state,
      tracked,
      peers,
      conflicts,
      verifiedAt,
      bytes: files.reduce((total, file) => total + file.stat.size, 0),
    };
  }

  /**
   * The store as the read-only view needs it: one listing per unfolded folder,
   * `.vfs` first and down through whatever is open beneath it. A folded folder
   * is never listed, which is the whole point — `objects/` fans out into a folder
   * per hash prefix, and on Drive each one is a request.
   *
   * `held` is what the last pass read. A local backend re-lists anyway, so a
   * commit's new objects show up on their own; on Drive re-listing every open
   * folder on every repaint (and there is a repaint per auto-sync tick) is what
   * we are avoiding, so the listings it already has stand until the refresh
   * button asks for new ones. Either way a folder just unfolded is listed now.
   */
  private async readControl(
    peer: Peer,
    held: Map<string, VFSListEntry[]> | null,
    fresh: boolean,
  ): Promise<Map<string, VFSListEntry[]>> {
    const keep = !fresh && peer.backend === 'GDrive';
    const listings = new Map<string, VFSListEntry[]>();
    const visit = async (dir: string): Promise<void> => {
      const reused = keep ? held?.get(dir) : undefined;
      const entries = reused ?? (await this.listControl(peer, dir));
      listings.set(dir, entries);
      for (const entry of entries) {
        if (entry.kind === 'directory' && peer.controlExpanded.has(entry.path)) {
          await visit(entry.path);
        }
      }
    };
    try {
      await visit(CONTROL_DIR);
    } catch {
      // a root whose store is unreadable still lists its working tree
    }
    return listings;
  }

  /**
   * One folder of the store, sorted for display, with a size on every file it
   * holds. Backends whose listing already carries sizes (Drive, memory) pay
   * nothing for that; the rest stat the files of this one folder, which is local
   * and cheap on every backend where it happens.
   */
  private async listControl(peer: Peer, dir: string): Promise<VFSListEntry[]> {
    const entries: VFSListEntry[] = [];
    for (const entry of await peer.adapter.list(dir)) {
      if (entry.kind === 'file' && !entry.stat) {
        const stat = await peer.adapter.stat(entry.path);
        entries.push(stat ? { ...entry, stat } : entry);
      } else {
        entries.push(entry);
      }
    }
    return entries.sort((a, b) =>
      a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === 'directory' ? -1 : 1,
    );
  }

  /** Recompute every snapshot (and the new-tab view, when open) and repaint. */
  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const next = new Map<string, Snapshot>();
    for (const peer of this.peers) next.set(peer.key, await this.readSnapshot(peer));
    if (seq !== this.renderSeq) return;
    this.snapshots = next;
    // Only rebuild the browse view when it is the one on screen; while a peer
    // tab is active we leave the last one intact so returning to it is instant.
    if (!this.activePeer()) {
      const view = await this.buildNewTab();
      if (seq !== this.renderSeq) return;
      this.newTab = view;
    }
    this.browseDetailsLoading = false;
    this.newTabLoading = false;
    this.treeLoading = false;
    this.emit();
  }

  /** Compute one peer's snapshot if we have not already — for an instant switch. */
  private async ensureSnapshot(peer: Peer): Promise<void> {
    if (this.snapshots.has(peer.key)) return;
    const snapshot = await this.readSnapshot(peer);
    const merged = new Map(this.snapshots);
    merged.set(peer.key, snapshot);
    this.snapshots = merged;
  }

  snapshotOf(key: string): Snapshot {
    return (
      this.snapshots.get(key) ?? {
        files: [],
        control: null,
        state: null,
        tracked: new Map(),
        peers: {},
        conflicts: [],
        verifiedAt: null,
        bytes: 0,
      }
    );
  }

  // ------------------------------------------------------------------- tabs

  async activateNewTab(): Promise<void> {
    this.active = '';
    // Repaint at once — the browse view switches in immediately; its tree fills
    // from cache (or a Loading placeholder) rather than re-walking every peer.
    this.newTabLoading = this.newTab === null || this.newTab.sourceKey !== this.activeSource;
    this.emit();
    await this.refreshNewTab();
  }

  /**
   * Re-read whatever is on screen straight from the backend, past the cache —
   * the manual escape hatch for the token-lifetime cache. On a peer tab it
   * re-walks that root; on the browse view it drops the current source's cached
   * listings and rebuilds.
   */
  async reload(): Promise<void> {
    const peer = this.activePeer();
    if (peer) {
      this.treeLoading = true;
      this.emit();
      // Refreshing is the gesture that distrusts what we hold, so the cached
      // reads go too — a file rewritten elsewhere at the same size and mtime
      // would otherwise keep its old checksum here.
      this.forgetPeeks(peer);
      const snapshot = await this.readSnapshot(peer, true);
      const merged = new Map(this.snapshots);
      merged.set(peer.key, snapshot);
      this.snapshots = merged;
      this.treeLoading = false;
      this.emit();
      if (this.selection?.peer === peer.key) {
        await this.select(peer, { path: this.selection.path, kind: this.selection.kind });
      }
      return;
    }
    const source = this.currentSource();
    if (source) this.forgetSubtree(source, '');
    this.newTabLoading = true;
    this.emit();
    await this.refreshNewTab();
  }

  async closePeer(peer: Peer): Promise<void> {
    const index = this.peers.indexOf(peer);
    if (index === -1) return;
    this.peers.splice(index, 1);
    this.rebuildEdges();
    if (this.selection?.peer === peer.key) {
      this.selection = null;
      this.details = null;
      this.dirty = false;
    }
    if (this.active === peer.key) {
      this.active = (this.peers[index] ?? this.peers[index - 1])?.key ?? '';
    }
    this.forgetPeeks(peer); // nothing will ask for this root's bytes again
    this.log(`closed ${peer.label}`);
    await this.render();
  }

  // --------------------------------------------------------- new-tab view

  currentSource(): BrowseSource | undefined {
    return this.sources.find((source) => source.key === this.activeSource) ?? this.sources[0];
  }

  /** Flatten the active source's folder tree and info pane into plain data. */
  private async buildNewTab(): Promise<NewTabView> {
    const source = this.currentSource();
    if (!source) {
      return { sourceKey: '', rows: null, notice: 'No filesystem available.', details: { kind: 'intro' } };
    }
    const view: NewTabView = {
      sourceKey: source.key,
      rows: null,
      notice: null,
      details: await this.buildBrowseDetails(source),
    };
    if (!source.adapter) {
      view.notice = source.error ?? `${source.label} is unavailable.`;
      return view;
    }
    try {
      const rows: BrowseRow[] = [];
      await this.collectBrowseRows(source, '', 0, rows);
      view.rows = rows;
      if (rows.length === 0) view.notice = 'Empty — create a folder to get started';
    } catch (error) {
      view.rows = null;
      view.notice = String(error);
    }
    return view;
  }

  /**
   * `.vfs` probe from a folder's already-fetched listing — no extra `stat`,
   * which on Drive is a whole request per folder. `null` for a plain folder,
   * the pairing id when initialised.
   */
  private async readVfsInfo(
    adapter: VFSAdapter,
    children: VFSListEntry[],
  ): Promise<{ storeId: string } | null> {
    const control = children.find((c) => c.name === CONTROL_DIR && c.kind === 'directory');
    if (!control) return null;
    try {
      // Only the header is needed, and it comes first in the file — so this
      // stays a few hundred bytes even when `entries` runs to megabytes.
      const prefix = await readRange(adapter, `${control.path}/vfs.json`, { end: HEADER_PROBE });
      return { storeId: parseHeader(prefix)?.storeId ?? 'unknown' };
    } catch {
      return { storeId: 'unknown' };
    }
  }

  /**
   * The `.vfs` probe for one folder, cached alongside its listing. The probe is
   * a range read of `.vfs/vfs.json` — a request of its own on Drive — and the tree
   * is rebuilt on every fold, unfold and refresh, so without this every visible
   * root is re-read each time. It shares the listing's expiry and its
   * invalidation, so it can never outlive the children it was derived from.
   */
  private async browseInfo(
    source: BrowseSource,
    path: string,
    children: VFSListEntry[],
  ): Promise<{ storeId: string } | null> {
    if (!source.adapter) return null;
    const held = this.browseCache.get(`${source.key}:${normalizePath(path)}`);
    if (held?.info !== undefined && Date.now() < held.expiresAt) return held.info;
    const info = await this.readVfsInfo(source.adapter, children);
    // Only attach it to the record the children came from; if that has since
    // been dropped, the next probe reads again rather than reviving it.
    if (held) held.info = info;
    return info;
  }

  /** A folder's listing, served from cache until it expires with the token. */
  private async browseList(source: BrowseSource, path: string): Promise<VFSListEntry[]> {
    if (!source.adapter) return [];
    const key = `${source.key}:${normalizePath(path)}`;
    const hit = this.browseCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.entries;
    const entries = await source.adapter.list(path);
    this.browseCache.set(key, { entries, expiresAt: this.browseExpiry(source) });
    return entries;
  }

  /**
   * A browsed file's stat. Backends whose listing carries sizes and times — Drive
   * among them — answer this from the parent folder's cached listing, so clicking
   * a row in the tree costs nothing; only the rest fall back to the backend.
   */
  private async browseStat(source: BrowseSource, path: string): Promise<VFSStat | null> {
    if (!source.adapter) return null;
    const listed = (await this.browseList(source, dirname(path))).find(
      (entry) => entry.path === path,
    );
    return listed?.stat ?? (await source.adapter.stat(path));
  }

  /**
   * When a cached listing goes stale. For Drive it is pinned to the access
   * token's expiry, so cached data lives exactly as long as the session that
   * fetched it; other backends are local and cheap, so they never time out
   * (cleared only on a mutation or a manual refresh).
   */
  private browseExpiry(source: BrowseSource): number {
    if (source.backend === 'GDrive' && this.gdriveClientId) {
      return (
        googleTokenExpiry(this.gdriveClientId, this.gdriveScope) ?? Date.now() + 55 * 60_000
      );
    }
    return Number.POSITIVE_INFINITY;
  }

  /** Drop one folder's cached listing (its direct children changed). */
  private forgetListing(source: BrowseSource, path: string): void {
    this.browseCache.delete(`${source.key}:${normalizePath(path)}`);
  }

  /** Drop a folder's listing and every listing beneath it. */
  private forgetSubtree(source: BrowseSource, path: string): void {
    const root = normalizePath(path);
    const prefix = `${source.key}:${root}`;
    // At the root, every key of this source is inside the subtree; deeper, only
    // the folder itself and what is under its slash — `one` must not take `one-b`.
    const under = root ? `${prefix}/` : prefix;
    for (const key of [...this.browseCache.keys()]) {
      if (key === prefix || key.startsWith(under)) this.browseCache.delete(key);
    }
  }

  /** One level of the tree; expanded folders recurse, in display order. */
  private async collectBrowseRows(
    source: BrowseSource,
    dir: string,
    depth: number,
    out: BrowseRow[],
  ): Promise<void> {
    if (!source.adapter) return;
    const entries = (await this.browseList(source, dir)).filter(
      (entry) => entry.name !== CONTROL_DIR,
    );
    entries.sort((a, b) =>
      a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === 'directory' ? -1 : 1,
    );
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        // One listing per folder gives both the child count and the `.vfs`
        // probe; a separate stat would double the requests on Drive.
        const children = await this.browseList(source, entry.path);
        const info = await this.browseInfo(source, entry.path, children);
        const visible = children.filter((c) => c.name !== CONTROL_DIR);
        const expanded = source.expanded.has(entry.path);
        out.push({
          kind: 'directory',
          path: entry.path,
          name: entry.name,
          depth,
          childCount: visible.length,
          info,
          expanded,
        });
        if (expanded) await this.collectBrowseRows(source, entry.path, depth + 1, out);
      } else {
        out.push({
          kind: 'file',
          path: entry.path,
          name: entry.name,
          depth,
          childCount: 0,
          info: null,
          expanded: false,
        });
      }
    }
  }

  /** The right-hand pane of the new tab: the picked entry, or an intro. */
  private async buildBrowseDetails(source: BrowseSource): Promise<BrowseDetailsData> {
    const adapter = source.adapter;
    const picked = this.browseSel && this.browseSel.source === source.key ? this.browseSel : null;
    if (!picked || !adapter) return { kind: 'intro' };

    // The kind is already known from the row that was clicked, so a directory
    // needs no `stat` — only a file does, for its size and mtime.
    if (picked.kind === 'file') {
      const stat = await this.browseStat(source, picked.path);
      if (!stat) {
        this.browseSel = null;
        return { kind: 'intro' };
      }
      return {
        kind: 'file',
        path: picked.path,
        name: basename(picked.path) || picked.path,
        mime: mimeOf(picked.path),
        stat,
      };
    }
    // Shallow on purpose: one listing (cached), not a recursive walk. The same
    // listing feeds the `.vfs` probe, so a directory's details cost is at most
    // one request — and none once the tree has already listed it.
    const children = await this.browseList(source, picked.path);
    const info = await this.browseInfo(source, picked.path, children);
    return {
      kind: 'directory',
      path: picked.path,
      name: basename(picked.path) || picked.path,
      count: children.filter((e) => e.name !== CONTROL_DIR).length,
      info,
    };
  }

  selectSource(source: BrowseSource): void {
    // Re-clicking the chip that is already open is a refresh: drop its cached
    // listings so the tree re-reads the backend.
    if (this.activeSource === source.key) this.forgetSubtree(source, '');
    this.activeSource = source.key;
    this.browseSel = null;
    // Highlight the chip and show the new source's intro straight away; the
    // folder tree (a network round trip on Drive) fills in behind a placeholder.
    this.newTabLoading = true;
    this.emit();
    void this.refreshNewTab();
  }

  /** Rebuild only the new-tab view (tree + info pane), off the paint. */
  private async refreshNewTab(): Promise<void> {
    const seq = ++this.newTabSeq;
    const view = await this.buildNewTab();
    if (seq !== this.newTabSeq) return; // a newer source switch won the race
    // The rebuilt rows already contain every expanded folder's children, so any
    // "Loading…" placeholders they were standing in for are now resolved.
    this.browseLoading.clear();
    this.newTab = view;
    this.newTabLoading = false;
    this.browseDetailsLoading = false;
    this.emit();
  }

  /** True while a browse folder's children are still being listed. */
  isBrowseLoading(source: BrowseSource, path: string): boolean {
    return this.browseLoading.has(`${source.key}:${normalizePath(path)}`);
  }

  selectBrowse(source: BrowseSource, path: string, kind: 'file' | 'directory'): void {
    this.browseSel = { source: source.key, path, kind };
    // The tree itself does not change on a selection, so we keep the existing
    // rows and repaint straight away: the row highlights now, and the info pane
    // shows a placeholder while its (network-bound) details load.
    this.browseDetailsLoading = true;
    this.emit();
    void this.refreshBrowseDetails();
  }

  /** Recompute only the info pane for the current selection, off the paint. */
  private async refreshBrowseDetails(): Promise<void> {
    const source = this.currentSource();
    const seq = ++this.browseSeq;
    const details: BrowseDetailsData = source
      ? await this.buildBrowseDetails(source)
      : { kind: 'intro' };
    if (seq !== this.browseSeq) return; // a newer selection won the race
    if (this.newTab) this.newTab.details = details;
    this.browseDetailsLoading = false;
    this.emit();
  }

  toggleBrowseDir(source: BrowseSource, path: string, expanded: boolean): void {
    if (expanded) {
      source.expanded.delete(path);
    } else {
      source.expanded.add(path);
      // Mark it loading so a placeholder appears under it at once; the listing
      // of its children (a request each on Drive) fills in behind that.
      this.browseLoading.add(`${source.key}:${normalizePath(path)}`);
    }
    this.emit(); // flip the twisty and show the placeholder immediately
    void this.refreshNewTab();
  }

  async newBrowseFolder(source: BrowseSource): Promise<void> {
    if (!source.adapter?.mkdir) return;
    // Create inside the current selection: a picked folder is the parent, a
    // picked file contributes its folder, and nothing selected means the root.
    const sel = this.browseSel?.source === source.key ? this.browseSel : null;
    const base = sel ? (sel.kind === 'directory' ? sel.path : dirname(sel.path)) : '';
    const where = base ? `${source.label} / ${base}` : source.label;
    const name = await this.askPrompt({
      title: 'New folder',
      message: `New folder in ${where} (a / nests)`,
      value: 'new-folder',
      placeholder: 'new-folder',
      okText: 'Create',
    });
    if (!name) return;
    try {
      const relative = normalizePath(name);
      if (!relative) return;
      const path = joinPath(base, relative);
      await source.adapter.mkdir(path);
      // The base's listing gained a child; the new folder is known-empty, and
      // known to hold no store. Seed both so the rebuild re-lists only the base
      // and does not probe a folder we just created.
      this.forgetListing(source, base);
      this.browseCache.set(`${source.key}:${path}`, {
        entries: [],
        info: null,
        expiresAt: this.browseExpiry(source),
      });
      // reveal it: the base and every ancestor of the new folder unfold
      const segments = path.split('/');
      for (let i = 1; i < segments.length; i++) {
        source.expanded.add(segments.slice(0, i).join('/'));
      }
      this.log(`created folder ${path} on ${source.label}`, 'ok');
      await this.refreshNewTab();
      this.selectBrowse(source, path, 'directory');
    } catch (error) {
      this.log(String(error), 'warn');
    }
  }

  async deleteBrowseEntry(source: BrowseSource, path: string): Promise<void> {
    if (!source.adapter) return;
    const ok = await this.askConfirm({
      title: 'Delete folder',
      message: `Delete ${path} and everything inside it?`,
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      // a tab open on this folder (or inside it) would be left dangling
      for (const peer of this.peers.filter(
        (p) => p.key === `${source.key}:${path}` || p.key.startsWith(`${source.key}:${path}/`),
      )) {
        await this.closePeer(peer);
      }
      await source.adapter.delete(path);
      this.forgetListing(source, dirname(path));
      this.forgetSubtree(source, path);
      source.expanded.delete(path);
      if (
        this.browseSel?.source === source.key &&
        (this.browseSel.path === path || this.browseSel.path.startsWith(`${path}/`))
      ) {
        this.browseSel = null;
      }
      this.log(`deleted ${path} on ${source.label}`, 'ok');
    } catch (error) {
      this.log(String(error), 'warn');
    }
    await this.refreshNewTab();
  }

  async removeSource(source: BrowseSource): Promise<void> {
    for (const peer of this.peers.filter((p) => p.key.startsWith(`${source.key}:`))) {
      await this.closePeer(peer);
    }
    const index = this.sources.indexOf(source);
    if (index !== -1) this.sources.splice(index, 1);
    this.forgetSubtree(source, '');
    if (source.backend === 'GDrive') {
      this.gdriveToken = null;
      if (this.gdriveClientId) clearGoogleToken(this.gdriveClientId, this.gdriveScope);
    }
    if (this.activeSource === source.key) this.activeSource = this.sources[0]?.key ?? '';
    if (this.browseSel?.source === source.key) this.browseSel = null;
    this.log(`forgot ${source.label}`);
    await this.render();
  }

  async regrantSource(source: BrowseSource): Promise<void> {
    if (!source.fsa) return;
    if (await source.fsa.ensurePermission()) this.log(`${source.label} is readable again`, 'ok');
    else this.log(`permission denied for ${source.label}`, 'warn');
    await this.render();
  }

  // ------------------------------------------------------------ open roots

  private async adapterHasStore(adapter: VFSAdapter): Promise<boolean> {
    return (await adapter.stat(CONTROL_DIR))?.kind === 'directory';
  }

  /**
   * Opens a folder of a browsable FS as a tab. Tabs only ever hold vFS roots:
   * a plain folder is refused unless `initialise` — the explicit gesture that
   * writes its `.vfs` store.
   */
  async openVfsTab(source: BrowseSource, path: string, initialise = false): Promise<void> {
    if (!source.adapter) return;
    const key = `${source.key}:${path}`;
    const existing = this.peerOf(key);
    if (existing) return this.activate(existing);
    const label = basename(path) || source.label;
    const prevActive = this.active;
    // Switch to the tab the instant it is clicked: a placeholder peer with a
    // loading tree, before any network. The real peer (store open + first walk)
    // fills in behind it.
    this.pendingTab = { key, label, backend: source.backend };
    this.active = key;
    this.treeLoading = true;
    this.emit();
    try {
      const adapter = path ? new ScopedAdapter(source.adapter, path, label) : source.adapter;
      const hasStore = await this.adapterHasStore(adapter);
      if (!hasStore && !initialise) {
        this.log(`${label} is not initialised as vFS`, 'warn');
        this.pendingTab = null;
        this.active = prevActive;
        this.emit();
        return;
      }
      const peer = await this.addPeer(key, label, adapter, source.backend, source.fsa);
      // Seeding is MemFS-only, so the emptiness walk is only worth taking there;
      // every other backend skips it and opens the tab without a blocking scan.
      if (peer.backend === 'memory') {
        const fresh = !hasStore && (await walk(adapter)).length === 0;
        await this.maybeSeed(peer, fresh);
      }
      // Initialising just wrote a `.vfs` store into the folder; drop its cached
      // listing so the vFS badge shows when the browser is reopened.
      if (!hasStore) this.forgetListing(source, path);
      this.pendingTab = null;
      this.log(hasStore ? `opened ${label}` : `initialised ${label} as vFS`, 'ok');
      await this.activate(peer);
    } catch (error) {
      this.pendingTab = null;
      this.active = prevActive;
      this.log(String(error), 'warn');
      this.emit();
    }
  }

  /** "Pick FS": a folder from disk joins the switcher as a browsable FS. */
  async pickFsaSource(): Promise<void> {
    try {
      const adapter = await FSAAdapter.pick();
      if (!(await adapter.ensurePermission())) {
        this.log('permission denied for that folder', 'warn');
        return;
      }
      const source: BrowseSource = {
        key: `fsa:${++this.fsaSeq}`,
        label: adapter.name || 'local',
        icon: BACKEND_ICON['local folder'],
        backend: 'local folder',
        adapter,
        fsa: adapter,
        removable: true,
        expanded: new Set(),
      };
      this.sources.push(source);
      this.activeSource = source.key;
      this.browseSel = null;
      this.log(`browsing ${source.label} from disk`, 'ok');
      await this.render();
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') this.log(String(error), 'warn');
    }
  }

  /**
   * "Connect Drive": authorise with Google (client-side, via GIS) and add the
   * user's Drive to the switcher as a browsable filesystem. Runs from a click,
   * so the token popup has a live user gesture. A cached token (from a previous
   * session, kept in localStorage) is served without any popup; only an expired
   * or missing one opens the consent/refresh flow — and with `prompt: ''` that
   * is a silent refresh, not a fresh login, once the grant exists.
   */
  async connectGDrive(): Promise<void> {
    if (!this.gdriveClientId) {
      this.log('Google Drive is not configured (set VITE_GDRIVE_CLIENT_ID)', 'warn');
      return;
    }
    const existing = this.sources.find((source) => source.backend === 'GDrive');
    // Reuse the existing source's provider so an expired token refreshes in
    // place (its adapter keeps working); otherwise mint a fresh one.
    const token = existing
      ? (this.gdriveToken as () => Promise<string>)
      : googleTokenProvider(this.gdriveClientId, this.gdriveScope);
    try {
      await token(); // cached-or-interactive, within the click's gesture
      const source = existing ?? this.addGDriveSource(token);
      this.activeSource = source.key;
      this.browseSel = null;
      this.log(existing ? 'refreshed Google Drive' : 'connected Google Drive', 'ok');
      await this.render();
    } catch (error) {
      this.log(String(error), 'warn');
    }
  }

  /**
   * On boot, re-attach Drive if a still-valid token is cached — no popup and no
   * network here: the provider serves the stored token, and its first real use
   * (when the user opens the Drive source) needs no gesture while it lasts.
   */
  private restoreGDrive(): void {
    if (!this.gdriveClientId || !hasCachedGoogleToken(this.gdriveClientId, this.gdriveScope)) return;
    this.addGDriveSource(googleTokenProvider(this.gdriveClientId, this.gdriveScope));
    this.log('restored Google Drive session', 'ok');
  }

  private addGDriveSource(token: () => Promise<string>): BrowseSource {
    this.gdriveToken = token;
    const source: BrowseSource = {
      key: `gdrive:${++this.gdriveSeq}`,
      label: 'Google Drive',
      icon: BACKEND_ICON.GDrive,
      backend: 'GDrive',
      adapter: new GDriveAdapter({ token, name: 'Drive' }),
      removable: true,
      expanded: new Set(),
    };
    this.sources.push(source);
    return source;
  }

  /** "Pick vFS": straight to a tab, offering to initialise a plain folder. */
  async pickFsaVfs(): Promise<void> {
    try {
      const adapter = await FSAAdapter.pick();
      if (!(await adapter.ensurePermission())) {
        this.log('permission denied for that folder', 'warn');
        return;
      }
      const label = adapter.name || 'local';
      const hasStore = await this.adapterHasStore(adapter);
      if (
        !hasStore &&
        !(await this.askConfirm({
          title: 'Initialise vFS root',
          message: `${label} holds no .vfs store yet. Initialise it as a vFS root?`,
          okText: 'Initialise',
        }))
      ) {
        return;
      }
      // A disk folder is never MemFS, so seeding never applies and the emptiness
      // scan is skipped — the tab opens without a blocking walk.
      const peer = await this.addPeer(`fsav:${++this.fsaSeq}`, label, adapter, 'local folder', adapter);
      this.log(hasStore ? `opened ${label} from disk` : `initialised ${label} as vFS`, 'ok');
      await this.activate(peer);
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') this.log(String(error), 'warn');
    }
  }

  // ---------------------------------------------------------------- sidebar

  toggleDir(peer: Peer, path: string, collapsed: boolean): void {
    if (collapsed) peer.collapsed.delete(path);
    else peer.collapsed.add(path);
    this.emit();
  }

  /** `true` for the store's own files, which the explorer never writes to. */
  isControlPath(path: string): boolean {
    return path === CONTROL_DIR || path.startsWith(`${CONTROL_DIR}/`);
  }

  /**
   * Unfold or fold a row of the `.vfs` view. Unfolding costs the one listing of
   * that folder — folding costs nothing and keeps it, so opening the row again is
   * instant. Nothing below a folded row is ever read.
   */
  toggleControl(peer: Peer, path: string): void {
    if (peer.controlExpanded.has(path)) {
      peer.controlExpanded.delete(path);
      this.emit();
      return;
    }
    peer.controlExpanded.add(path);
    this.emit(); // twisty and placeholder now, the listing when it lands
    void this.loadControl(peer);
  }

  /** Re-read the unfolded folders of the store into the peer's snapshot. */
  private async loadControl(peer: Peer): Promise<void> {
    const snapshot = this.snapshotOf(peer.key);
    const control = await this.readControl(peer, snapshot.control, false);
    // Folded again while we were reading — the rows would have nowhere to go.
    if (!peer.controlExpanded.has(CONTROL_DIR)) return;
    const merged = new Map(this.snapshots);
    merged.set(peer.key, { ...this.snapshotOf(peer.key), control });
    this.snapshots = merged;
    this.emit();
  }

  // ---------------------------------------------------------------- actions

  /**
   * Switching roots follows the current path when the other backend has it —
   * which is the whole point of the app: the same file, on another filesystem.
   */
  async activate(peer: Peer): Promise<void> {
    this.active = peer.key;
    // Switch the tab in on the spot. If we already hold its snapshot the tree
    // shows at once; otherwise a "Loading…" placeholder stands in while the
    // first walk runs, so opening a tab never blocks on the data.
    this.treeLoading = !this.snapshots.has(peer.key);
    this.emit();
    if (peer.fsa && !(await peer.fsa.hasPermission())) {
      this.log(`${peer.label} needs its permission re-granted`, 'warn');
    }
    await this.ensureSnapshot(peer);
    this.treeLoading = false;
    this.emit();
    const path = this.selection?.path;
    const stat = path ? await peer.adapter.stat(path) : null;
    if (path && stat) {
      await this.select(peer, { path, kind: stat.kind === 'directory' ? 'directory' : 'file' });
    } else await this.select(peer, null);
  }

  /** Picks a path (or the root itself when `entry` is null) and repaints. */
  async select(
    peer: Peer,
    entry: { path: string; kind: 'file' | 'directory' } | null,
  ): Promise<void> {
    this.active = peer.key;
    // Re-selecting the file being edited (after a sync, say) keeps the buffer.
    const unsaved =
      this.dirty &&
      this.details &&
      this.details.peer === peer.key &&
      this.details.path === entry?.path
        ? this.details.text
        : null;
    this.dirty = unsaved !== null;

    if (!entry) {
      this.selection = null;
      this.details = null;
      this.detailsLoading = false;
      this.detailToken++;
      this.emit();
      return;
    }
    this.selection = { peer: peer.key, path: entry.path, kind: entry.kind };
    const token = ++this.detailToken;
    // Paint the row highlight straight away; the checksum arrives after.
    this.detailsLoading = !this.dirty;
    this.emit();
    // A `.vfs` path can be picked while the store is still unlisted — following
    // the selection onto another root does it — and its rollup needs that list.
    if (this.isControlPath(entry.path) && this.snapshotOf(peer.key).control === null) {
      peer.controlExpanded.add(CONTROL_DIR);
      await this.loadControl(peer);
      if (token !== this.detailToken) return;
    }
    const loaded = await this.loadDetails(peer, this.selection);
    if (token !== this.detailToken) return;
    if (unsaved !== null) loaded.text = unsaved;
    this.details = loaded;
    this.detailsLoading = false;
    this.emit();
  }

  /** Select the root itself (clears the file selection) on the active root. */
  async selectRoot(peer: Peer): Promise<void> {
    await this.select(peer, null);
  }

  private async loadDetails(peer: Peer, current: Selection): Promise<Details> {
    const snapshot = this.snapshotOf(peer.key);
    const mime = mimeOf(current.path);
    const control = this.isControlPath(current.path);
    const detail: Details = {
      peer: peer.key,
      path: current.path,
      kind: current.kind,
      stat: null,
      mime,
      hash: null,
      entry: snapshot.tracked.get(current.path),
      across: [],
      control,
      text: null,
      count: 0,
      bytes: 0,
    };
    if (control && current.kind === 'directory') {
      // Immediate children, not a rollup: the store is listed a folder at a time,
      // so a total would mean walking everything under here — which is exactly
      // what this view no longer does. Its own listing, or one call for it.
      const inside =
        snapshot.control?.get(current.path) ?? (await this.listControl(peer, current.path));
      detail.count = inside.length;
      detail.bytes = inside.reduce((total, entry) => total + (entry.stat?.size ?? 0), 0);
      return detail;
    }

    if (current.kind === 'directory') {
      const inside = snapshot.files.filter((file) => file.path.startsWith(`${current.path}/`));
      detail.count = inside.length;
      detail.bytes = inside.reduce((total, file) => total + file.stat.size, 0);
      detail.across = this.peers
        .filter((other) => other.key !== peer.key)
        .map((other) => {
          const files = this.snapshotOf(other.key).files.filter((file) =>
            file.path.startsWith(`${current.path}/`),
          );
          if (files.length === 0) {
            return { ...this.tag(other), state: 'missing' as const, detail: 'not here' };
          }
          const same = files.length === inside.length;
          return {
            ...this.tag(other),
            state: same ? ('same' as const) : ('differs' as const),
            detail: `${files.length} item${files.length === 1 ? '' : 's'}`,
          };
        });
      return detail;
    }

    // The listing this row came from already carries the size and time — the
    // tree walk for a working file, the folder's own listing inside `.vfs` — so
    // reuse it and only fall back to a stat if the path is not in it.
    const listed = control
      ? snapshot.control?.get(dirname(current.path))?.find((e) => e.path === current.path)?.stat
      : snapshot.files.find((file) => file.path === current.path)?.stat;
    detail.stat = listed ?? (await peer.adapter.stat(current.path));
    if (!detail.stat) return detail;

    const size = detail.stat.size;
    const openable = size <= EDIT_LIMIT;
    const mode: PeekMode =
      openable && isTextMime(mime) ? 'text' : openable && control ? 'sniff' : 'hash';
    const peeked = await this.peek(peer, current.path, detail.stat, mode);
    detail.hash = peeked.hash;
    detail.text = peeked.text;

    if (control) return detail;
    for (const other of this.peers) {
      if (other.key === peer.key) continue;
      detail.across.push(await this.compare(other, current.path, detail));
    }
    return detail;
  }

  private tag(peer: Peer): { key: string; label: string; backend: Backend } {
    return { key: peer.key, label: peer.label, backend: peer.backend };
  }

  /**
   * One read of a file: its checksum, and its text when there is any to show.
   * Remembered under mtime+size, so selecting the same file again — or comparing
   * it across roots, which hashes every other copy — never downloads it twice.
   * Anything past {@link STREAM_HASH_OVER} is streamed and never held whole.
   */
  private async peek(peer: Peer, path: string, stat: VFSStat, mode: PeekMode): Promise<Peek> {
    const key = `${peer.key}:${path}:${stat.mtime}:${stat.size}`;
    const hit = this.peeks.get(key);
    if (hit) {
      // Re-insert: iteration order is insertion order, which is the eviction
      // order, so touching an entry makes it the last to go.
      this.peeks.delete(key);
      this.peeks.set(key, hit);
      return hit;
    }
    const peeked: Peek = { hash: null, text: null };
    try {
      if (stat.size > STREAM_HASH_OVER) {
        peeked.hash = await sha256Stream(await peer.node.readStream(path));
      } else {
        // Small enough to pull once: hash and (when text) decode from the same
        // bytes, rather than downloading the file a second time for the editor.
        const bytes = await peer.node.read(path);
        peeked.hash = await sha256(bytes);
        if (mode !== 'hash') {
          const text = this.decoder.decode(bytes);
          if (mode === 'text' || looksTextual(text)) peeked.text = text;
        }
      }
    } catch {
      return peeked; // unreadable, and not worth remembering as such
    }
    this.remember(key, peeked);
    return peeked;
  }

  /** Drop one root's cached reads — on a refresh, and when its tab is closed. */
  private forgetPeeks(peer: Peer): void {
    for (const [key, held] of this.peeks) {
      if (!key.startsWith(`${peer.key}:`)) continue;
      this.peeks.delete(key);
      this.peekBytes -= held.text?.length ?? 0;
    }
  }

  /** Hold a peek, dropping the oldest ones until it is back inside its budget. */
  private remember(key: string, peeked: Peek): void {
    this.peeks.set(key, peeked);
    this.peekBytes += peeked.text?.length ?? 0;
    for (const [oldest, held] of this.peeks) {
      if (this.peeks.size <= 1) break;
      if (this.peekBytes <= PEEK_BUDGET && this.peeks.size <= PEEK_LIMIT) break;
      this.peeks.delete(oldest);
      this.peekBytes -= held.text?.length ?? 0;
    }
  }

  private async compare(other: Peer, path: string, detail: Details): Promise<Across> {
    // That root's own walk is a complete listing of its files, so it answers
    // both "is it there" and "how big is it" without touching the backend. Only
    // a root we hold no walk for is asked directly.
    const held = this.snapshots.get(other.key);
    const stat = held
      ? (held.files.find((file) => file.path === path)?.stat ?? null)
      : await other.adapter.stat(path);
    if (!stat || stat.kind !== 'file') {
      return { ...this.tag(other), state: 'missing', detail: 'not here' };
    }
    if (stat.size > COMPARE_LIMIT || detail.hash === null) {
      const same = stat.size === detail.stat?.size;
      return {
        ...this.tag(other),
        state: 'unknown',
        detail: same ? `same size, ${formatAgo(stat.mtime)}` : formatBytes(stat.size),
      };
    }
    const hash = (await this.peek(other, path, stat, 'hash')).hash;
    if (hash === detail.hash) return { ...this.tag(other), state: 'same', detail: 'identical' };
    const newer = detail.stat && stat.mtime > detail.stat.mtime;
    return {
      ...this.tag(other),
      state: 'differs',
      detail: `${newer ? 'newer' : 'older'} · ${formatAgo(stat.mtime)}`,
    };
  }

  /**
   * The engine is the only writer inside `.vfs`; the explorer shows it and
   * nothing more. The UI offers no way through here, but the model is the
   * public surface, so every mutation checks rather than trusting the view.
   */
  private refuseControl(path: string): boolean {
    if (!this.isControlPath(path)) return false;
    this.log(`${CONTROL_DIR} is read-only — the store is the engine's to write`, 'warn');
    return true;
  }

  async write(peer: Peer, path: string, text: string): Promise<void> {
    if (this.refuseControl(path)) return;
    await peer.node.write(path, this.encoder.encode(text));
    this.dirty = false;
    this.log(`saved ${path} on ${peer.label}`, 'ok');
    await this.render();
    await this.select(peer, { path, kind: 'file' });
  }

  /** Called from the editor as the user types — no repaint, just bookkeeping. */
  markDirty(text: string): void {
    this.dirty = true;
    if (this.details) this.details.text = text;
    this.emit();
  }

  async newFile(peer: Peer): Promise<void> {
    const name = await this.askPrompt({
      title: 'New file',
      message: 'File name (a / creates a folder)',
      value: 'untitled.md',
      placeholder: 'untitled.md',
      okText: 'Create',
    });
    if (!name || this.refuseControl(normalizePath(name))) return;
    await peer.node.write(name, this.encoder.encode(''));
    this.log(`created ${name} on ${peer.label}`);
    await this.render();
    await this.select(peer, { path: name, kind: 'file' });
  }

  async renameFile(peer: Peer, path: string): Promise<void> {
    if (this.refuseControl(path)) return;
    const name = await this.askPrompt({
      title: 'Rename',
      message: 'Rename to',
      value: path,
      okText: 'Rename',
    });
    if (!name || name === path || this.refuseControl(normalizePath(name))) return;
    // Goes through the node, not the adapter, so the rename is recorded as
    // intent and travels as a rename rather than as delete + create.
    await peer.node.rename(path, name);
    this.log(`renamed ${path} → ${name} on ${peer.label}`);
    await this.render();
    await this.select(peer, { path: name, kind: 'file' });
  }

  async deleteFile(peer: Peer, path: string): Promise<void> {
    if (this.refuseControl(path)) return;
    const ok = await this.askConfirm({
      title: 'Delete file',
      message: `Delete ${path} from ${peer.label}?`,
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await peer.node.delete(path);
    this.log(`deleted ${path} on ${peer.label}`);
    await this.render();
    await this.select(peer, null);
  }

  /**
   * Settles one pending conflict (§4).
   *
   * The engine does the two operations — write the winner, delete the copy — in
   * one batch, so from here it is an ordinary edit: nothing to reconcile, no
   * state machine, and the answer propagates on the next sync like any write.
   */
  async resolveConflict(peer: Peer, uuid: string, choice: 'mine' | 'theirs'): Promise<void> {
    const pending = (await peer.node.conflicts()).find((item) => item.uuid === uuid);
    if (!pending) return;
    if (pending.held && pending.held !== peer.node.id && choice === 'theirs') {
      this.log(`that version stayed on ${pending.held} — sync with it first`, 'warn');
      return;
    }
    await peer.node.resolve(uuid, choice);
    this.log(
      `resolved ${pending.path} on ${peer.label} — kept ${choice === 'mine' ? 'this side' : pending.copyPath}`,
      'ok',
    );
    await this.render();
    await this.reselect();
  }

  // -------------------------------------------------------------------- sync

  setSyncTarget(key: string): void {
    this.syncTargetKey = key;
    this.emit();
  }

  /** Syncs the open root against the footer's target — or the whole chain. */
  async syncTarget(): Promise<void> {
    return this.syncTargetCommon(false);
  }

  /** Same target flow, but asks for approval before applying a pair merge. */
  async syncTargetWithConfirm(): Promise<void> {
    return this.syncTargetCommon(true);
  }

  private async syncTargetCommon(confirmMerge: boolean): Promise<void> {
    if (this.syncTargetKey === ALL_ROOTS || this.syncTargetKey === this.active) {
      if (confirmMerge) {
        const ok = await this.askConfirm({
          title: 'Sync all roots',
          message:
            `Sync all roots now?\n\n` +
            `${this.edges.length} edge(s) will be processed until the chain settles.`,
          okText: 'Sync',
        });
        if (!ok) {
          this.log('sync cancelled');
          return;
        }
      }
      return this.syncAll();
    }
    const a = this.activePeer();
    const b = this.peerOf(this.syncTargetKey);
    if (!a || !b || this.syncing) return;

    const approveMerge = confirmMerge
      ? async (preview: SyncDryRunResult) => {
          if (!preview.changed) return true;

          const changes = uniqueSorted([
            ...preview.actions.toA
              .filter((action) => action.type === 'write' && !action.created)
              .map((action) => `→ ${a.label}: ${action.path}`),
            ...preview.actions.toB
              .filter((action) => action.type === 'write' && !action.created)
              .map((action) => `→ ${b.label}: ${action.path}`),
            ...preview.actions.toA
              .filter((action) => action.type === 'rename')
              .map((action) => `→ ${a.label}: ${action.from ?? action.path} -> ${action.to ?? action.path}`),
            ...preview.actions.toB
              .filter((action) => action.type === 'rename')
              .map((action) => `→ ${b.label}: ${action.from ?? action.path} -> ${action.to ?? action.path}`),
          ]);

          const creates = uniqueSorted([
            ...preview.actions.toA
              .filter((action) => action.type === 'write' && action.created)
              .map((action) => `→ ${a.label}: ${action.path}`),
            ...preview.actions.toB
              .filter((action) => action.type === 'write' && action.created)
              .map((action) => `→ ${b.label}: ${action.path}`),
            ...preview.actions.toA
              .filter((action) => action.type === 'mkdir')
              .map((action) => `→ ${a.label}: ${action.path}/`),
            ...preview.actions.toB
              .filter((action) => action.type === 'mkdir')
              .map((action) => `→ ${b.label}: ${action.path}/`),
          ]);

          const mergedText = uniqueSorted(preview.mergedPaths);

          const deletes = uniqueSorted([
            ...preview.actions.toA
              .filter((action) => action.type === 'delete')
              .map((action) => `→ ${a.label}: ${action.path}`),
            ...preview.actions.toB
              .filter((action) => action.type === 'delete')
              .map((action) => `→ ${b.label}: ${action.path}`),
          ]);

          const conflicts = uniqueSorted(
            preview.conflicts.map((conflict) =>
              conflict.copy
                ? `${conflict.path} (${conflict.kind}) -> copy: ${conflict.copy.path}`
                : `${conflict.path} (${conflict.kind})`,
            ),
          );

          const lines = [
            `${a.label} ⇄ ${b.label}`,
            '',
            `to ${a.label}: ${preview.actions.toA.length} action(s)`,
            `to ${b.label}: ${preview.actions.toB.length} action(s)`,
            `estimated transfers: ${preview.transferred.toA + preview.transferred.toB}`,
            `text merges: ${preview.merged}`,
            `conflicts: ${preview.conflicts.length}`,
            '',
            'Apply this sync?',
          ];
          return this.askConfirm({
            title: 'Confirm sync',
            message: lines.join('\n'),
            sections: [
              { title: 'Files that change', items: changes },
              { title: 'Files that are created', items: creates },
              { title: 'Files updated via text merge', items: mergedText },
              { title: 'Files that are deleted', items: deletes },
              { title: 'Conflicts', items: conflicts },
            ],
            okText: 'Apply',
          });
        }
      : undefined;

    this.syncing = true;
    this.emit();
    try {
      const result = await sync(a.node, b.node, {
        ...(approveMerge ? { approveMerge } : {}),
      });
      if (result.approved === false) {
        this.log(`${a.label} ⇄ ${b.label}: sync cancelled`);
        return;
      }
      const moved = result.transferred.toA + result.transferred.toB;
      if (!result.changed) this.log(`${a.label} ⇄ ${b.label}: already in sync`);
      else this.log(`${a.label} ⇄ ${b.label}: merged, ${moved} blob(s) moved`, 'ok');
      for (const conflict of result.conflicts) this.logConflict(conflict);
      this.lastSyncAt = Date.now();
    } catch (error) {
      this.log(String(error), 'warn');
    } finally {
      this.syncing = false;
      await this.reselect();
    }
  }

  async syncAll(): Promise<void> {
    if (this.syncing || this.edges.length === 0) return;
    this.syncing = true;
    this.emit();
    try {
      const rounds = await syncUntilStable(this.edges);
      const changed = rounds.flat().filter((r) => r.result.changed);
      const conflicts = rounds.flat().flatMap((r) => r.result.conflicts);
      if (changed.length === 0) this.log('every root already in sync');
      else this.log(`converged in ${rounds.length} round(s), ${changed.length} edge update(s)`, 'ok');
      for (const conflict of conflicts) this.logConflict(conflict);
      this.lastSyncAt = Date.now();
    } catch (error) {
      this.log(String(error), 'warn');
    } finally {
      this.syncing = false;
      await this.reselect();
    }
  }

  private logConflict(conflict: ConflictReport): void {
    const winner = conflict.winner === 'a' ? conflict.a : conflict.b;
    this.log(
      `conflict on ${conflict.path} (${conflict.kind}) — ` +
        `${winner?.peer ?? conflict.winner} has the newer version` +
        (conflict.copy ? `, kept ${conflict.copy.path}` : ''),
      'conflict',
    );
  }

  /** A sync may have rewritten or removed whatever was selected. */
  private async reselect(): Promise<void> {
    await this.render();
    const peer = this.peerOf(this.selection?.peer);
    if (!this.selection || !peer) return;
    const stat = await peer.adapter.stat(this.selection.path);
    if (!stat) await this.select(peer, null);
    else await this.select(peer, { path: this.selection.path, kind: this.selection.kind });
  }

  setAutoSync(on: boolean): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = on ? setInterval(() => void this.syncTarget(), this.autoSyncMs) : undefined;
    this.emit();
  }

  get autoSyncOn(): boolean {
    return this.autoTimer !== undefined;
  }

  // ------------------------------------------------------------------ extras

  async regrant(peer: Peer): Promise<void> {
    if (!peer.fsa) return;
    if (await peer.fsa.ensurePermission()) this.log(`${peer.label} is readable again`, 'ok');
    else this.log(`permission denied for ${peer.label}`, 'warn');
    await this.render();
  }

  toggleLog(open: boolean): void {
    this.logOpen = open && this.wantsLog;
    if (this.logOpen) this.logCount = 0;
    this.emit();
  }

  clearLog(): void {
    this.logs = [];
    this.logCount = 0;
    this.emit();
  }

  log(message: string, kind: LogKind = 'info'): void {
    this.options.onLog?.(message, kind);
    this.lastMessage = message;
    this.lastKind = kind;
    if (!this.logOpen) this.logCount++;
    this.logs = [{ time: new Date().toLocaleTimeString(), message, kind }, ...this.logs].slice(0, 100);
    this.emit();
  }

  destroy(): void {
    this.setAutoSync(false);
    this.listeners.clear();
  }

  // ------------------------------------------------------------------- modal

  private async askConfirm(dialog: Omit<ExplorerDialog, 'kind'>): Promise<boolean> {
    this.closeDialog(false);
    this.dialog = {
      kind: 'confirm',
      cancelText: 'Cancel',
      okText: 'OK',
      ...dialog,
    };
    this.emit();
    return new Promise<boolean>((resolve) => {
      this.dialogResolve = (answer) => resolve(Boolean(answer));
    });
  }

  private async askPrompt(dialog: Omit<ExplorerDialog, 'kind'>): Promise<string | null> {
    this.closeDialog(null);
    this.dialog = {
      kind: 'prompt',
      cancelText: 'Cancel',
      okText: 'OK',
      value: dialog.value ?? '',
      ...dialog,
    };
    this.emit();
    return new Promise<string | null>((resolve) => {
      this.dialogResolve = (answer) => (typeof answer === 'string' ? resolve(answer) : resolve(null));
    });
  }

  setDialogValue(value: string): void {
    if (!this.dialog || this.dialog.kind !== 'prompt') return;
    this.dialog = { ...this.dialog, value };
    this.emit();
  }

  acceptDialog(): void {
    if (!this.dialog) return;
    const answer = this.dialog.kind === 'prompt' ? this.dialog.value ?? '' : true;
    this.closeDialog(answer);
  }

  cancelDialog(): void {
    if (!this.dialog) return;
    this.closeDialog(this.dialog.kind === 'prompt' ? null : false);
  }

  private closeDialog(answer: boolean | string | null): void {
    if (!this.dialog && !this.dialogResolve) return;
    const resolve = this.dialogResolve;
    this.dialogResolve = null;
    this.dialog = null;
    this.emit();
    resolve?.(answer);
  }
}
