import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import type { ByteRange, VFSAdapter } from '../src/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Calls {
  list: string[];
  read: string[];
  stat: string[];
  reset(): void;
}

/**
 * A pass-through adapter that tallies what it was asked for. On a remote backend
 * every one of these is a round trip, so the tallies are what the explorer's
 * caches and its lazy listings exist to keep down.
 */
export function counting(base: VFSAdapter): { adapter: VFSAdapter; calls: Calls } {
  const calls: Calls = {
    list: [],
    read: [],
    stat: [],
    reset() {
      this.list.length = 0;
      this.read.length = 0;
      this.stat.length = 0;
    },
  };
  const adapter: VFSAdapter = {
    name: base.name,
    list: (path) => {
      calls.list.push(path);
      return base.list(path);
    },
    read: (path) => {
      calls.read.push(path);
      return base.read(path);
    },
    stat: (path) => {
      calls.stat.push(path);
      return base.stat(path);
    },
    write: (path, data) => base.write(path, data),
    delete: (path) => base.delete(path),
    rename: (from, to) => base.rename(from, to),
    mkdir: (path) => base.mkdir?.(path) ?? Promise.resolve(),
    readRange: (path, range?: ByteRange) => base.readRange?.(path, range) ?? base.read(path),
  };
  return { adapter, calls };
}

export interface Peer {
  node: VFSNode;
  fs: MemoryAdapter;
}

let clock = 1_700_000_000_000;

/** Strictly increasing timestamps, so mtime ordering is never ambiguous. */
export function tick(step = 1000): number {
  clock += step;
  return clock;
}

export async function peer(name: string): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, { id: name, now: () => tick() });
  return { node, fs };
}

export async function put(p: Peer, path: string, text: string): Promise<void> {
  await p.node.write(path, encoder.encode(text));
}

export async function get(p: Peer, path: string): Promise<string> {
  return decoder.decode(await p.node.read(path));
}

export function files(p: Peer): Record<string, string> {
  return p.fs.snapshot();
}

export async function treeOf(p: Peer): Promise<Record<string, string | null>> {
  const tree = await p.node.headTree();
  const out: Record<string, string | null> = {};
  for (const entry of tree.entries) {
    if (entry.deleted) continue;
    out[entry.path] = entry.hash;
  }
  return out;
}

export { decoder, encoder };
