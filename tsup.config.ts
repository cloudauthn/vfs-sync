import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // browser / universal build: core engine + memory, OPFS and FSA adapters
    entry: { 'vfs-sync': 'src/index.ts' },
    format: ['esm', 'cjs', 'iife'],
    globalName: 'vfsSync',
    outExtension: ({ format }) => ({
      js: format === 'iife' ? '.global.js' : format === 'cjs' ? '.cjs' : '.js',
    }),
    dts: false, // declarations are emitted by tsc (npm run types)
    sourcemap: true,
    clean: true,
    target: 'es2022',
  },
  {
    // node-only entry point: the fs adapter, exported as @cloudauthn/vfs-sync/node
    entry: { node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    dts: false,
    sourcemap: true,
    clean: false,
    platform: 'node',
    target: 'node18',
  },
]);
