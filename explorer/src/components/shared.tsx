import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { BACKEND_ICON } from '../model';
import type { Across, ExplorerModel } from '../model';

/** Subscribe a component to the model: any {@link ExplorerModel} change repaints it. */
export function useModel(model: ExplorerModel): void {
  const [, setTick] = useState(0);
  useEffect(() => model.subscribe(() => setTick((n) => n + 1)), [model]);
}

export function Section({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}): JSX.Element {
  return (
    <section class="vfs-section">
      <h3>{title}</h3>
      <dl class="vfs-props">
        {rows.map(([key, value]) => (
          <>
            <dt>{key}</dt>
            <dd title={value}>{value}</dd>
          </>
        ))}
      </dl>
    </section>
  );
}

export function AcrossSection({ across }: { across: Across[] }): JSX.Element {
  return (
    <section class="vfs-section">
      <h3>Across roots</h3>
      <ul class="vfs-across">
        {across.length === 0 && <li class="vfs-hint">No other root is open.</li>}
        {across.map((other) => (
          <li class={`vfs-across-item vfs-state-${other.state}`}>
            <span class="vfs-dot" />
            <span class="vfs-across-name">{`${BACKEND_ICON[other.backend]} ${other.label}`}</span>
            <span class="vfs-across-state">{other.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DetailsShell({ children }: { children: ComponentChildren }): JSX.Element {
  return <div class="vfs-details">{children}</div>;
}
