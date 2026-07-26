import type { JSX } from 'preact';
import { CONTROL_DIR } from '../../../src/index';
import type { VFSListEntry, WalkedFile } from '../../../src/index';
import { BACKEND_ICON } from '../model';
import type { ExplorerModel, Peer } from '../model';
import { formatBytes, iconOf, mimeOf } from '../format';

/** A folder as the explorer draws it, rebuilt from the flat walk() listing. */
interface TreeDir {
  path: string;
  dirs: Map<string, TreeDir>;
  files: WalkedFile[];
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

function selectedOn(model: ExplorerModel, path: string): boolean {
  return model.selection?.peer === model.active && model.selection.path === path;
}

function treeRows(model: ExplorerModel, peer: Peer, dir: TreeDir, depth: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  for (const name of [...dir.dirs.keys()].sort()) {
    const child = dir.dirs.get(name) as TreeDir;
    const collapsed = peer.collapsed.has(child.path);
    const selected = selectedOn(model, child.path);
    out.push(
      <li
        key={`d:${child.path}`}
        class={`vfs-row vfs-dir${selected ? ' vfs-selected' : ''}`}
        role="treeitem"
        aria-expanded={!collapsed}
        aria-selected={selected || undefined}
      >
        <button
          class="vfs-entry"
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => void model.select(peer, { path: child.path, kind: 'directory' })}
          onDblClick={() => model.toggleDir(peer, child.path, collapsed)}
        >
          <span
            class="vfs-twisty"
            onClick={(event) => {
              event.stopPropagation();
              model.toggleDir(peer, child.path, collapsed);
            }}
          >
            {collapsed ? '▸' : '▾'}
          </span>
          <span class="vfs-icon-cell">{collapsed ? '📁' : '📂'}</span>
          <span class="vfs-name">{name}</span>
          <span class="vfs-meta">{`${rollup(child).count}`}</span>
        </button>
      </li>,
    );
    if (!collapsed) out.push(...treeRows(model, peer, child, depth + 1));
  }
  for (const file of dir.files) {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const selected = selectedOn(model, file.path);
    out.push(
      <li
        key={`f:${file.path}`}
        class={`vfs-row${file.path.includes('(conflict ') ? ' vfs-conflict' : ''}${
          selected ? ' vfs-selected' : ''
        }`}
        role="treeitem"
        aria-selected={selected || undefined}
      >
        <button
          class="vfs-entry"
          style={{ paddingLeft: depth * 14 + 6 }}
          title={file.path}
          onClick={() => void model.select(peer, { path: file.path, kind: 'file' })}
        >
          <span class="vfs-twisty" />
          <span class="vfs-icon-cell">{iconOf(mimeOf(file.path))}</span>
          <span class="vfs-name">{name}</span>
          <span class="vfs-meta">{formatBytes(file.stat.size)}</span>
        </button>
      </li>,
    );
  }
  return out;
}

/**
 * One unfolded folder of the store, drawn straight from its listing — no tree is
 * built, because none is held: a folded folder has never been read. Dimmed and
 * read-only throughout, none of it being the user's to edit.
 */
function controlRows(model: ExplorerModel, peer: Peer, dir: string, depth: number): JSX.Element[] {
  const entries = model.snapshotOf(peer.key).control?.get(dir);
  const indent = depth * 14 + 6;
  if (!entries) {
    return [
      <li key={`l:${dir}`} class="vfs-tree-loading" style={{ paddingLeft: indent + 20 }}>
        Loading…
      </li>,
    ];
  }
  return entries.flatMap((entry) => {
    const selected = selectedOn(model, entry.path);
    const open = peer.controlExpanded.has(entry.path);
    const rows = [
      <li
        key={`c:${entry.path}`}
        class={`vfs-row vfs-control${entry.kind === 'directory' ? ' vfs-dir' : ''}${
          selected ? ' vfs-selected' : ''
        }`}
        role="treeitem"
        aria-expanded={entry.kind === 'directory' ? open : undefined}
        aria-selected={selected || undefined}
      >
        <button
          class="vfs-entry"
          style={{ paddingLeft: indent }}
          title={entry.path}
          onClick={() => void model.select(peer, { path: entry.path, kind: entry.kind })}
          onDblClick={() => entry.kind === 'directory' && model.toggleControl(peer, entry.path)}
        >
          {entry.kind === 'directory' ? (
            <span
              class="vfs-twisty"
              onClick={(event) => {
                event.stopPropagation();
                model.toggleControl(peer, entry.path);
              }}
            >
              {open ? '▾' : '▸'}
            </span>
          ) : (
            <span class="vfs-twisty" />
          )}
          <span class="vfs-icon-cell">
            {entry.kind === 'directory' ? (open ? '📂' : '📁') : iconOf(mimeOf(entry.path))}
          </span>
          <span class="vfs-name">{entry.name}</span>
          <span class="vfs-meta">{controlMeta(model, peer, entry)}</span>
        </button>
      </li>,
    ];
    if (entry.kind === 'directory' && open) {
      rows.push(...controlRows(model, peer, entry.path, depth + 1));
    }
    return rows;
  });
}

