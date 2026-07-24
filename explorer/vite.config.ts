import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the built app works from any subpath, including an iframe
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
