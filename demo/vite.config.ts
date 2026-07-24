import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the built demo works from a GitHub Pages subpath
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
