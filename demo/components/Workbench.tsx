import type { JSX } from 'preact';
import type { DemoModel } from '../model';

export function Workbench({ model }: { model: DemoModel }): JSX.Element {
  return (
    <section class="workbench">
      <div class="editor" id="editor">
        <div class="editor-head">
          <span id="editor-title">{model.editorTitle}</span>
          <button class="primary" disabled={!model.editorEnabled} onClick={() => void model.save()}>
            Save
          </button>
        </div>
        <textarea
          spellcheck={false}
          disabled={!model.editorEnabled}
          placeholder="No file selected"
          value={model.editorText}
          onInput={(event) => model.markEditor((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
              event.preventDefault();
              void model.save();
            }
          }}
        />
      </div>

      <div class="log">
        <div class="log-head">
          <span>Activity</span>
          <button onClick={() => model.clearLog()}>Clear</button>
        </div>
        <ol>
          {model.logs.map((entry, i) => (
            <li key={i} class={entry.kind}>
              <time>{entry.time}</time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
