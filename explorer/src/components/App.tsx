import type { JSX } from 'preact';
import type { ExplorerModel } from '../model';
import { useModel } from './shared';
import { Tabs } from './Tabs';
import { PeerSidebar } from './PeerSidebar';
import { PeerDetails } from './PeerDetails';
import { NewTabView } from './NewTabView';
import { Drawer } from './Drawer';
import { Footer } from './Footer';
import { Modal } from './Modal';

export function App({ model }: { model: ExplorerModel }): JSX.Element {
  useModel(model);
  const peer = model.activePeer();
  const pending = !peer && model.pendingTab && model.active === model.pendingTab.key;
  return (
    <div class="vfs-explorer">
      <Tabs model={model} />
      <div class="vfs-body">
        {peer ? (
          <>
            <PeerSidebar model={model} peer={peer} />
            <PeerDetails model={model} peer={peer} />
          </>
        ) : pending ? (
          <PendingPeer />
        ) : (
          <NewTabView model={model} />
        )}
      </div>
      <Drawer model={model} />
      <Footer model={model} />
      <Modal model={model} />
    </div>
  );
}

/** The tab is open but its peer is still loading; a placeholder stands in. */
function PendingPeer(): JSX.Element {
  return (
    <>
      <div class="vfs-sidebar">
        <ul class="vfs-tree" role="tree">
          <li class="vfs-empty">Loading…</li>
        </ul>
      </div>
      <div class="vfs-details" />
    </>
  );
}
