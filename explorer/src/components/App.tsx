import type { JSX } from 'preact';
import type { ExplorerModel } from '../model';
import { useModel } from './shared';
import { Tabs } from './Tabs';
import { PeerSidebar } from './PeerSidebar';
import { PeerDetails } from './PeerDetails';
import { NewTabView } from './NewTabView';
import { Drawer } from './Drawer';
import { Footer } from './Footer';

export function App({ model }: { model: ExplorerModel }): JSX.Element {
  useModel(model);
  const peer = model.activePeer();
  return (
    <div class="vfs-explorer">
      <Tabs model={model} />
      <div class="vfs-body">
        {peer ? (
          <>
            <PeerSidebar model={model} peer={peer} />
            <PeerDetails model={model} peer={peer} />
          </>
        ) : (
          <NewTabView model={model} />
        )}
      </div>
      <Drawer model={model} />
      <Footer model={model} />
    </div>
  );
}
