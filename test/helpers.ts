import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import type { ByteRange, VFSAdapter, VFSEntry } from '../src/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Calls {
  list: string[];
  read: string[];
  stat: string[];
  write: string[];
  reset(): void;
}

/**
 * A pass-through adapter that tallies what it was asked for. On a remote backend
 * every one of these is a round trip, so the tallies are what `vfs.json` and the
 * explorer's caches exist to keep down.
 */
export function counting(base: VFSAdapter): { adapter: VFSAdapter; calls: Calls } {
  const calls: Calls = {
    list: [],
    read: [],
    stat: [],
    write: [],
    reset() {
      this.list.length = 0;
      this.read.length = 0;
      this.stat.length = 0;
      this.write.length = 0;
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
    write: (path, data) => {
      calls.write.push(path);
      return base.write(path, data);
    },
    delete: (path) => base.delete(path),
    rename: (from, to) => base.rename(from, to),
    mkdir: (path) => base.mkdir?.(path) ?? Promise.resolve(),
    readRange: (path, range?: ByteRange) => {
      calls.read.push(path);
      return base.readRange?.(path, range) ?? base.read(path);
    },
  };
  return { adapter, calls };
}

export interface Peer {
  node: VFSNode;
  fs: MemoryAdapter;
}

let clock = 1_700_000_000_000;

/**
 * Strictly increasing timestamps.
 *
 * v2 stamps entries with a hybrid logical clock — `max(now, highest seen + 1)`
 * — so ordering two edits is a matter of *when each peer recorded them*, not of
 * their filesystem mtimes. Driving `now` is therefore how a test scripts "A
 * edited before B", and `setMtime` no longer has anything to do with it.
 */
export function tick(step = 1000): number {
  clock += step;
  return clock;
}

/** Reads the clock without moving it. */
export function at(): number {
  return clock;
}

export async function peer(name: string, options: { rotateAt?: number } = {}): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, {
    id: name,
    now: () => tick(),
    ...(options.rotateAt !== undefined ? { rotateAt: options.rotateAt } : {}),
  });
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

/** Live entries as `path -> hash`, the shape most assertions want. */
export async function tracked(p: Peer): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const entry of await p.node.live()) out[entry.path] = entry.hash;
  return out;
}

export async function entryAt(p: Peer, path: string): Promise<VFSEntry | undefined> {
  return (await p.node.live()).find((entry) => entry.path === path);
}

export { decoder, encoder };
