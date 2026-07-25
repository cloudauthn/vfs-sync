import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  // relative base so the built demo works from a GitHub Pages subpath
  base: './',
  // Preact powers the demo UI; esbuild compiles JSX to its automatic runtime.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // two pages: the peer chain at / and the embedded explorer app at /explorer/
    rollupOptions: { input: { main: page('index.html'), explorer: page('explorer/index.html') } },
  },
});
