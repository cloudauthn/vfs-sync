import type { JSX } from 'preact';
import type { ExplorerModel } from '../model';

export function Modal({ model }: { model: ExplorerModel }): JSX.Element | null {
  const dialog = model.dialog;
  if (!dialog) return null;

  const isPrompt = dialog.kind === 'prompt';
  const isDecide = dialog.kind === 'decide';
  const okClass = dialog.danger ? 'vfs-danger' : 'vfs-primary';

  return (
    // A decide dialog does not close on a stray backdrop click: answering five
    // rows and losing them to a misclick is a worse outcome than an extra press
    // of "Not now", which is right there and means the same thing.
    <div
      class="vfs-modal-backdrop"
      role="presentation"
      onClick={() => !isDecide && model.cancelDialog()}
    >
      <div
        class="vfs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 class="vfs-modal-title">{dialog.title}</h3>
        <p class="vfs-modal-message">{dialog.message}</p>
        {dialog.sections && dialog.sections.length > 0 && (
          <div class="vfs-modal-sections">
            {dialog.sections.map((section) => (
              <section class="vfs-modal-section" key={section.title}>
                <h4>{section.title}</h4>
                {section.items.length > 0 ? (
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p class="vfs-hint">None</p>
                )}
              </section>
            ))}
          </div>
        )}
        {isDecide && (
          <div class="vfs-decide">
            {(dialog.conflicts ?? []).map((conflict) => (
              <section class="vfs-decide-row" key={conflict.id}>
                <h4>
                  {conflict.path ?? conflict.reason}
                  <span class="vfs-decide-reason">{conflict.reason}</span>
                </h4>
                {conflict.note && <p class="vfs-hint">{conflict.note}</p>}
                <dl class="vfs-decide-sides">
                  {conflict.sides.map((side) => (
                    <div key={side.label}>
                      <dt>{side.label}</dt>
                      <dd>
                        {side.detail}
                        {side.blocked && <span class="vfs-decide-blocked"> — {side.blocked}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div class="vfs-decide-choices">
                  {conflict.choices.map((choice, index) => (
                    <button
                      key={choice.label}
                      class={conflict.picked === index ? 'vfs-primary' : 'vfs-ghost'}
                      title={choice.blocked ?? ''}
                      onClick={() => model.setDecision(conflict.id, index)}
                    >
                      {choice.label}
                      {choice.blocked && ' ⚠'}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {isPrompt && (
          <input
            class="vfs-modal-input"
            autoFocus
            value={dialog.value ?? ''}
            placeholder={dialog.placeholder ?? ''}
            onInput={(event) => model.setDialogValue((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                model.acceptDialog();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                model.cancelDialog();
              }
            }}
          />
        )}
        <div class="vfs-modal-actions">
          <button class="vfs-ghost" onClick={() => model.cancelDialog()}>
            {dialog.cancelText ?? 'Cancel'}
          </button>
          <button
            class={okClass}
            disabled={isDecide && !model.decisionsComplete}
            onClick={() => model.acceptDialog()}
          >
            {dialog.okText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
