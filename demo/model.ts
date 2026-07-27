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
import type { ConflictReport, MeshEdge, VFSAdapter, WalkedFile } from '../src/index';

const OPFS_ROOT = 'vfs-sync-demo';

export type LogKind = 'info' | 'ok' | 'warn' | 'conflict';

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

/** What one render pass needs to know about a peer — computed off the model thread. */
export interface PeerView {
  key: string;
  label: string;
  backend: string;
  files: WalkedFile[];
  /** Digest of the live entries — two peers agree when these match. */
  state: string | null;
}

export interface LogEntry {
  time: string;
  message: string;
  kind: LogKind;
}

/**
 * The three-peer chain demo's whole state and behaviour, with no dependency on
 * how it is drawn. It mutates in place and notifies {@link subscribe}rs on every
 * change; a Preact tree reads these fields and repaints. The async work (walking
 * peers, reading commits, syncing) happens here so rendering stays synchronous.
 */
export class DemoModel {
  peers: Peer[] = [];
  edges: MeshEdge[] = [];
  peerViews: PeerView[] = [];
  selection: Selection | null = null;
  syncing = false;
  logs: LogEntry[] = [];
  /** Backend the first peer landed on — shown in the toolbar badge. */
  backend = '';
  canAddLocal = false;

  editorText = '';
  editorTitle = 'Select a file to edit';
  editorEnabled = false;

  private readonly listeners = new Set<() => void>();
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  private renderSeq = 0;

  // -------------------------------------------------------------- subscribe

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // --------------------------------------------------------------- bootstrap

  private async makeAdapter(
    key: string,
    label: string,
  ): Promise<{ adapter: VFSAdapter; backend: string }> {
    if (isOPFSAvailable()) {
      try {
        return {
          adapter: await OPFSAdapter.open({ path: `${OPFS_ROOT}/${key}`, name: label }),
          backend: 'OPFS',
        };
      } catch {
        // storage blocked (private window, embedded iframe) — fall through
      }
    }
    return { adapter: new MemoryAdapter(label), backend: 'memory' };
  }

  private async addPeer(key: string, label: string): Promise<Peer> {
    const { adapter, backend } = await this.makeAdapter(key, label);
    const node = await VFSNode.open(adapter, { id: label });
    const peer: Peer = { key, label, backend, adapter, node };
    this.peers.push(peer);
    return peer;
  }

  private rebuildEdges(): void {
    this.edges = this.peers
      .slice(0, -1)
      .map((peer, i) => ({ a: peer.node, b: (this.peers[i + 1] as Peer).node }));
  }

  async boot(): Promise<void> {
    await this.addPeer('device-a', 'device-a');
    await this.addPeer('device-b', 'device-b');
    await this.addPeer('device-c', 'device-c');
    this.rebuildEdges();

    const first = this.peers[0] as Peer;
    this.backend = first.backend;
    if (first.backend === 'memory') {
      this.log('OPFS is unavailable here, so the demo runs on in-memory adapters.', 'warn');
    }

    if ((await walk(first.adapter)).length === 0) {
      await first.node.write('notes.md', this.encoder.encode('# Notes\n\nEdit me on any peer.\n'));
      await first.node.write('todo.md', this.encoder.encode('- [ ] sync the chain\n'));
      this.log('Seeded device-a with two files.');
    }

    this.canAddLocal = isFSAAvailable();
    await this.render();
  }

  // ------------------------------------------------------------------ render