/**
 * A file shows its size; a folder shows how many children it holds, but only once
 * it has been unfolded — a count for a folder nobody has listed would be a guess.
 */
function controlMeta(model: ExplorerModel, peer: Peer, entry: VFSListEntry): string {
  if (entry.kind === 'file') return entry.stat ? formatBytes(entry.stat.size) : '';
  const listed = model.snapshotOf(peer.key).control?.get(entry.path);
  return listed ? `${listed.length}` : '';
}

/**
 * The store itself, under the working tree: folded, dimmed and read-only. It is
 * the one place the machinery is visible — objects appearing as blobs are
 * written, a JSON file per commit, the head moving in `config.json`.
 */
function ControlRows({ model, peer }: { model: ExplorerModel; peer: Peer }): JSX.Element {
  const listings = model.snapshotOf(peer.key).control;
  const open = peer.controlExpanded.has(CONTROL_DIR);
  const selected = selectedOn(model, CONTROL_DIR);
  const inside = listings?.get(CONTROL_DIR);
  return (
    <>
      <li
        class={`vfs-row vfs-dir vfs-control vfs-control-root${selected ? ' vfs-selected' : ''}`}
        role="treeitem"
        aria-expanded={open}
        aria-selected={selected || undefined}
      >
        <button
          class="vfs-entry"
          title="The sync store — shown read-only, the engine is its only writer"
          onClick={() => void model.select(peer, { path: CONTROL_DIR, kind: 'directory' })}
          onDblClick={() => model.toggleControl(peer, CONTROL_DIR)}
        >
          <span
            class="vfs-twisty"
            onClick={(event) => {
              event.stopPropagation();
              model.toggleControl(peer, CONTROL_DIR);
            }}
          >
            {open ? '▾' : '▸'}
          </span>
          <span class="vfs-icon-cell">{open ? '📂' : '📁'}</span>
          <span class="vfs-name">{CONTROL_DIR}</span>
          <span class="vfs-meta">{inside ? `${inside.length}` : 'store'}</span>
        </button>
      </li>
      {open &&
        (listings && listings.size === 0 ? (
          <li class="vfs-tree-loading">Nothing to show — the store is unreadable</li>
        ) : (
          controlRows(model, peer, CONTROL_DIR, 1)
        ))}
    </>
  );
}

export function PeerSidebar({ model, peer }: { model: ExplorerModel; peer: Peer }): JSX.Element {
  const snapshot = model.snapshotOf(peer.key);
  return (
    <div class="vfs-sidebar">
      <div class="vfs-sidebar-head">
        <button
          class="vfs-crumbs"
          title="Show this root’s details"
          onClick={() => void model.selectRoot(peer)}
        >
          <span class="vfs-tab-icon">{BACKEND_ICON[peer.backend]}</span>
          <span>{peer.label}</span>
        </button>
        <span class="vfs-head-actions">
          <button
            class="vfs-ghost"
            title="Re-read this root from the backend, past the cache"
            aria-label="Refresh"
            onClick={() => void model.reload()}
          >
            ↻
          </button>
          <button
            class="vfs-ghost"
            title="Create a file (a / in the name creates a folder)"
            onClick={() => void model.newFile(peer)}
          >
            ＋ New
          </button>
        </span>
      </div>
      <ul class="vfs-tree" role="tree">
        {model.treeLoading ? (
          <li class="vfs-empty">Loading…</li>
        ) : (
          <>
            {snapshot.files.length === 0 ? (
              <li class="vfs-empty">This folder is empty</li>
            ) : (
              treeRows(model, peer, buildTree(snapshot.files), 0)
            )}
            <ControlRows model={model} peer={peer} />
          </>
        )}
      </ul>
      <div class="vfs-sidebar-foot">
        <span>
          {`${snapshot.files.length} item${snapshot.files.length === 1 ? '' : 's'}, ${formatBytes(
            snapshot.bytes,
          )}`}
        </span>
        {peer.fsa && (
          <button
            class="vfs-ghost"
            title="Ask for permission on this folder again"
            onClick={() => void model.regrant(peer)}
          >
            Re-grant
          </button>
        )}
      </div>
    </div>
  );
}
