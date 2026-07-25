import { render } from 'preact';
import { ExplorerModel } from './model';
import type { ExplorerOptions } from './model';
import { App } from './components/App';
import './explorer.css';

export type { ExplorerOptions, LogKind } from './model';

export interface ExplorerHandle {
  /** The root the app drew itself into. */
  readonly element: HTMLElement;
  /** Sync the open root against whatever the footer's target selector points at. */
  syncTarget(): Promise<void>;
  /** Sync every edge of the chain until it stops changing. */
  syncAll(): Promise<void>;
  /** Re-read every root and repaint. */
  refresh(): Promise<void>;
  /** Stop the auto-sync timer and empty the root element. */
  destroy(): void;
}

/**
 * Draws the file explorer into `target` and boots it. Everything the app needs
 * lives inside that element and inside its {@link ExplorerModel}, so a page can
 * mount more than one of them — give each its own `opfsRoot` and they browse
 * different folders.
 */
export function mountExplorer(
  target: HTMLElement | string,
  options: ExplorerOptions = {},
): ExplorerHandle {
  const root = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!root) throw new Error(`vfs-sync explorer: no element matched ${String(target)}`);

  const model = new ExplorerModel(options);
  render(<App model={model} />, root);
  void model.boot();

  return {
    element: root.firstElementChild as HTMLElement,
    syncTarget: () => model.syncTarget(),
    syncAll: () => model.syncAll(),
    refresh: () => model.render(),
    destroy(): void {
      model.destroy();
      render(null, root);
    },
  };
}
