import type { JSX } from 'preact';
import type { DemoModel, PeerView } from '../model';

export function Peers({ model }: { model: DemoModel }): JSX.Element {
  return (
    <main class="peers">
      {model.peerViews.map((view, i) => (
        <>
          {i > 0 && <Edge model={model} index={i - 1} />}
          <PeerCard model={model} view={view} />
        </>
      ))}
    </main>
  );
}

function Edge({ model, index }: { model: DemoModel; index: number }): JSX.Element {
  return (
    <div class="edge">
      <button title="Sync just this edge" onClick={() => void model.syncEdge(index)}>
        sync ⇄
      </button>
    </div>
  );
}

function PeerCard({ model, view }: { model: DemoModel; view: PeerView }): JSX.Element {
  const peer = model.peer(view.key);
  return (
    <article class="peer">
      <header>
        <h2>{view.label}</h2>
        <span class="badge">{view.backend}</span>
      </header>
      <ul class="files">
        {view.files.length === 0 && <li class="empty">empty</li>}
        {view.files.map((file) => {
          const selected = model.selection?.peer === view.key && model.selection.path === file.path;
          const conflict = file.path.includes('(conflict ');
          const cls = [selected ? 'selected' : '', conflict ? 'conflict' : ''].filter(Boolean).join(' ');
          return (
            <li key={file.path} class={cls || undefined}>
              <button
                class="file"
                onClick={() => peer && void model.select(peer, file.path)}
              >
                <span class="name">{file.path}</span>
                <span class="size">{file.stat.size} B</span>
              </button>
              <button
                class="icon"
                title="Rename"
                onClick={() => peer && void model.renameFile(peer, file.path)}
              >
                ✎
              </button>
              <button
                class="icon"
                title="Delete"
                onClick={() => peer && void model.deleteFile(peer, file.path)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <div class="peer-actions">
        <button onClick={() => peer && void model.newFile(peer)}>+ new file</button>
        <span class="commit" title={view.state ?? ''}>
          {view.state ? `@ ${view.state.slice(0, 7)}` : 'nothing recorded'}
        </span>
      </div>
    </article>
  );
}
