import type { JSX } from 'preact';
import type { ExplorerModel } from '../model';

export function Drawer({ model }: { model: ExplorerModel }): JSX.Element {
  return (
    <div class="vfs-drawer" hidden={!model.logOpen}>
      <div class="vfs-drawer-panel">
        <div class="vfs-drawer-head">
          <span class="vfs-drawer-title">Activity</span>
          <div class="vfs-drawer-actions">
            <button class="vfs-ghost" onClick={() => model.clearLog()}>
              Clear
            </button>
            <button
              class="vfs-ghost"
              title="Hide the activity log"
              onClick={() => model.toggleLog(false)}
            >
              ×
            </button>
          </div>
        </div>
        <ol>
          {model.logs.map((entry, i) => (
            <li key={i} class={`vfs-${entry.kind}`}>
              <time>{entry.time}</time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
