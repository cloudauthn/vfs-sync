import {
  FSAAdapter,
  MemoryAdapter,
  OPFSAdapter,
  VFSNode,
  isFSAAvailable,
  isOPFSAvailable,
  sync,
  syncUntilStable,
  walk,
} from '../../src/index';
import type { ConflictReport, Hash, MeshEdge, VFSAdapter, WalkedFile } from '../../src/index';
import './explorer.css';

export type LogKind = 'info' | 'ok' | 'warn' | 'conflict';

export interface ExplorerOptions {
  /** OPFS directory the stored peers live in. Two hosts on one origin want two roots. */
  opfsRoot?: string;
  /** Written to the first peer when it boots empty. `null` starts from nothing. */
  seed?: Record<string, string> | null;
  /** Interval the auto-sync switch runs at. */
  autoSyncMs?: number;
  /** Offer the tab that adds a folder from disk through the File System Access API. */
  localFolder?: boolean;
  /** Draw the sync / auto-sync / reset bar. Turn it off to drive the app from the host. */
  toolbar?: boolean;
  /** Draw the activity log next to the editor. */
  activityLog?: boolean;
  /** Every log line, so a host page can mirror it somewhere of its own. */
  onLog?: (message: string, kind: LogKind) => void;
}

export interface ExplorerHandle {
  /** The root the app drew itself into. */
  readonly element: HTMLElement;
  /** Sync every edge of the chain until it stops changing. */
  syncAll(): Promise<void>;
  /** Re-read every peer and repaint. */
  refresh(): Promise<void>;
  /** Stop the auto-sync timer and empty the root. */
  destroy(): void;
}

const DEFAULT_SEED: Record<string, string> = {
  'notes.md': '# Notes\n\nEdit me on any tab.\n',
  'todo.md': '- [ ] sync the chain\n',
  'docs/getting-started.md': 'Folders sync too.\n',
};

type Backend = 'OPFS' | 'memory' | 'local folder';

/** One line per backend, shown above that tab's file tree. */
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
  /** Only the local-folder peer, whose permission can lapse mid-session. */
  fsa?: FSAAdapter;
  /** Directories this tab has folded away. */
  collapsed: Set<string>;
}

/** What one render pass needs to know about a peer. */
interface Snapshot {
  files: WalkedFile[];
  head: Hash | null;
}

interface Selection {
  peer: string;
  path: string;
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

  const peers: Peer[] = [];
  let edges: MeshEdge[] = [];
  let active = '';
  let selection: Selection | null = null;
  let autoTimer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // ------------------------------------------------------------------ chrome

  const shell = el('div', 'vfs-explorer');
  const tabsEl = el('div', 'vfs-tabs');
  const panelEl = el('div', 'vfs-panel');
  const logList = el('ol');
  const contentEl = el('textarea');
  const editorTitle = el('span', 'vfs-editor-title');
  const saveButton = el('button', 'vfs-primary', 'Save');
  const autoSyncBox = el('input');

  tabsEl.setAttribute('role', 'tablist');
  panelEl.setAttribute('role', 'tabpanel');
  contentEl.spellcheck = false;
  contentEl.placeholder = 'No file selected';
  autoSyncBox.type = 'checkbox';

  if (options.toolbar ?? true) shell.append(buildToolbar());

  const main = el('div', 'vfs-main');
  main.append(tabsEl, panelEl);
  shell.append(main);

  const workbench = el('div', 'vfs-workbench');
  workbench.append(buildEditor());
  if (options.activityLog ?? true) workbench.append(buildLog());
  else workbench.classList.add('vfs-single');
  shell.append(workbench);

  root.replaceChildren(shell);

  function buildToolbar(): HTMLElement {
    const bar = el('div', 'vfs-toolbar');

    const syncButton = el('button', 'vfs-primary', 'Sync the whole chain');
    syncButton.addEventListener('click', () => void syncAll());

    const label = el('label', 'vfs-switch');
    label.append(autoSyncBox, el('span', undefined, `Auto-sync every ${autoSyncMs / 1000}s`));
    autoSyncBox.addEventListener('change', () => setAutoSync(autoSyncBox.checked));

    const resetButton = el('button', 'vfs-danger', 'Reset');
    resetButton.addEventListener('click', () => void reset());

    bar.append(syncButton, label, resetButton);
    return bar;
  }

