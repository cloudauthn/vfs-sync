import {
  CONTROL_DIR,
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
  sha256,
  sha256Stream,
  sync,
  syncUntilStable,
  walk,
} from '../../src/index';
import { clearGoogleToken, googleTokenProvider, hasCachedGoogleToken } from './gis';
import type {
  ConflictReport,
  Hash,
  MeshEdge,
  NodeConfig,
  TreeEntry,
  VFSAdapter,
  VFSListEntry,
  VFSStat,
  WalkedFile,
} from '../../src/index';
import { formatAgo, formatBytes, isTextMime, mimeOf } from './format';

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
}

/** What one render pass needs to know about a root. */
export interface Snapshot {
  files: WalkedFile[];
  head: Hash | null;
  /** Committed state, by path — what the last commit says about each file. */
  tracked: Map<string, TreeEntry>;
  peers: NodeConfig['peers'];
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
  entry: TreeEntry | undefined;
  across: Across[];
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

  sources: BrowseSource[] = [];
  /** Key of the filesystem the new-tab view is browsing. */
  activeSource = '';
  /** Entry picked in the new-tab tree; drives the right-hand info pane. */
  browseSel: BrowseSel | null = null;
  /** Shown while a fresh new-tab selection's info pane is still loading. */
  browseDetailsLoading = false;
  /** Shown while switching browse source and its folder tree is still loading. */
  newTabLoading = false;
  newTab: NewTabView | null = null;

  readonly autoSyncBoxId = `vfs-auto-${Math.random().toString(36).slice(2, 8)}`;

  private readonly options: ExplorerOptions;
  private readonly listeners = new Set<() => void>();
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

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
    const peer: Peer = { key, label, backend, adapter, node, collapsed: new Set() };
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

  /** The demo files, written only to the very first root when it starts blank. */
  private async maybeSeed(peer: Peer, fresh: boolean): Promise<void> {
    if (!this.seed || !fresh || this.peers.length !== 1) return;
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

  private async readSnapshot(peer: Peer): Promise<Snapshot> {
    const files = await walk(peer.adapter);
    const tracked = new Map<string, TreeEntry>();
    try {
      for (const entry of (await peer.node.headTree()).entries) {
        if (!entry.deleted) tracked.set(entry.path, entry);
      }
    } catch {
      // a root whose commit is unreadable still lists its files
    }
    const config = await peer.node.store.readConfig();
    return {
      files,
      head: await peer.node.head(),
      tracked,
      peers: config.peers ?? {},
      bytes: files.reduce((total, file) => total + file.stat.size, 0),
    };
  }

  /** Recompute every snapshot (and the new-tab view, when open) and repaint. */
  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const next = new Map<string, Snapshot>();
    for (const peer of this.peers) next.set(peer.key, await this.readSnapshot(peer));
    if (seq !== this.renderSeq) return;
    this.snapshots = next;
    if (this.activePeer()) {
      this.newTab = null;
    } else {
      const view = await this.buildNewTab();
      if (seq !== this.renderSeq) return;
      this.newTab = view;
    }
    this.browseDetailsLoading = false;
    this.newTabLoading = false;
    this.emit();
  }

  snapshotOf(key: string): Snapshot {
    return (
      this.snapshots.get(key) ?? { files: [], head: null, tracked: new Map(), peers: {}, bytes: 0 }
    );
  }

  // ------------------------------------------------------------------- tabs

  async activateNewTab(): Promise<void> {
    this.active = '';
    await this.render();
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
    path: string,
    children: VFSListEntry[],
  ): Promise<{ storeId: string } | null> {
    const control = children.find((c) => c.name === CONTROL_DIR && c.kind === 'directory');
    if (!control) return null;
    try {
      const raw = this.decoder.decode(await adapter.read(`${control.path}/config.json`));
      const config = JSON.parse(raw) as Partial<NodeConfig>;
      return { storeId: config.storeId ?? config.id ?? 'unknown' };
    } catch {
      return { storeId: 'unknown' };
    }
  }