  /** Recompute every peer's file list and state digest, then repaint. */
  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const views: PeerView[] = [];
    for (const peer of this.peers) {
      views.push({
        key: peer.key,
        label: peer.label,
        backend: peer.backend,
        files: await walk(peer.adapter),
        state: await peer.node.state(),
      });
    }
    if (seq !== this.renderSeq) return;
    this.peerViews = views;
    this.emit();
  }

  private peerOf(key: string | undefined): Peer | undefined {
    return this.peers.find((peer) => peer.key === key);
  }

  // ----------------------------------------------------------------- actions

  async select(peer: Peer, path: string): Promise<void> {
    this.selection = { peer: peer.key, path };
    this.editorText = this.decoder.decode(await peer.node.read(path));
    this.editorEnabled = true;
    this.editorTitle = `${peer.label} / ${path}`;
    await this.render();
  }

  /** Called from the editor as the user types. */
  markEditor(text: string): void {
    this.editorText = text;
    this.emit();
  }

  async save(): Promise<void> {
    if (!this.selection) return;
    const peer = this.peerOf(this.selection.peer);
    if (!peer) return;
    await peer.node.write(this.selection.path, this.encoder.encode(this.editorText));
    this.log(`saved ${this.selection.path} on ${peer.label}`);
    await this.render();
  }

  async newFile(peer: Peer): Promise<void> {
    const name = prompt('File name', 'untitled.md');
    if (!name) return;
    await peer.node.write(name, this.encoder.encode(''));
    this.log(`created ${name} on ${peer.label}`);
    await this.select(peer, name);
  }

  async renameFile(peer: Peer, path: string): Promise<void> {
    const name = prompt('Rename to', path);
    if (!name || name === path) return;
    // Goes through the node, not the adapter, so the rename is recorded as
    // intent and travels as a rename rather than as delete + create.
    await peer.node.rename(path, name);
    this.log(`renamed ${path} → ${name} on ${peer.label}`);
    if (this.selection?.peer === peer.key && this.selection.path === path) {
      this.selection = { peer: peer.key, path: name };
    }
    await this.render();
  }

  async deleteFile(peer: Peer, path: string): Promise<void> {
    await peer.node.delete(path);
    if (this.selection?.peer === peer.key && this.selection.path === path) this.clearSelection();
    this.log(`deleted ${path} on ${peer.label}`);
    await this.render();
  }

  private clearSelection(): void {
    this.selection = null;
    this.editorText = '';
    this.editorEnabled = false;
    this.editorTitle = 'Select a file to edit';
  }

  // -------------------------------------------------------------------- sync

  async syncEdge(index: number): Promise<void> {
    const edge = this.edges[index];
    if (!edge || this.syncing) return;
    this.syncing = true;
    this.emit();
    try {
      const result = await sync(edge.a, edge.b);
      this.report(
        `${edge.a.name} ⇄ ${edge.b.name}`,
        result.changed,
        result.conflicts,
        result.transferred,
      );
    } catch (error) {
      this.log(String(error), 'warn');
    } finally {
      this.syncing = false;
      await this.refreshSelection();
      await this.render();
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
      if (changed.length === 0) {
        this.log('already in sync');
      } else {
        this.log(`converged in ${rounds.length} round(s), ${changed.length} edge update(s)`, 'ok');
      }
      for (const conflict of conflicts) this.logConflict(conflict);
    } catch (error) {
      this.log(String(error), 'warn');
    } finally {
      this.syncing = false;
      await this.refreshSelection();
      await this.render();
    }
  }

  private report(
    edge: string,
    changed: boolean,
    conflicts: ConflictReport[],
    transferred: { toA: number; toB: number },
  ): void {
    if (!changed) {
      this.log(`${edge}: nothing to do`);
      return;
    }
    this.log(`${edge}: merged (${transferred.toA + transferred.toB} blob(s) moved)`, 'ok');
    for (const conflict of conflicts) this.logConflict(conflict);
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

  /** The selected file may have been rewritten or removed by a sync. */
  private async refreshSelection(): Promise<void> {
    if (!this.selection) return;
    const peer = this.peerOf(this.selection.peer);
    if (!peer) return this.clearSelection();
    const stat = await peer.adapter.stat(this.selection.path);
    if (!stat) return this.clearSelection();
    this.editorText = this.decoder.decode(await peer.node.read(this.selection.path));
  }

  // ------------------------------------------------------------------- extras

  async addLocalFolder(): Promise<void> {
    try {
      const adapter = await FSAAdapter.pick();
      if (!(await adapter.ensurePermission())) {
        this.log('permission denied for that folder', 'warn');
        return;
      }
      const label = adapter.name || 'local';
      const node = await VFSNode.open(adapter, { id: label });
      this.peers.push({
        key: `local-${this.peers.length}`,
        label,
        backend: 'local folder',
        adapter,
        node,
      });
      this.rebuildEdges();
      this.log(`added ${label} as a peer at the end of the chain`, 'ok');
      await this.render();
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') this.log(String(error), 'warn');
    }
  }

  async reset(): Promise<void> {
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

  setAutoSync(on: boolean): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = on ? setInterval(() => void this.syncAll(), 3000) : undefined;
    this.emit();
  }

  get autoSyncOn(): boolean {
    return this.autoTimer !== undefined;
  }

  clearLog(): void {
    this.logs = [];
    this.emit();
  }

  log(message: string, kind: LogKind = 'info'): void {
    this.logs = [{ time: new Date().toLocaleTimeString(), message, kind }, ...this.logs].slice(
      0,
      100,
    );
    this.emit();
  }

  /** Look up the live peer behind a {@link PeerView} for an action handler. */
  peer(key: string): Peer | undefined {
    return this.peerOf(key);
  }
}
