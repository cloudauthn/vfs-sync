// Standalone shell: the same app the demo embeds, mounted on its own page so
// it can be served from a URL and dropped into an <iframe>.
import { mountExplorer } from './src/index';

mountExplorer('#app');