  /** One level of the tree; expanded folders recurse, in display order. */
  private async collectBrowseRows(
    source: BrowseSource,
    dir: string,
    depth: number,
    out: BrowseRow[],
  ): Promise<void> {
    const adapter = source.adapter;
    if (!adapter) return;
    const entries = (await adapter.list(dir)).filter((entry) => entry.name !== CONTROL_DIR);
    entries.sort((a, b) =>
      a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === 'directory' ? -1 : 1,
    );
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        // One listing per folder gives both the child count and the `.vfs`
        // probe; a separate stat would double the requests on Drive.
        const children = await adapter.list(entry.path);
        const info = await this.readVfsInfo(adapter, entry.path, children);
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

    const stat = await adapter.stat(picked.path);
    if (!stat) {
      this.browseSel = null;
      return { kind: 'intro' };
    }
    if (stat.kind === 'file') {
      return {
        kind: 'file',
        path: picked.path,
        name: basename(picked.path) || picked.path,
        mime: mimeOf(picked.path),
        stat,
      };
    }
    // Shallow on purpose: one listing, not a recursive walk. On Drive every
    // level is a network round trip, so summing a whole subtree here made a
    // folder click fan out into dozens of requests. The same listing feeds the
    // `.vfs` probe, so a directory's details cost exactly one request.
    const children = await adapter.list(picked.path);
    const info = await this.readVfsInfo(adapter, picked.path, children);
    return {
      kind: 'directory',
      path: picked.path,
      name: basename(picked.path) || picked.path,
      count: children.filter((e) => e.name !== CONTROL_DIR).length,
      info,
    };
  }

  selectSource(source: BrowseSource): void {
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
    this.newTab = view;
    this.newTabLoading = false;
    this.browseDetailsLoading = false;
    this.emit();
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
    if (expanded) source.expanded.delete(path);
    else source.expanded.add(path);
    void this.render();
  }

  async newBrowseFolder(source: BrowseSource): Promise<void> {
    if (!source.adapter?.mkdir) return;
    // Create inside the current selection: a picked folder is the parent, a
    // picked file contributes its folder, and nothing selected means the root.
    const sel = this.browseSel?.source === source.key ? this.browseSel : null;
    const base = sel ? (sel.kind === 'directory' ? sel.path : dirname(sel.path)) : '';
    const where = base ? `${source.label} / ${base}` : source.label;
    const name = prompt(`New folder in ${where} (a / nests)`, 'new-folder');
    if (!name) return;
    try {
      const relative = normalizePath(name);
      if (!relative) return;
      const path = joinPath(base, relative);
      await source.adapter.mkdir(path);
      // reveal it: the base and every ancestor of the new folder unfold
      const segments = path.split('/');
      for (let i = 1; i < segments.length; i++) {
        source.expanded.add(segments.slice(0, i).join('/'));
      }
      this.log(`created folder ${path} on ${source.label}`, 'ok');
      await this.render();
      this.selectBrowse(source, path, 'directory');
    } catch (error) {
      this.log(String(error), 'warn');
    }
  }

