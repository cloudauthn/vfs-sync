import {
  FSAAdapter,
  MemoryAdapter,
  OPFSAdapter,
  VFSNode,
  isFSAAvailable,
  isOPFSAvailable,
  sha256,
  sha256Stream,
  sync,
  syncUntilStable,
  walk,
} from '../../src/index';
import type {
  ConflictReport,
  Hash,
  MeshEdge,
  NodeConfig,
  TreeEntry,
  VFSAdapter,
  VFSStat,
  WalkedFile,
} from '../../src/index';
import { formatAgo, formatBytes, formatSize, formatTime, iconOf, isTextMime, mimeOf } from './format';
import './explorer.css';

export type LogKind = 'info' | 'ok' | 'warn' | 'conflict';

export interface ExplorerOptions {
  /** OPFS directory the stored peers live in. Two hosts on one origin want two roots. */
  opfsRoot?: string;
  /** Written to the first root when it boots empty. `null` starts from nothing. */
  seed?: Record<string, string> | null;
  /** Interval the auto-sync switch runs at. */
  autoSyncMs?: number;
  /** Offer the tab that adds a folder from disk through the File System Access API. */
  localFolder?: boolean;
  /** Draw the footer's sync controls — target, sync, auto-sync, reset. */
  toolbar?: boolean;
  /** Offer the activity drawer the status bar opens. */
  activityLog?: boolean;
  /** Every log line, so a host page can mirror it somewhere of its own. */
  onLog?: (message: string, kind: LogKind) => void;
}

export interface ExplorerHandle {
  /** The root the app drew itself into. */
  readonly element: HTMLElement;
  /** Sync the open root against whatever the footer's target selector points at. */
  syncTarget(): Promise<void>;
  /** Sync every edge of the chain until it stops changing. */
  syncAll(): Promise<void>;
  /** Re-read every root and repaint. */
  refresh(): Promise<void>;
  /** Stop the auto-sync timer and empty the root element. */
  destroy(): void;
}

const DEFAULT_SEED: Record<string, string> = {
  'notes.md': '# Notes\n\nEdit me on any tab.\n',
  'todo.md': '- [ ] sync the chain\n',
  'docs/getting-started.md': 'Folders sync too.\n',
};

/** Above this the details pane streams the checksum instead of holding the file. */
const STREAM_HASH_OVER = 4 * 1024 * 1024;
/** Above this a file is not compared against the other roots byte for byte. */
const COMPARE_LIMIT = 8 * 1024 * 1024;
/** Above this the editor refuses to open a file, however text-like it is. */
const EDIT_LIMIT = 512 * 1024;
/** Sentinel target: sync the whole chain rather than one pair. */
const ALL_ROOTS = '*';

type Backend = 'OPFS' | 'memory' | 'local folder';

const BACKEND_ICON: Record<Backend, string> = {
  OPFS: '🗄',
  memory: '🧠',
  'local folder': '📁',
};

/** One line per backend, shown when a root is open with nothing selected. */
const BLURB: Record<Backend, string> = {
  OPFS:
    'Origin Private File System — private to this origin, survives reloads, ' +
    'and never prompts. The natural home for a background sync loop.',
  memory:
    'MemoryAdapter — paths to bytes in a Map. It is what the test-suite runs on, ' +
    'and it disappears when you reload.',
  'local folder':
    'File System Access API — a real folder on your disk. Permission is revoked ' +
    'on reload, so it has to be re-granted from a click.',
};

interface Peer {
  key: string;
  label: string;
  backend: Backend;
  adapter: VFSAdapter;
  node: VFSNode;
  /** Only the local-folder root, whose permission can lapse mid-session. */
  fsa?: FSAAdapter;
  /** Directories this root has folded away. */
  collapsed: Set<string>;
}

/** What one render pass needs to know about a root. */
interface Snapshot {
  files: WalkedFile[];
  head: Hash | null;
  /** Committed state, by path — what the last commit says about each file. */
  tracked: Map<string, TreeEntry>;
  peers: NodeConfig['peers'];
  bytes: number;
}

interface Selection {
  peer: string;
  path: string;
  kind: 'file' | 'directory';
}

/** How one other root compares on the selected path. */
interface Across {
  key: string;
  label: string;
  backend: Backend;
  state: 'same' | 'differs' | 'missing' | 'unknown';
  detail: string;
}

