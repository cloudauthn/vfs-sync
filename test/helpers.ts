import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
