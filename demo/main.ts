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
} from '../src/index';
import type { ConflictReport, MeshEdge, VFSAdapter } from '../src/index';

const OPFS_ROOT = 'vfs-sync-demo';

interface Peer {
  key: string;
  label: string;
  backend: string;
  adapter: VFSAdapter;
  node: VFSNode;
}

interface Selection {
  peer: string;
  path: string;
}

const peers: Peer[] = [];
let edges: MeshEdge[] = [];
let selection: Selection | null = null;
let autoTimer: ReturnType<typeof setInterval> | undefined;
let syncing = false;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const peersEl = $<HTMLDivElement>('peers');
const logList = $<HTMLOListElement>('log-list');
const contentEl = $<HTMLTextAreaElement>('content');
const editorTitle = $<HTMLSpanElement>('editor-title');
const saveButton = $<HTMLButtonElement>('save');
const backendBadge = $<HTMLSpanElement>('backend');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ---------------------------------------------------------------- bootstrap

async function makeAdapter(key: string, label: string): Promise<{ adapter: VFSAdapter; backend: string }> {
  if (isOPFSAvailable()) {
    try {
      return { adapter: await OPFSAdapter.open({ path: `${OPFS_ROOT}/${key}`, name: label }), backend: 'OPFS' };
    } catch {
      // storage blocked (private window, embedded iframe) — fall through
    }
  }
  return { adapter: new MemoryAdapter(label), backend: 'memory' };
}

async function addPeer(key: string, label: string): Promise<Peer> {
  const { adapter, backend } = await makeAdapter(key, label);
  const node = await VFSNode.open(adapter, { id: label });
  const peer: Peer = { key, label, backend, adapter, node };
  peers.push(peer);
  return peer;
}

function rebuildEdges(): void {
  edges = peers.slice(0, -1).map((peer, i) => ({ a: peer.node, b: (peers[i + 1] as Peer).node }));
}

async function boot(): Promise<void> {
  await addPeer('device-a', 'device-a');
  await addPeer('device-b', 'device-b');
  await addPeer('device-c', 'device-c');
  rebuildEdges();

  backendBadge.textContent = `backend: ${(peers[0] as Peer).backend}`;
  if ((peers[0] as Peer).backend === 'memory') {
    log('OPFS is unavailable here, so the demo runs on in-memory adapters.', 'warn');
  }

  const first = peers[0] as Peer;
  if ((await walk(first.adapter)).length === 0) {
    await first.node.write('notes.md', encoder.encode('# Notes\n\nEdit me on any peer.\n'));
    await first.node.write('todo.md', encoder.encode('- [ ] sync the chain\n'));
    log('Seeded device-a with two files.');
  }

  $<HTMLButtonElement>('add-local').hidden = !isFSAAvailable();
  await render();
}

// ------------------------------------------------------------------ render

async function render(): Promise<void> {
  peersEl.replaceChildren();

  for (const [index, peer] of peers.entries()) {
    if (index > 0) peersEl.append(edgeElement(index - 1));
    peersEl.append(await peerElement(peer));
  }
}

function edgeElement(index: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'edge';
  const button = document.createElement('button');
  button.textContent = 'sync ⇄';
  button.title = 'Sync just this edge';
  button.addEventListener('click', () => syncEdge(index));
  wrap.append(button);
  return wrap;
}

async function peerElement(peer: Peer): Promise<HTMLElement> {
  const card = document.createElement('article');
  card.className = 'peer';

  const head = document.createElement('header');
  head.innerHTML = `<h2>${peer.label}</h2><span class="badge">${peer.backend}</span>`;
  card.append(head);

  const list = document.createElement('ul');
  list.className = 'files';
  const files = await walk(peer.adapter);

  if (files.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'empty';
    list.append(empty);
  }

  for (const file of files) {
    const item = document.createElement('li');
    if (selection?.peer === peer.key && selection.path === file.path) item.classList.add('selected');
    if (file.path.includes('(conflict ')) item.classList.add('conflict');

    const open = document.createElement('button');
    open.className = 'file';
    open.innerHTML = `<span class="name">${file.path}</span><span class="size">${file.stat.size} B</span>`;
    open.addEventListener('click', () => select(peer, file.path));

    const rename = document.createElement('button');
    rename.className = 'icon';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.addEventListener('click', () => renameFile(peer, file.path));

    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.textContent = '×';
    remove.title = 'Delete';
    remove.addEventListener('click', () => deleteFile(peer, file.path));

    item.append(open, rename, remove);
    list.append(item);
  }
  card.append(list);

  const actions = document.createElement('div');
  actions.className = 'peer-actions';
  const add = document.createElement('button');
  add.textContent = '+ new file';
  add.addEventListener('click', () => newFile(peer));
  actions.append(add);

  const head_ = await peer.node.head();
  const commit = document.createElement('span');
  commit.className = 'commit';
  commit.textContent = head_ ? `@ ${head_.slice(0, 7)}` : 'no commits';
  commit.title = head_ ?? '';
  actions.append(commit);

  card.append(actions);
  return card;
}