/** Everything the right-hand column shows about the current selection. */
interface Details {
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

/** A folder as the explorer draws it, rebuilt from the flat walk() listing. */
interface TreeDir {
  path: string;
  dirs: Map<string, TreeDir>;
  files: WalkedFile[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Draws the file explorer into `target` and boots it. Everything the app needs
 * lives inside that element and inside this closure, so a page can mount more
 * than one of them — give each its own `opfsRoot` and they sync nothing to
 * each other.
 */
export function mountExplorer(
  target: HTMLElement | string,
  options: ExplorerOptions = {},
): ExplorerHandle {
  const root = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!root) throw new Error(`vfs-sync explorer: no element matched ${String(target)}`);

  const opfsRoot = options.opfsRoot ?? 'vfs-sync-explorer';
  const seed = options.seed === undefined ? DEFAULT_SEED : options.seed;
  const autoSyncMs = options.autoSyncMs ?? 3000;
  const wantsLocalFolder = options.localFolder ?? true;
  const wantsControls = options.toolbar ?? true;
  const wantsLog = options.activityLog ?? true;

  const peers: Peer[] = [];
  let edges: MeshEdge[] = [];
  let active = '';
  let syncTargetKey = ALL_ROOTS;
  let selection: Selection | null = null;
  let details: Details | null = null;
  /** Bumped on every selection change; a stale async load drops its result. */
  let detailToken = 0;
  let autoTimer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  let lastSyncAt: number | null = null;
  let dirty = false;
  let logOpen = false;
  let logCount = 0;
  let lastMessage = 'ready';
  let lastKind: LogKind = 'info';

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // ------------------------------------------------------------------ chrome

  const shell = el('div', 'vfs-explorer');
  const tabsEl = el('div', 'vfs-tabs');
  const sidebarEl = el('div', 'vfs-sidebar');
  const detailsEl = el('div', 'vfs-details');
  const drawerEl = el('div', 'vfs-drawer');
  const footerEl = el('div', 'vfs-footer');
  const logList = el('ol');
  const controlsEl = el('div', 'vfs-controls');
  const targetSelect = el('select', 'vfs-target');
  const syncButton = el('button', 'vfs-primary', 'Sync');
  const autoSyncBox = el('input');

  tabsEl.setAttribute('role', 'tablist');
  autoSyncBox.type = 'checkbox';
  autoSyncBox.id = `vfs-auto-${Math.random().toString(36).slice(2, 8)}`;

  const body = el('div', 'vfs-body');
  body.append(sidebarEl, detailsEl);

  drawerEl.append(buildDrawer());
  drawerEl.hidden = true;
  buildControls();

  shell.append(tabsEl, body, drawerEl, footerEl);
  root.replaceChildren(shell);

  function buildDrawer(): HTMLElement {
    const head = el('div', 'vfs-drawer-head');
    const clear = el('button', 'vfs-ghost', 'Clear');
    clear.addEventListener('click', () => {
      logList.replaceChildren();
      logCount = 0;
      renderFooter();
    });
    const close = el('button', 'vfs-ghost', '×');
    close.title = 'Hide the activity log';
    close.addEventListener('click', () => toggleLog(false));
    const actions = el('div', 'vfs-drawer-actions');
    actions.append(clear, close);
    head.append(el('span', 'vfs-drawer-title', 'Activity'), actions);

    const panel = el('div', 'vfs-drawer-panel');
    panel.append(head, logList);
    return panel;
  }

  function toggleLog(open: boolean): void {
    logOpen = open && wantsLog;
    drawerEl.hidden = !logOpen;
    if (logOpen) logCount = 0;
    renderFooter();
  }

  // --------------------------------------------------------------- bootstrap

  async function addPeer(
    key: string,
    label: string,
    adapter: VFSAdapter,
    backend: Backend,
    fsa?: FSAAdapter,
  ): Promise<Peer> {
    const node = await VFSNode.open(adapter, { id: label });
    const peer: Peer = { key, label, backend, adapter, node, collapsed: new Set() };
    if (fsa) peer.fsa = fsa;
    peers.push(peer);
    edges = peers.slice(0, -1).map((p, i) => ({ a: p.node, b: (peers[i + 1] as Peer).node }));
    return peer;
  }

  /** Some sandboxes leave `getDirectory()` pending forever rather than reject. */
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

  /** OPFS when the browser allows it, an in-memory stand-in when it does not. */
  async function addStoredPeer(suffix: string): Promise<void> {
    const key = `store-${suffix}`;
    if (isOPFSAvailable()) {
      try {
        const label = `opfs-${suffix}`;
        const adapter = await withTimeout(
          OPFSAdapter.open({ path: `${opfsRoot}/${key}`, name: label }),
          3000,
        );
        await addPeer(key, label, adapter, 'OPFS');
        return;
      } catch {
        // storage blocked or stalled (private window, sandboxed iframe) — fall through
      }
    }
    const label = `mem-${suffix}`;
    await addPeer(key, label, new MemoryAdapter(label), 'memory');
  }

  async function boot(): Promise<void> {
    await addStoredPeer('a');
    await addStoredPeer('b');
    await addPeer('scratch', 'memory', new MemoryAdapter('memory'), 'memory');

    const first = peers[0] as Peer;
    active = first.key;
    syncTargetKey = (peers[1] as Peer).key;

    if (first.backend === 'memory') {
      log('OPFS is unavailable here, so every root runs on an in-memory adapter.', 'warn');
    }

    if (seed && (await walk(first.adapter)).length === 0) {
      for (const [path, text] of Object.entries(seed)) {
        await first.node.write(path, encoder.encode(text));
      }
      const count = Object.keys(seed).length;
      log(`seeded ${first.label} with ${count} file${count === 1 ? '' : 's'}`);
    }

    await render();
  }

  // ------------------------------------------------------------------ render

  function activePeer(): Peer | undefined {
    return peers.find((peer) => peer.key === active);
  }

  function peerOf(key: string | undefined): Peer | undefined {
    return peers.find((peer) => peer.key === key);
  }

  let snapshots = new Map<string, Snapshot>();

  async function readSnapshot(peer: Peer): Promise<Snapshot> {
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

  async function render(): Promise<void> {
    const next = new Map<string, Snapshot>();
    for (const peer of peers) next.set(peer.key, await readSnapshot(peer));
    snapshots = next;
    renderTabs();
    renderSidebar();
    renderDetails();
    renderFooter();
  }

  function snapshotOf(key: string): Snapshot {
    return snapshots.get(key) ?? { files: [], head: null, tracked: new Map(), peers: {}, bytes: 0 };
  }

  // ------------------------------------------------------------------- tabs

  function renderTabs(): void {
    tabsEl.replaceChildren();
    for (const peer of peers) tabsEl.append(tabButton(peer));
    const slot = localFolderTab();
    if (slot) tabsEl.append(slot);
  }

  function tabButton(peer: Peer): HTMLElement {
    const button = el('button', 'vfs-tab');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(peer.key === active));
    if (peer.key === active) button.classList.add('vfs-active');

    const snapshot = snapshotOf(peer.key);
    const count = snapshot.files.length;

    const title = el('span', 'vfs-tab-title');
    title.append(
      el('span', 'vfs-tab-icon', BACKEND_ICON[peer.backend]),
      el('span', 'vfs-tab-name', peer.label),
    );

    const meta = el(
      'span',
      'vfs-tab-meta',
      `${count} item${count === 1 ? '' : 's'} · ${formatBytes(snapshot.bytes)}`,
    );

    button.append(title, meta);
    button.title = `${peer.backend}${snapshot.head ? ` @ ${snapshot.head.slice(0, 7)}` : ''}`;
    button.addEventListener('click', () => void activate(peer));
    return button;
  }

  /** Placeholder tab that turns into a real root once a folder is granted. */
  function localFolderTab(): HTMLElement | null {
    if (!wantsLocalFolder) return null;
    if (peers.some((peer) => peer.backend === 'local folder')) return null;

    const button = el('button', 'vfs-tab vfs-add');
    button.append(el('span', 'vfs-tab-icon', '＋'), el('span', 'vfs-tab-name', 'Open folder'));

    if (!isFSAAvailable()) {
      button.disabled = true;
      button.title = 'This browser has no File System Access API';
      return button;
    }
    button.title = 'Open a folder from your disk as another root';
    button.addEventListener('click', () => void addLocalFolder());
    return button;
  }

  // ---------------------------------------------------------------- sidebar

  function renderSidebar(): void {
    sidebarEl.replaceChildren();
    const peer = activePeer();
    if (!peer) return;
    const snapshot = snapshotOf(peer.key);

    const head = el('div', 'vfs-sidebar-head');
    const crumbs = el('button', 'vfs-crumbs');
    crumbs.append(
      el('span', 'vfs-tab-icon', BACKEND_ICON[peer.backend]),
      el('span', undefined, peer.label),
    );
    crumbs.title = 'Show this root’s details';
    crumbs.addEventListener('click', () => void select(peer, null));

    const add = el('button', 'vfs-ghost', '＋ New');
    add.title = 'Create a file (a / in the name creates a folder)';
    add.addEventListener('click', () => void newFile(peer));

    head.append(crumbs, add);
    sidebarEl.append(head);

    const tree = el('ul', 'vfs-tree');
    tree.setAttribute('role', 'tree');
    if (snapshot.files.length === 0) {
      tree.append(el('li', 'vfs-empty', 'This folder is empty'));
    } else {
      renderDir(peer, buildTree(snapshot.files), 0, tree);
    }
    sidebarEl.append(tree);

    const foot = el('div', 'vfs-sidebar-foot');
    foot.append(
      el(
        'span',
        undefined,
        `${snapshot.files.length} item${snapshot.files.length === 1 ? '' : 's'}, ${formatBytes(snapshot.bytes)}`,
      ),
    );
    if (peer.fsa) {
      const grant = el('button', 'vfs-ghost', 'Re-grant');
      grant.title = 'Ask for permission on this folder again';
      grant.addEventListener('click', () => void regrant(peer));
      foot.append(grant);
    }
    sidebarEl.append(foot);
  }

  /** walk() returns a flat list; the explorer wants it back in folder shape. */
  function buildTree(files: WalkedFile[]): TreeDir {
    const treeRoot: TreeDir = { path: '', dirs: new Map(), files: [] };
    for (const file of files) {
      const segments = file.path.split('/');
      let dir = treeRoot;
      for (const segment of segments.slice(0, -1)) {
        const path = dir.path ? `${dir.path}/${segment}` : segment;
        let child = dir.dirs.get(segment);
        if (!child) {
          child = { path, dirs: new Map(), files: [] };
          dir.dirs.set(segment, child);
        }
        dir = child;
      }
      dir.files.push(file);
    }
    return treeRoot;
  }

  function rollup(dir: TreeDir): { count: number; bytes: number } {
    let count = dir.files.length;
    let bytes = dir.files.reduce((total, file) => total + file.stat.size, 0);
    for (const child of dir.dirs.values()) {
      const sub = rollup(child);
      count += sub.count;
      bytes += sub.bytes;
    }
    return { count, bytes };
  }

  function renderDir(peer: Peer, dir: TreeDir, depth: number, list: HTMLUListElement): void {
    for (const name of [...dir.dirs.keys()].sort()) {
      const child = dir.dirs.get(name) as TreeDir;
      const collapsed = peer.collapsed.has(child.path);
      list.append(dirRow(peer, name, child, depth, collapsed));
      if (!collapsed) renderDir(peer, child, depth + 1, list);
    }
    for (const file of dir.files) list.append(fileRow(peer, file, depth));
  }

  function markSelected(item: HTMLElement, path: string): void {
    if (selection?.peer === active && selection.path === path) {
      item.classList.add('vfs-selected');
      item.setAttribute('aria-selected', 'true');
    }
  }

  function dirRow(
    peer: Peer,
    name: string,
    dir: TreeDir,
    depth: number,
    collapsed: boolean,
  ): HTMLElement {
    const item = el('li', 'vfs-row vfs-dir');
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-expanded', String(!collapsed));
    markSelected(item, dir.path);

    const open = el('button', 'vfs-entry');
    open.style.paddingLeft = `${depth * 14 + 6}px`;
    const twisty = el('span', 'vfs-twisty', collapsed ? '▸' : '▾');
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDir(peer, dir.path, collapsed);
    });
    open.append(twisty, el('span', 'vfs-icon-cell', collapsed ? '📁' : '📂'));
    open.append(el('span', 'vfs-name', name));
    open.append(el('span', 'vfs-meta', `${rollup(dir).count}`));
    open.addEventListener('click', () => void select(peer, { path: dir.path, kind: 'directory' }));
    open.addEventListener('dblclick', () => toggleDir(peer, dir.path, collapsed));

