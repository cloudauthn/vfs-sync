import type { JSX } from 'preact';
import type { DemoModel } from '../model';

export function Toolbar({ model }: { model: DemoModel }): JSX.Element {
  return (
    <section class="toolbar">
      <button class="primary" onClick={() => void model.syncAll()}>
        Sync the whole chain
      </button>
      <label class="switch">
        <input
          type="checkbox"
          checked={model.autoSyncOn}
          onChange={(event) => model.setAutoSync((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>Auto-sync every 3s</span>
      </label>
      {model.canAddLocal && (
        <button onClick={() => void model.addLocalFolder()}>Add a local folder as a 4th peer…</button>
      )}
      <button class="danger" onClick={() => void model.reset()}>
        Reset
      </button>
      <span class="badge">{model.backend ? `backend: ${model.backend}` : ''}</span>
    </section>
  );
}
