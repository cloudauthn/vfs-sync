import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ALL_ROOTS, BACKEND_ICON } from '../model';
import type { ExplorerModel } from '../model';
import { formatAgo } from '../format';

export function Footer({ model }: { model: ExplorerModel }): JSX.Element {
  const peer = model.activePeer();
  const snapshot = peer ? model.snapshotOf(peer.key) : null;
  const state = model.syncing ? 'busy' : model.lastKind === 'warn' ? 'warn' : 'ok';
  const bits = [
    peer ? `${peer.label} · ${peer.backend}` : 'new tab',
    snapshot?.state ? `@ ${snapshot.state.slice(0, 7)}` : 'nothing recorded',
    model.lastSyncAt ? `synced ${formatAgo(model.lastSyncAt)}` : 'not synced yet',
  ];
  return (
    <div class="vfs-footer">
      <div class="vfs-status">
        <span class={`vfs-dot vfs-dot-${state}`} />
        <span class="vfs-status-text">{model.syncing ? 'syncing…' : model.lastMessage}</span>
        {bits.map((bit, i) => (
          <span key={i} class="vfs-status-bit">
            {bit}
          </span>
        ))}
        {model.wantsLog && (
          <button
            class="vfs-ghost"
            aria-expanded={model.logOpen}
            onClick={() => model.toggleLog(!model.logOpen)}
          >
            {`Activity${model.logCount ? ` (${model.logCount})` : ''}`}
          </button>
        )}
      </div>
      {model.wantsControls && <Controls model={model} />}
    </div>
  );
}

function Controls({ model }: { model: ExplorerModel }): JSX.Element {
  const hasPeer = !!model.activePeer();
  const canSync = !model.syncing && model.peers.length >= 2;
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const valid =
    model.syncTargetKey === ALL_ROOTS || model.peers.some((p) => p.key === model.syncTargetKey);
  const value =
    !valid || model.syncTargetKey === model.active || !hasPeer ? ALL_ROOTS : model.syncTargetKey;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = splitRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!canSync && menuOpen) setMenuOpen(false);
  }, [canSync, menuOpen]);

  const run = async (event: Event, mode: 'plain' | 'confirm'): Promise<void> => {
    event.preventDefault();
    setMenuOpen(false);
    if (mode === 'confirm') await model.syncTargetWithConfirm();
    else await model.syncTarget();
  };

  return (
    <div class="vfs-controls">
      <span class="vfs-controls-label">Sync with</span>
      <select
        class="vfs-target"
        title="Which root to sync the open one against"
        value={value}
        onChange={(event) => model.setSyncTarget((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value={ALL_ROOTS}>All roots (chain)</option>
        {hasPeer &&
          model.peers
            .filter((peer) => peer.key !== model.active)
            .map((peer) => (
              <option key={peer.key} value={peer.key}>
                {`${BACKEND_ICON[peer.backend]} ${peer.label}`}
              </option>
            ))}
      </select>
      <div class="vfs-split" title="Sync actions" ref={splitRef}>
        <button class="vfs-primary vfs-split-main" disabled={!canSync} onClick={() => void model.syncTarget()}>
          {model.syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button
          class="vfs-split-toggle"
          aria-label="Choose sync action"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!canSync}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ▾
        </button>
        {menuOpen && (
          <div class="vfs-split-pop" role="menu">
            <button class="vfs-split-item" role="menuitem" disabled={!canSync} onClick={(e) => void run(e, 'plain')}>
              Sync
            </button>
            <button class="vfs-split-item" role="menuitem" disabled={!canSync} onClick={(e) => void run(e, 'confirm')}>
              Sync with confirm
            </button>
          </div>
        )}
      </div>
      <label class="vfs-switch" htmlFor={model.autoSyncBoxId}>
        <input
          id={model.autoSyncBoxId}
          type="checkbox"
          checked={model.autoSyncOn}
          onChange={(event) => model.setAutoSync((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>{`Auto ${model.autoSyncMs / 1000}s`}</span>
      </label>
    </div>
  );
}