    item.append(open);
    return item;
  }

  function toggleDir(peer: Peer, path: string, collapsed: boolean): void {
    if (collapsed) peer.collapsed.delete(path);
    else peer.collapsed.add(path);
    renderSidebar();
  }

  function fileRow(peer: Peer, file: WalkedFile, depth: number): HTMLElement {
    const item = el('li', 'vfs-row');
    item.setAttribute('role', 'treeitem');
    markSelected(item, file.path);
    if (file.path.includes('(conflict ')) item.classList.add('vfs-conflict');

    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const open = el('button', 'vfs-entry');
    open.style.paddingLeft = `${depth * 14 + 6}px`;
    open.title = file.path;
    open.append(
      el('span', 'vfs-twisty'),
      el('span', 'vfs-icon-cell', iconOf(mimeOf(file.path))),
      el('span', 'vfs-name', name),
      el('span', 'vfs-meta', formatBytes(file.stat.size)),
    );
    open.addEventListener('click', () => void select(peer, { path: file.path, kind: 'file' }));

    item.append(open);
    return item;
  }

  // ---------------------------------------------------------------- details

  function renderDetails(): void {
    // An unsaved edit owns the pane: repainting it here — an auto-sync tick,
    // say — would take the caret away mid-keystroke.
    if (dirty && detailsEl.contains(document.activeElement)) return;
    detailsEl.replaceChildren();
    const peer = activePeer();
    if (!peer) return;

    if (!details || details.peer !== peer.key) {
      detailsEl.append(rootDetails(peer));
      return;
    }
    detailsEl.append(detailsHead(peer, details));
    const scroll = el('div', 'vfs-details-body');
    if (details.kind === 'directory') scroll.append(...folderSections(details));
    else scroll.append(...fileSections(peer, details));
    detailsEl.append(scroll);
  }

