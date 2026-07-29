import type { JSX } from 'preact';
import type { ExplorerModel } from '../model';

export function Modal({ model }: { model: ExplorerModel }): JSX.Element | null {
  const dialog = model.dialog;
  if (!dialog) return null;

  const isPrompt = dialog.kind === 'prompt';
  const okClass = dialog.danger ? 'vfs-danger' : 'vfs-primary';

  return (
    <div class="vfs-modal-backdrop" role="presentation" onClick={() => model.cancelDialog()}>
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
          <button class={okClass} onClick={() => model.acceptDialog()}>
            {dialog.okText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
