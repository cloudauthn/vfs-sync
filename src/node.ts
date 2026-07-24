/**
 * Node.js entry point: `@cloudauthn/vfs-sync/node`.
 *
 * Kept separate from the main entry so browser bundlers never have to resolve
 * `node:fs`.
 */
export * from './index.js';
export { NodeFsAdapter } from './adapters/node-fs.js';
