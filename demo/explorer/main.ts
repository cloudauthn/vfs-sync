// This page is only a frame: the explorer is an app of its own, mounted here
// the same way any other page would embed it.
import { mountExplorer } from '../../explorer/src/index';

mountExplorer('#explorer', {
  gdriveClientId: import.meta.env.VITE_GDRIVE_CLIENT_ID,
  gdriveScope: import.meta.env.VITE_GDRIVE_SCOPE,
});