  async deleteBrowseEntry(source: BrowseSource, path: string): Promise<void> {
    if (!source.adapter) return;
    if (!confirm(`Delete ${path} and everything inside it?`)) return;
    try {
      // a tab open on this folder (or inside it) would be left dangling
      for (const peer of this.peers.filter(
        (p) => p.key === `${source.key}:${path}` || p.key.startsWith(`${source.key}:${path}/`),
      )) {
        await this.closePeer(peer);
      }
      await source.adapter.delete(path);
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
    await this.render();
  }

  async removeSource(source: BrowseSource): Promise<void> {
    for (const peer of this.peers.filter((p) => p.key.startsWith(`${source.key}:`))) {
      await this.closePeer(peer);
    }
    const index = this.sources.indexOf(source);
    if (index !== -1) this.sources.splice(index, 1);
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
    try {
      const label = basename(path) || source.label;
      const adapter = path ? new ScopedAdapter(source.adapter, path, label) : source.adapter;
      const hasStore = await this.adapterHasStore(adapter);
      if (!hasStore && !initialise) {
        this.log(`${label} is not initialised as vFS`, 'warn');
        return;
      }
      const fresh = !hasStore && (await walk(adapter)).length === 0;
      const peer = await this.addPeer(key, label, adapter, source.backend, source.fsa);
      await this.maybeSeed(peer, fresh);
      this.log(hasStore ? `opened ${label}` : `initialised ${label} as vFS`, 'ok');
      await this.activate(peer);
    } catch (error) {
      this.log(String(error), 'warn');
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
      if (!hasStore && !confirm(`${label} holds no .vfs store yet. Initialise it as a vFS root?`)) {
        return;
      }
      const fresh = !hasStore && (await walk(adapter)).length === 0;
      const peer = await this.addPeer(`fsav:${++this.fsaSeq}`, label, adapter, 'local folder', adapter);
      await this.maybeSeed(peer, fresh);
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

  // ---------------------------------------------------------------- actions

  /**
   * Switching roots follows the current path when the other backend has it —
   * which is the whole point of the app: the same file, on another filesystem.
   */
  async activate(peer: Peer): Promise<void> {
    this.active = peer.key;
    if (peer.fsa && !(await peer.fsa.hasPermission())) {
      this.log(`${peer.label} needs its permission re-granted`, 'warn');
    }
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
      await this.render();
      return;
    }
    this.selection = { peer: peer.key, path: entry.path, kind: entry.kind };
    const token = ++this.detailToken;
    // Paint the row highlight straight away; the checksum arrives after.
    this.detailsLoading = !this.dirty;
    this.emit();
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
    const detail: Details = {
      peer: peer.key,
      path: current.path,
      kind: current.kind,
      stat: null,
      mime,
      hash: null,
      entry: snapshot.tracked.get(current.path),
      across: [],
      text: null,
      count: 0,
      bytes: 0,
    };

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

    detail.stat = await peer.adapter.stat(current.path);
    if (!detail.stat) return detail;

    detail.hash = await this.hashOf(peer, current.path, detail.stat.size);
    if (isTextMime(mime) && detail.stat.size <= EDIT_LIMIT) {
      detail.text = this.decoder.decode(await peer.node.read(current.path));
    }

    for (const other of this.peers) {
      if (other.key === peer.key) continue;
      detail.across.push(await this.compare(other, current.path, detail));
    }
    return detail;
  }

  private tag(peer: Peer): { key: string; label: string; backend: Backend } {
    return { key: peer.key, label: peer.label, backend: peer.backend };
  }

  private async compare(other: Peer, path: string, detail: Details): Promise<Across> {
    const stat = await other.adapter.stat(path);
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
    const hash = await this.hashOf(other, path, stat.size);
    if (hash === detail.hash) return { ...this.tag(other), state: 'same', detail: 'identical' };
    const newer = detail.stat && stat.mtime > detail.stat.mtime;
    return {
      ...this.tag(other),
      state: 'differs',
      detail: `${newer ? 'newer' : 'older'} · ${formatAgo(stat.mtime)}`,
    };
  }

  /** Small files hash from bytes; big ones stream so nothing is held whole. */
  private async hashOf(peer: Peer, path: string, size: number): Promise<Hash | null> {
    try {
      if (size > STREAM_HASH_OVER) return await sha256Stream(await peer.node.readStream(path));
      return await sha256(await peer.node.read(path));
    } catch {
      return null;
    }
  }

  async write(peer: Peer, path: string, text: string): Promise<void> {
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
    const name = prompt('File name (a / creates a folder)', 'untitled.md');
    if (!name) return;
    await peer.node.write(name, this.encoder.encode(''));
    this.log(`created ${name} on ${peer.label}`);
    await this.render();
    await this.select(peer, { path: name, kind: 'file' });
  }

  async renameFile(peer: Peer, path: string): Promise<void> {
    const name = prompt('Rename to', path);
    if (!name || name === path) return;
    // Goes through the node, not the adapter, so the rename is recorded as
    // intent and travels as a rename rather than as delete + create.
    await peer.node.rename(path, name);
    this.log(`renamed ${path} → ${name} on ${peer.label}`);
    await this.render();
    await this.select(peer, { path: name, kind: 'file' });
  }

  async deleteFile(peer: Peer, path: string): Promise<void> {
    if (!confirm(`Delete ${path} from ${peer.label}?`)) return;
    await peer.node.delete(path);
    this.log(`deleted ${path} on ${peer.label}`);
    await this.render();
    await this.select(peer, null);
  }

  // -------------------------------------------------------------------- sync

  setSyncTarget(key: string): void {
    this.syncTargetKey = key;
    this.emit();
  }

  /** Syncs the open root against the footer's target — or the whole chain. */
  async syncTarget(): Promise<void> {
    if (this.syncTargetKey === ALL_ROOTS || this.syncTargetKey === this.active) return this.syncAll();
    const a = this.activePeer();
    const b = this.peerOf(this.syncTargetKey);
    if (!a || !b || this.syncing) return;
    this.syncing = true;
    this.emit();
    try {
      const result = await sync(a.node, b.node);
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
        `${winner.peer ?? conflict.winner} has the newer version` +
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
}