  /** Shown when no file is picked: what this root is and where it stands. */
  function rootDetails(peer: Peer): HTMLElement {
    const snapshot = snapshotOf(peer.key);
    const wrap = el('div', 'vfs-details-inner');

    const head = el('div', 'vfs-details-head');
    const title = el('div', 'vfs-details-title');
    title.append(
      el('span', 'vfs-details-icon', BACKEND_ICON[peer.backend]),
      el('span', 'vfs-details-name', peer.label),
    );
    head.append(title);
    wrap.append(head);

    const scroll = el('div', 'vfs-details-body');
    scroll.append(el('p', 'vfs-blurb', BLURB[peer.backend]));
    scroll.append(
      section('Root', [
        ['Backend', peer.backend],
        ['Adapter name', peer.adapter.name],
        ['Items', String(snapshot.files.length)],
        ['Size', formatSize(snapshot.bytes)],
      ]),
    );
    scroll.append(
      section('Commit', [
        ['Head', snapshot.head ?? 'no commits yet'],
        ['Tracked files', String(snapshot.tracked.size)],
      ]),
    );

    const lines = Object.entries(snapshot.peers).map(
      ([id, info]) =>
        [id, `${formatAgo(info.lastSync)} @ ${info.head ? info.head.slice(0, 7) : '—'}`] as [
          string,
          string,
        ],
    );
    scroll.append(section('Sync history', lines.length ? lines : [['—', 'never synced']]));
    scroll.append(el('p', 'vfs-hint', 'Select a file on the left to inspect it.'));
    wrap.append(scroll);
    return wrap;
  }