// ----------------------------------------------------------------- actions

async function select(peer: Peer, path: string): Promise<void> {
  selection = { peer: peer.key, path };
  contentEl.value = decoder.decode(await peer.node.read(path));
  contentEl.disabled = false;
  saveButton.disabled = false;
  editorTitle.textContent = `${peer.label} / ${path}`;
  await render();
}

async function save(): Promise<void> {
  if (!selection) return;
  const peer = peers.find((p) => p.key === selection?.peer);
  if (!peer) return;
  await peer.node.write(selection.path, encoder.encode(contentEl.value));
  log(`saved ${selection.path} on ${peer.label}`);
  await render();
}

async function newFile(peer: Peer): Promise<void> {
  const name = prompt('File name', 'untitled.md');
  if (!name) return;
  await peer.node.write(name, encoder.encode(''));
  log(`created ${name} on ${peer.label}`);
  await select(peer, name);
}

async function renameFile(peer: Peer, path: string): Promise<void> {
  const name = prompt('Rename to', path);
  if (!name || name === path) return;
  // Goes through the node, not the adapter, so the rename is recorded as
  // intent and travels as a rename rather than as delete + create.
  await peer.node.rename(path, name);
  log(`renamed ${path} → ${name} on ${peer.label}`);
  if (selection?.peer === peer.key && selection.path === path) selection = { peer: peer.key, path: name };
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
  if (!selection) return;
  const peer = peers.find((p) => p.key === selection?.peer);
  if (!peer) return clearSelection();
  const stat = await peer.adapter.stat(selection.path);
  if (!stat) return clearSelection();
  contentEl.value = decoder.decode(await peer.node.read(selection.path));
}

// ------------------------------------------------------------------- extras

async function addLocalFolder(): Promise<void> {
  try {
    const adapter = await FSAAdapter.pick();
    if (!(await adapter.ensurePermission())) {
      log('permission denied for that folder', 'warn');
      return;
    }
    const label = adapter.name || 'local';
    const node = await VFSNode.open(adapter, { id: label });
    peers.push({ key: `local-${peers.length}`, label, backend: 'local folder', adapter, node });
    rebuildEdges();
    log(`added ${label} as a peer at the end of the chain`, 'ok');
    await render();
  } catch (error) {
    if ((error as DOMException)?.name !== 'AbortError') log(String(error), 'warn');
  }
}

async function reset(): Promise<void> {
  if (!confirm('Delete every demo folder and start over?')) return;
  if (isOPFSAvailable()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_ROOT, { recursive: true });
    } catch {
      // nothing to remove
    }
  }
  location.reload();
}

function log(message: string, kind: 'info' | 'ok' | 'warn' | 'conflict' = 'info'): void {
  const item = document.createElement('li');
  item.className = kind;
  const time = new Date().toLocaleTimeString();
  item.innerHTML = `<time>${time}</time><span>${message}</span>`;
  logList.prepend(item);
  while (logList.childElementCount > 100) logList.lastElementChild?.remove();
}

// -------------------------------------------------------------------- wire

$<HTMLButtonElement>('sync-all').addEventListener('click', syncAll);
$<HTMLButtonElement>('reset').addEventListener('click', reset);
$<HTMLButtonElement>('add-local').addEventListener('click', addLocalFolder);
$<HTMLButtonElement>('save').addEventListener('click', save);
$<HTMLButtonElement>('clear-log').addEventListener('click', () => logList.replaceChildren());
$<HTMLInputElement>('auto-sync').addEventListener('change', (event) => {
  const on = (event.target as HTMLInputElement).checked;
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = on ? setInterval(syncAll, 3000) : undefined;
});

contentEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    void save();
  }
});

void boot();
