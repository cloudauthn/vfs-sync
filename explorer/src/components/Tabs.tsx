import type { JSX } from 'preact';
import { BACKEND_ICON } from '../model';
import type { ExplorerModel, Peer } from '../model';
import { formatBytes } from '../format';

export function Tabs({ model }: { model: ExplorerModel }): JSX.Element {
  return (
    <div class="vfs-tabs" role="tablist">
      {model.peers.map((peer) => (
        <Tab key={peer.key} model={model} peer={peer} />
      ))}
      <NewTabButton model={model} />
    </div>
  );
}

function Tab({ model, peer }: { model: ExplorerModel; peer: Peer }): JSX.Element {
  const snapshot = model.snapshotOf(peer.key);
  const count = snapshot.files.length;
  const activate = () => void model.activate(peer);
  return (
    <div
      class={`vfs-tab${peer.key === model.active ? ' vfs-active' : ''}`}
      role="tab"
      tabIndex={0}
      aria-selected={peer.key === model.active}
      title={`${peer.backend}${snapshot.head ? ` @ ${snapshot.head.slice(0, 7)}` : ''}`}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
    >
      <span class="vfs-tab-title">
        <span class="vfs-tab-icon">{BACKEND_ICON[peer.backend]}</span>
        <span class="vfs-tab-name">{peer.label}</span>
        <span
          class="vfs-tab-close"
          role="button"
          aria-label={`Close ${peer.label}`}
          title={peer.backend === 'memory' ? 'Close (a MemFS forgets everything)' : 'Close'}
          onClick={(event) => {
            event.stopPropagation();
            void model.closePeer(peer);
          }}
        >
          ×
        </span>
      </span>
      <span class="vfs-tab-meta">
        {`${count} item${count === 1 ? '' : 's'} · ${formatBytes(snapshot.bytes)}`}
      </span>
    </div>
  );
}

function NewTabButton({ model }: { model: ExplorerModel }): JSX.Element {
  const open = () => void model.activateNewTab();
  return (
    <div
      class={`vfs-tab vfs-add${model.active === '' ? ' vfs-active' : ''}`}
      role="tab"
      tabIndex={0}
      aria-selected={model.active === ''}
      title="Open another root"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <span class="vfs-tab-icon">＋</span>
      <span class="vfs-tab-name">New tab</span>
    </div>
  );
}