  function detailsHead(peer: Peer, detail: Details): HTMLElement {
    const head = el('div', 'vfs-details-head');
    const name = detail.path.slice(detail.path.lastIndexOf('/') + 1);

    const title = el('div', 'vfs-details-title');
    title.append(
      el('span', 'vfs-details-icon', detail.kind === 'directory' ? '📂' : iconOf(detail.mime)),
      el('span', 'vfs-details-name', name),
    );
    title.title = `${peer.label} / ${detail.path}`;

    const actions = el('div', 'vfs-details-actions');
    if (detail.kind === 'file') {
      const rename = el('button', 'vfs-ghost', 'Rename');
      rename.addEventListener('click', () => void renameFile(peer, detail.path));
      const remove = el('button', 'vfs-ghost vfs-danger', 'Delete');
      remove.addEventListener('click', () => void deleteFile(peer, detail.path));
      actions.append(rename, remove);
    }

    head.append(title, actions);
    return head;
  }

  function section(title: string, rows: Array<[string, string]>): HTMLElement {
    const block = el('section', 'vfs-section');
    block.append(el('h3', undefined, title));
    const list = el('dl', 'vfs-props');
    for (const [key, value] of rows) {
      const term = el('dt', undefined, key);
      const def = el('dd', undefined, value);
      def.title = value;
      list.append(term, def);
    }
    block.append(list);
    return block;
  }

  function folderSections(detail: Details): HTMLElement[] {
    return [
      section('Folder', [
        ['Path', detail.path],
        ['Items', String(detail.count)],
        ['Size', formatSize(detail.bytes)],
      ]),
      acrossSection(detail),
    ];
  }

  function fileSections(peer: Peer, detail: Details): HTMLElement[] {
    const stat = detail.stat;
    const entry = detail.entry;
    const out: HTMLElement[] = [];

    out.push(
      section('File', [
        ['Path', detail.path],
        ['Kind', detail.mime],
        ['Size', stat ? formatSize(stat.size) : '—'],
        ['Modified', stat ? `${formatTime(stat.mtime)} (${formatAgo(stat.mtime)})` : '—'],
      ]),
    );

    const checksum = el('section', 'vfs-section');
    checksum.append(el('h3', undefined, 'Checksum'));
    const value = el('code', 'vfs-hash', detail.hash ?? 'computing…');
    value.title = detail.hash ?? '';
    checksum.append(value);
    checksum.append(
      el(
        'p',
        'vfs-hint',
        entry && entry.hash && detail.hash && entry.hash !== detail.hash
          ? 'SHA-256 of the file on disk — it differs from the committed blob, so this edit has not been committed yet.'
          : 'SHA-256 of the file on disk. It is the address the blob is stored under.',
      ),
    );
    out.push(checksum);

    out.push(
      section('Tracking', [
        ['State', entry ? (entry.hash === detail.hash ? 'committed' : 'modified') : 'untracked'],
        ['Entry id', entry?.id ?? '—'],
        ['Logical mtime', entry ? formatTime(entry.mtime) : '—'],
        ['Last edited by', entry?.peer ?? '—'],
        ['Renamed from', entry?.renamedFrom ?? '—'],
      ]),
    );

    out.push(acrossSection(detail));

    if (detail.text !== null) out.push(editorSection(peer, detail));
    else if (stat && stat.size > EDIT_LIMIT) {
      out.push(note(`Too large to open here (${formatBytes(stat.size)}).`));
    } else {
      out.push(note(`No text preview for ${detail.mime}.`));
    }

    return out;
  }

  /** The same path, as it stands on every other open root. */
  function acrossSection(detail: Details): HTMLElement {
    const block = el('section', 'vfs-section');
    block.append(el('h3', undefined, 'Across roots'));
    const list = el('ul', 'vfs-across');
    if (detail.across.length === 0) {
      list.append(el('li', 'vfs-hint', 'No other root is open.'));
    }
    for (const other of detail.across) {
      const item = el('li', `vfs-across-item vfs-state-${other.state}`);
      item.append(
        el('span', 'vfs-dot'),
        el('span', 'vfs-across-name', `${BACKEND_ICON[other.backend]} ${other.label}`),
        el('span', 'vfs-across-state', other.detail),
      );
      list.append(item);
    }
    block.append(list);
    return block;
  }

  function note(text: string): HTMLElement {
    const block = el('section', 'vfs-section');
    block.append(el('p', 'vfs-hint', text));
    return block;
  }

