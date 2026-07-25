import type { JSX } from 'preact';
import { ALL_ROOTS, BACKEND_ICON } from '../model';
import type { ExplorerModel } from '../model';
import { formatAgo } from '../format';

export function Footer({ model }: { model: ExplorerModel }): JSX.Element {
  const peer = model.activePeer();
  const snapshot = peer ? model.snapshotOf(peer.key) : null;
  const state = model.syncing ? 'busy' : model.lastKind === 'warn' ? 'warn' : 'ok';
  const bits = [
    peer ? `${peer.label} · ${peer.backend}` : 'new tab',
    snapshot?.head ? `@ ${snapshot.head.slice(0, 7)}` : 'no commits',
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
  const valid =
    model.syncTargetKey === ALL_ROOTS || model.peers.some((p) => p.key === model.syncTargetKey);
  const value =
    !valid || model.syncTargetKey === model.active || !hasPeer ? ALL_ROOTS : model.syncTargetKey;
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
      <button
        class="vfs-primary"
        disabled={model.syncing || model.peers.length < 2}
        onClick={() => void model.syncTarget()}
      >
        {model.syncing ? 'Syncing…' : 'Sync'}
      </button>
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
