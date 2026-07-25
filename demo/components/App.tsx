import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DemoModel } from '../model';
import { Toolbar } from './Toolbar';
import { Peers } from './Peers';
import { Workbench } from './Workbench';

/** Subscribe a component to the model: any {@link DemoModel} change repaints it. */
function useModel(model: DemoModel): void {
  const [, setTick] = useState(0);
  useEffect(() => model.subscribe(() => setTick((n) => n + 1)), [model]);
}

export function App({ model }: { model: DemoModel }): JSX.Element {
  useModel(model);
  return (
    <>
      <Toolbar model={model} />
      <Peers model={model} />
      <Workbench model={model} />
    </>
  );
}