  function editorSection(peer: Peer, detail: Details): HTMLElement {
    const block = el('section', 'vfs-section vfs-editor');
    const head = el('div', 'vfs-editor-head');
    const save = el('button', 'vfs-primary', 'Save');
    save.disabled = !dirty;

    const area = el('textarea');
    area.spellcheck = false;
    area.value = detail.text ?? '';
    area.addEventListener('input', () => {
      dirty = true;
      save.disabled = false;
      if (details) details.text = area.value;
    });
    area.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        void write(peer, detail.path, area.value);
      }
    });
    save.addEventListener('click', () => void write(peer, detail.path, area.value));

    head.append(el('h3', undefined, 'Contents'), save);
    block.append(head, area);
    return block;
  }

  // ----------------------------------------------------------------- footer

  function renderFooter(): void {
    footerEl.replaceChildren();

    const status = el('div', 'vfs-status');
    const state = syncing ? 'busy' : lastKind === 'warn' ? 'warn' : 'ok';
    status.append(el('span', `vfs-dot vfs-dot-${state}`));

    const peer = activePeer();
    const snapshot = peer ? snapshotOf(peer.key) : null;
    const bits = [
      syncing ? 'syncing…' : lastMessage,
      peer ? `${peer.label} · ${peer.backend}` : 'no root',
      snapshot?.head ? `@ ${snapshot.head.slice(0, 7)}` : 'no commits',
      lastSyncAt ? `synced ${formatAgo(lastSyncAt)}` : 'not synced yet',
    ];
    status.append(el('span', 'vfs-status-text', bits[0] as string));
    for (const bit of bits.slice(1)) status.append(el('span', 'vfs-status-bit', bit));

    if (wantsLog) {
      const toggle = el('button', 'vfs-ghost', `Activity${logCount ? ` (${logCount})` : ''}`);
      toggle.setAttribute('aria-expanded', String(logOpen));
      toggle.addEventListener('click', () => toggleLog(!logOpen));
      status.append(toggle);
    }

    footerEl.append(status);
    if (wantsControls) {
      updateControls();
      footerEl.append(controlsEl);
    }
  }

  /**
   * Built once and kept: the footer repaints on every log line, and rebuilding
   * a <select> under the pointer would shut the open dropdown.
   */
  function buildControls(): void {
    targetSelect.title = 'Which root to sync the open one against';
    targetSelect.addEventListener('change', () => {
      syncTargetKey = targetSelect.value;
      renderFooter();
    });

    syncButton.addEventListener('click', () => void syncTarget());

    const label = el('label', 'vfs-switch');
    label.htmlFor = autoSyncBox.id;
    label.append(autoSyncBox, el('span', undefined, `Auto ${autoSyncMs / 1000}s`));
    autoSyncBox.addEventListener('change', () => setAutoSync(autoSyncBox.checked));

    const reset = el('button', 'vfs-ghost vfs-danger', 'Reset');
    reset.title = 'Delete every folder this explorer owns and start over';
    reset.addEventListener('click', () => void reset$());

    controlsEl.append(
      el('span', 'vfs-controls-label', 'Sync with'),
      targetSelect,
      syncButton,
      label,
      reset,
    );
  }

  /** Option list for the target selector — every open root except this one. */
  function targetSignature(): string {
    return `${active}|${peers.map((peer) => `${peer.key}:${peer.label}`).join(',')}`;
  }

  let renderedTargets = '';

  function updateControls(): void {
    const signature = targetSignature();
    if (signature !== renderedTargets) {
      renderedTargets = signature;
      targetSelect.replaceChildren();
      const all = el('option', undefined, 'All roots (chain)');
      all.value = ALL_ROOTS;
      targetSelect.append(all);
      for (const peer of peers) {
        if (peer.key === active) continue;
        const option = el('option', undefined, `${BACKEND_ICON[peer.backend]} ${peer.label}`);
        option.value = peer.key;
        targetSelect.append(option);
      }
    }
    if (syncTargetKey !== ALL_ROOTS && !peers.some((peer) => peer.key === syncTargetKey)) {
      syncTargetKey = ALL_ROOTS;
    }
    // The open root cannot sync with itself; fall back to the whole chain.
    targetSelect.value = syncTargetKey === active ? ALL_ROOTS : syncTargetKey;
    syncButton.disabled = syncing || peers.length < 2;
    syncButton.textContent = syncing ? 'Syncing…' : 'Sync';
  }

  // ---------------------------------------------------------------- actions

  /**
   * Switching roots follows the current path when the other backend has it —
   * which is the whole point of the app: the same file, on another filesystem.
   */
  async function activate(peer: Peer): Promise<void> {
    active = peer.key;
    if (peer.fsa && !(await peer.fsa.hasPermission())) {
      log(`${peer.label} needs its permission re-granted`, 'warn');
    }
    const path = selection?.path;
    const stat = path ? await peer.adapter.stat(path) : null;
    if (path && stat) await select(peer, { path, kind: stat.kind === 'directory' ? 'directory' : 'file' });
    else await select(peer, null);
  }

  /** Picks a path (or the root itself when `entry` is null) and repaints. */
  async function select(
    peer: Peer,
    entry: { path: string; kind: 'file' | 'directory' } | null,
  ): Promise<void> {
    active = peer.key;
    // Re-selecting the file being edited (after a sync, say) keeps the buffer.
    const unsaved =
      dirty && details && details.peer === peer.key && details.path === entry?.path
        ? details.text
        : null;
    dirty = unsaved !== null;

    if (!entry) {
      selection = null;
      details = null;
      detailToken++;
      await render();
      return;
    }
    selection = { peer: peer.key, path: entry.path, kind: entry.kind };
    const token = ++detailToken;
    // Paint the row highlight straight away; the checksum arrives after.
    renderTabs();
    renderSidebar();
    if (!dirty) detailsEl.replaceChildren(el('div', 'vfs-details-inner', 'Reading…'));
    const loaded = await loadDetails(peer, selection);
    if (token !== detailToken) return;
    if (unsaved !== null) loaded.text = unsaved;
    details = loaded;
    renderDetails();
    renderFooter();
  }

  async function loadDetails(peer: Peer, current: Selection): Promise<Details> {
    const snapshot = snapshotOf(peer.key);
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
      detail.across = peers
        .filter((other) => other.key !== peer.key)
        .map((other) => {
          const files = snapshotOf(other.key).files.filter((file) =>
            file.path.startsWith(`${current.path}/`),
          );
          if (files.length === 0) {
            return { ...tag(other), state: 'missing' as const, detail: 'not here' };
          }
          const same = files.length === inside.length;
          return {
            ...tag(other),
            state: same ? ('same' as const) : ('differs' as const),
            detail: `${files.length} item${files.length === 1 ? '' : 's'}`,
          };
        });
      return detail;
    }

    detail.stat = await peer.adapter.stat(current.path);
    if (!detail.stat) return detail;

    detail.hash = await hashOf(peer, current.path, detail.stat.size);
    if (isTextMime(mime) && detail.stat.size <= EDIT_LIMIT) {
      detail.text = decoder.decode(await peer.node.read(current.path));
    }

    for (const other of peers) {
      if (other.key === peer.key) continue;
      detail.across.push(await compare(other, current.path, detail));
    }
    return detail;
  }

  function tag(peer: Peer): { key: string; label: string; backend: Backend } {
    return { key: peer.key, label: peer.label, backend: peer.backend };
  }

  async function compare(other: Peer, path: string, detail: Details): Promise<Across> {
    const stat = await other.adapter.stat(path);
    if (!stat || stat.kind !== 'file') {
      return { ...tag(other), state: 'missing', detail: 'not here' };
    }
    if (stat.size > COMPARE_LIMIT || detail.hash === null) {
      const same = stat.size === detail.stat?.size;
      return {
        ...tag(other),
        state: 'unknown',
        detail: same ? `same size, ${formatAgo(stat.mtime)}` : formatBytes(stat.size),
      };
    }
    const hash = await hashOf(other, path, stat.size);
    if (hash === detail.hash) return { ...tag(other), state: 'same', detail: 'identical' };
    const newer = detail.stat && stat.mtime > detail.stat.mtime;
    return {
      ...tag(other),
      state: 'differs',
      detail: `${newer ? 'newer' : 'older'} · ${formatAgo(stat.mtime)}`,
    };
  }

  /** Small files hash from bytes; big ones stream so nothing is held whole. */
  async function hashOf(peer: Peer, path: string, size: number): Promise<Hash | null> {
    try {
      if (size > STREAM_HASH_OVER) return await sha256Stream(await peer.node.readStream(path));
      return await sha256(await peer.node.read(path));
    } catch {
      return null;
    }
  }

  async function write(peer: Peer, path: string, text: string): Promise<void> {
    await peer.node.write(path, encoder.encode(text));
    dirty = false;
    log(`saved ${path} on ${peer.label}`, 'ok');
    await render();
    await select(peer, { path, kind: 'file' });
  }

  async function newFile(peer: Peer): Promise<void> {
    const name = prompt('File name (a / creates a folder)', 'untitled.md');
    if (!name) return;
    await peer.node.write(name, encoder.encode(''));
    log(`created ${name} on ${peer.label}`);
    await render();
    await select(peer, { path: name, kind: 'file' });
  }

  async function renameFile(peer: Peer, path: string): Promise<void> {
    const name = prompt('Rename to', path);
    if (!name || name === path) return;
    // Goes through the node, not the adapter, so the rename is recorded as
    // intent and travels as a rename rather than as delete + create.
    await peer.node.rename(path, name);
    log(`renamed ${path} → ${name} on ${peer.label}`);
    await render();
    await select(peer, { path: name, kind: 'file' });
  }

  async function deleteFile(peer: Peer, path: string): Promise<void> {
    if (!confirm(`Delete ${path} from ${peer.label}?`)) return;
    await peer.node.delete(path);
    log(`deleted ${path} on ${peer.label}`);
    await render();
    await select(peer, null);
  }

  // -------------------------------------------------------------------- sync

  /** Syncs the open root against the footer's target — or the whole chain. */
  async function syncTarget(): Promise<void> {
    if (syncTargetKey === ALL_ROOTS || syncTargetKey === active) return syncAll();
    const a = activePeer();
    const b = peerOf(syncTargetKey);
    if (!a || !b || syncing) return;
    syncing = true;
    renderFooter();
    try {
      const result = await sync(a.node, b.node);
      const moved = result.transferred.toA + result.transferred.toB;
      if (!result.changed) log(`${a.label} ⇄ ${b.label}: already in sync`);
      else log(`${a.label} ⇄ ${b.label}: merged, ${moved} blob(s) moved`, 'ok');
      for (const conflict of result.conflicts) logConflict(conflict);
      lastSyncAt = Date.now();
    } catch (error) {
      log(String(error), 'warn');
    } finally {
      syncing = false;
      await reselect();
    }
  }

  async function syncAll(): Promise<void> {
    if (syncing || edges.length === 0) return;
    syncing = true;
    renderFooter();
    try {
      const rounds = await syncUntilStable(edges);
      const changed = rounds.flat().filter((r) => r.result.changed);
      const conflicts = rounds.flat().flatMap((r) => r.result.conflicts);
      if (changed.length === 0) log('every root already in sync');
      else log(`converged in ${rounds.length} round(s), ${changed.length} edge update(s)`, 'ok');
      for (const conflict of conflicts) logConflict(conflict);
      lastSyncAt = Date.now();
    } catch (error) {
      log(String(error), 'warn');
    } finally {
      syncing = false;
      await reselect();
    }
  }

  function logConflict(conflict: ConflictReport): void {
    const winner = conflict.winner === 'a' ? conflict.a : conflict.b;
    log(
      `conflict on ${conflict.path} (${conflict.kind}) — ` +
        `${winner.peer ?? conflict.winner} has the newer version` +
        (conflict.copy ? `, kept ${conflict.copy.path}` : ''),
      'conflict',
    );
  }

  /** A sync may have rewritten or removed whatever was selected. */
  async function reselect(): Promise<void> {
    await render();
    const peer = peerOf(selection?.peer);
    if (!selection || !peer) return;
    const stat = await peer.adapter.stat(selection.path);
    if (!stat) await select(peer, null);
    else await select(peer, { path: selection.path, kind: selection.kind });
  }

  function setAutoSync(on: boolean): void {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = on ? setInterval(() => void syncTarget(), autoSyncMs) : undefined;
    autoSyncBox.checked = on;
  }

  // ------------------------------------------------------------------ extras

  async function addLocalFolder(): Promise<void> {
    try {
      const adapter = await FSAAdapter.pick();
      if (!(await adapter.ensurePermission())) {
        log('permission denied for that folder', 'warn');
        return;
      }
      const label = adapter.name || 'local';
      const peer = await addPeer(`local-${peers.length}`, label, adapter, 'local folder', adapter);
      log(`opened ${label} as another root`, 'ok');
      await activate(peer);
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') log(String(error), 'warn');
    }
  }

  async function regrant(peer: Peer): Promise<void> {
    if (!peer.fsa) return;
    if (await peer.fsa.ensurePermission()) log(`${peer.label} is readable again`, 'ok');
    else log(`permission denied for ${peer.label}`, 'warn');
    await render();
  }

  /**
   * Starts over in place. An embedded app cannot reload the host page, so it
   * drops the OPFS folder and boots a fresh chain into the same element.
   */
  async function reset$(): Promise<void> {
    if (!confirm('Delete every folder this explorer owns and start over?')) return;
    if (isOPFSAvailable()) {
      try {
        const dir = await navigator.storage.getDirectory();
        await dir.removeEntry(opfsRoot, { recursive: true });
      } catch {
        // nothing to remove
      }
    }
    peers.length = 0;
    edges = [];
    active = '';
    selection = null;
    details = null;
    lastSyncAt = null;
    setAutoSync(false);
    tabsEl.replaceChildren();
    sidebarEl.replaceChildren();
    detailsEl.replaceChildren();
    log('reset', 'ok');
    await boot();
  }

  function log(message: string, kind: LogKind = 'info'): void {
    options.onLog?.(message, kind);
    lastMessage = message;
    lastKind = kind;
    if (!logOpen) logCount++;
    const item = el('li', `vfs-${kind}`);
    item.append(
      el('time', undefined, new Date().toLocaleTimeString()),
      el('span', undefined, message),
    );
    logList.prepend(item);
    while (logList.childElementCount > 100) logList.lastElementChild?.remove();
    renderFooter();
  }

  renderFooter();
  void boot();

  return {
    element: shell,
    syncTarget,
    syncAll,
    refresh: render,
    destroy(): void {
      setAutoSync(false);
      root.replaceChildren();
    },
  };
}