  function buildEditor(): HTMLElement {
    const editor = el('div', 'vfs-editor');
    const head = el('div', 'vfs-editor-head');
    saveButton.disabled = true;
    saveButton.addEventListener('click', () => void save());
    head.append(editorTitle, saveButton);
    editor.append(head, contentEl);
    return editor;
  }

  function buildLog(): HTMLElement {
    const panel = el('div', 'vfs-log');
    const head = el('div', 'vfs-log-head');
    const clear = el('button', undefined, 'Clear');
    clear.addEventListener('click', () => logList.replaceChildren());
    head.append(el('span', undefined, 'Activity'), clear);
    panel.append(head, logList);
    return panel;
  }

  contentEl.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      void save();
    }
  });

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

  /** OPFS when the browser allows it, an in-memory stand-in when it does not. */
  async function addStoredPeer(suffix: string): Promise<void> {
    const key = `store-${suffix}`;
    if (isOPFSAvailable()) {
      try {
        const label = `opfs-${suffix}`;
        const adapter = await OPFSAdapter.open({ path: `${opfsRoot}/${key}`, name: label });
        await addPeer(key, label, adapter, 'OPFS');
        return;
      } catch {
        // storage blocked (private window, sandboxed iframe) — fall through
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

    if (first.backend === 'memory') {
      log('OPFS is unavailable here, so every tab runs on an in-memory adapter.', 'warn');
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

  async function render(): Promise<void> {
    const snapshots = new Map<string, Snapshot>();
    for (const peer of peers) {
      snapshots.set(peer.key, { files: await walk(peer.adapter), head: await peer.node.head() });
    }
    renderTabs(snapshots);
    renderPanel(snapshots);
  }

  function renderTabs(snapshots: Map<string, Snapshot>): void {
    tabsEl.replaceChildren();
    for (const [index, peer] of peers.entries()) {
      if (index > 0) tabsEl.append(edgeButton(index - 1));
      tabsEl.append(tabButton(peer, snapshots.get(peer.key)));
    }
    const slot = localFolderTab();
    if (slot) tabsEl.append(slot);
  }

  function tabButton(peer: Peer, snapshot: Snapshot | undefined): HTMLElement {
    const button = el('button', 'vfs-tab');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(peer.key === active));
    if (peer.key === active) button.classList.add('vfs-active');

    const count = snapshot?.files.length ?? 0;
    const head = snapshot?.head;
    const meta = el('span', 'vfs-tab-meta');
    meta.append(
      el('span', 'vfs-badge', peer.backend),
      el(
        'span',
        'vfs-commit',
        `${count} file${count === 1 ? '' : 's'}${head ? ` @ ${head.slice(0, 7)}` : ''}`,
      ),
    );

    button.append(el('span', 'vfs-tab-name', peer.label), meta);
    button.addEventListener('click', () => void activate(peer));
    return button;
  }

  /** The edge between two adjacent tabs — clicking it syncs just that pair. */
  function edgeButton(index: number): HTMLElement {
    const button = el('button', 'vfs-edge', '⇄');
    button.title = `Sync ${(peers[index] as Peer).label} ⇄ ${(peers[index + 1] as Peer).label}`;
    button.addEventListener('click', () => void syncEdge(index));
    return button;
  }

  /** Placeholder tab that turns into a real peer once a folder is granted. */
  function localFolderTab(): HTMLElement | null {
    if (!wantsLocalFolder) return null;
    if (peers.some((peer) => peer.backend === 'local folder')) return null;

    const button = el('button', 'vfs-tab vfs-add');
    const meta = el('span', 'vfs-tab-meta');
    meta.append(el('span', 'vfs-badge', 'local folder'));
    button.append(el('span', 'vfs-tab-name', '+ pick a folder'), meta);

    if (!isFSAAvailable()) {
      button.disabled = true;
      button.title = 'This browser has no File System Access API';
      return button;
    }
    button.title = 'Add a folder from your disk as a fourth peer';
    button.addEventListener('click', () => void addLocalFolder());
    return button;
  }

  function renderPanel(snapshots: Map<string, Snapshot>): void {
    const peer = activePeer();
    panelEl.replaceChildren();
    if (!peer) return;
    const snapshot = snapshots.get(peer.key) ?? { files: [], head: null };

    const head = el('div', 'vfs-panel-head');
    const heading = el('div');
    heading.append(el('h2', undefined, peer.label), el('p', 'vfs-blurb', BLURB[peer.backend]));
    const commit = el(
      'span',
      'vfs-commit',
      snapshot.head ? `@ ${snapshot.head.slice(0, 7)}` : 'no commits',
    );
    commit.title = snapshot.head ?? '';
    head.append(heading, commit);
    panelEl.append(head);

    const tree = el('ul', 'vfs-tree');
    if (snapshot.files.length === 0) {
      tree.append(el('li', 'vfs-empty', 'empty folder'));
    } else {
      renderDir(peer, buildTree(snapshot.files), 0, tree);
    }
    panelEl.append(tree);

    const actions = el('div', 'vfs-panel-actions');
    const add = el('button', undefined, '+ new file');
    add.addEventListener('click', () => void newFile(peer));
    actions.append(add);

    if (peer.fsa) {
      const grant = el('button', undefined, 're-grant access');
      grant.addEventListener('click', () => void regrant(peer));
      actions.append(grant);
    }

    actions.append(el('span', 'vfs-hint', 'name a file docs/readme.md to put it in a folder'));
    panelEl.append(actions);
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

  function countFiles(dir: TreeDir): number {
    let total = dir.files.length;
    for (const child of dir.dirs.values()) total += countFiles(child);
    return total;
  }

  function renderDir(peer: Peer, dir: TreeDir, depth: number, list: HTMLUListElement): void {
    const names = [...dir.dirs.keys()].sort();
    for (const name of names) {
      const child = dir.dirs.get(name) as TreeDir;
      const collapsed = peer.collapsed.has(child.path);
      list.append(dirRow(peer, name, child, depth, collapsed));
      if (!collapsed) renderDir(peer, child, depth + 1, list);
    }
    for (const file of dir.files) list.append(fileRow(peer, file, depth));
  }

  function indent(row: HTMLElement, depth: number): void {
    row.style.paddingLeft = `${depth * 16}px`;
  }

  function dirRow(
    peer: Peer,
    name: string,
    dir: TreeDir,
    depth: number,
    collapsed: boolean,
  ): HTMLElement {
    const item = el('li', 'vfs-row vfs-dir');
    indent(item, depth);

    const hidden = countFiles(dir);
    const toggle = el('button', 'vfs-file');
    toggle.append(
      el('span', 'vfs-name', `${collapsed ? '▸' : '▾'} ${name}/`),
      el('span', 'vfs-size', collapsed ? `${hidden} file${hidden === 1 ? '' : 's'}` : ''),
    );
    toggle.addEventListener('click', () => {
      if (collapsed) peer.collapsed.delete(dir.path);
      else peer.collapsed.add(dir.path);
      void render();
    });

    item.append(toggle);
    return item;
  }

  function fileRow(peer: Peer, file: WalkedFile, depth: number): HTMLElement {
    const item = el('li', 'vfs-row');
    indent(item, depth);
    if (selection?.peer === peer.key && selection.path === file.path) {
      item.classList.add('vfs-selected');
    }
    if (file.path.includes('(conflict ')) item.classList.add('vfs-conflict');

    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const open = el('button', 'vfs-file');
    open.title = file.path;
    open.append(el('span', 'vfs-name', name), el('span', 'vfs-size', `${file.stat.size} B`));
    open.addEventListener('click', () => void openFile(peer, file.path));

    const rename = el('button', 'vfs-icon', '✎');
    rename.title = 'Rename';
    rename.addEventListener('click', () => void renameFile(peer, file.path));

    const remove = el('button', 'vfs-icon', '×');
    remove.title = 'Delete';
    remove.addEventListener('click', () => void deleteFile(peer, file.path));

    item.append(open, rename, remove);
    return item;
  }

  // ----------------------------------------------------------------- actions

  /**
   * Switching tabs follows the current file when the other backend has it —
   * which is the whole point of the app: the same path, on another filesystem.
   */
  async function activate(peer: Peer): Promise<void> {
    active = peer.key;
    if (peer.fsa && !(await peer.fsa.hasPermission())) {
      log(`${peer.label} needs its permission re-granted`, 'warn');
    }
    const path = selection?.path;
    if (path && (await peer.adapter.stat(path))?.kind === 'file') await load(peer, path);
    else clearSelection();
    await render();
  }

  async function openFile(peer: Peer, path: string): Promise<void> {
    await load(peer, path);
    await render();
  }

  async function load(peer: Peer, path: string): Promise<void> {
    selection = { peer: peer.key, path };
    contentEl.value = decoder.decode(await peer.node.read(path));
    contentEl.disabled = false;
    saveButton.disabled = false;
    editorTitle.textContent = `${peer.label} / ${path}`;
  }

  async function save(): Promise<void> {
    const peer = peers.find((p) => p.key === selection?.peer);
    if (!selection || !peer) return;
    await peer.node.write(selection.path, encoder.encode(contentEl.value));
    log(`saved ${selection.path} on ${peer.label}`);
    await render();
  }

  async function newFile(peer: Peer): Promise<void> {
    const name = prompt('File name (a / creates a folder)', 'untitled.md');
    if (!name) return;
    await peer.node.write(name, encoder.encode(''));
    log(`created ${name} on ${peer.label}`);
    await openFile(peer, name);
  }

  async function renameFile(peer: Peer, path: string): Promise<void> {
    const name = prompt('Rename to', path);
    if (!name || name === path) return;
    // Goes through the node, not the adapter, so the rename is recorded as
    // intent and travels as a rename rather than as delete + create.
    await peer.node.rename(path, name);
    log(`renamed ${path} → ${name} on ${peer.label}`);
    if (selection?.peer === peer.key && selection.path === path) {
      selection = { peer: peer.key, path: name };
    }
    await render();
  }

  async function deleteFile(peer: Peer, path: string): Promise<void> {
    await peer.node.delete(path);
    if (selection?.peer === peer.key && selection.path === path) clearSelection();
    log(`deleted ${path} on ${peer.label}`);
    await render();
  }

  function clearSelection(): void {
    selection = null;
    contentEl.value = '';
    contentEl.disabled = true;
    saveButton.disabled = true;
    editorTitle.textContent = 'Select a file to edit';
  }

  // -------------------------------------------------------------------- sync

  async function syncEdge(index: number): Promise<void> {
    const edge = edges[index];
    if (!edge || syncing) return;
    syncing = true;
    try {
      const result = await sync(edge.a, edge.b);
      report(`${edge.a.name} ⇄ ${edge.b.name}`, result.changed, result.conflicts, result.transferred);
    } catch (error) {
      log(String(error), 'warn');
    } finally {
      syncing = false;
      await refreshSelection();
      await render();
    }
  }

  async function syncAll(): Promise<void> {
    if (syncing || edges.length === 0) return;
    syncing = true;
    try {
      const rounds = await syncUntilStable(edges);
      const changed = rounds.flat().filter((r) => r.result.changed);
      const conflicts = rounds.flat().flatMap((r) => r.result.conflicts);
      if (changed.length === 0) {
        log('already in sync');
      } else {
        log(`converged in ${rounds.length} round(s), ${changed.length} edge update(s)`, 'ok');
      }
      for (const conflict of conflicts) logConflict(conflict);
    } catch (error) {
      log(String(error), 'warn');
    } finally {
      syncing = false;
      await refreshSelection();
      await render();
    }
  }

  function report(
    edge: string,
    changed: boolean,
    conflicts: ConflictReport[],
    transferred: { toA: number; toB: number },
  ): void {
    if (!changed) {
      log(`${edge}: nothing to do`);
      return;
    }
    log(`${edge}: merged (${transferred.toA + transferred.toB} blob(s) moved)`, 'ok');
    for (const conflict of conflicts) logConflict(conflict);
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

  /** The selected file may have been rewritten or removed by a sync. */
  async function refreshSelection(): Promise<void> {
    const peer = peers.find((p) => p.key === selection?.peer);
    if (!selection || !peer) return;
    const stat = await peer.adapter.stat(selection.path);
    if (!stat) return clearSelection();
    contentEl.value = decoder.decode(await peer.node.read(selection.path));
  }

  function setAutoSync(on: boolean): void {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = on ? setInterval(() => void syncAll(), autoSyncMs) : undefined;
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
      log(`added ${label} as a peer at the end of the chain`, 'ok');
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
  async function reset(): Promise<void> {
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
    clearSelection();
    tabsEl.replaceChildren();
    panelEl.replaceChildren();
    log('reset', 'ok');
    await boot();
  }

  function log(message: string, kind: LogKind = 'info'): void {
    options.onLog?.(message, kind);
    const item = el('li', `vfs-${kind}`);
    item.append(el('time', undefined, new Date().toLocaleTimeString()), el('span', undefined, message));
    logList.prepend(item);
    while (logList.childElementCount > 100) logList.lastElementChild?.remove();
  }

  clearSelection();
  void boot();

  return {
    element: shell,
    syncAll,
    refresh: render,
    destroy(): void {
      setAutoSync(false);
      root.replaceChildren();
    },
  };
}
