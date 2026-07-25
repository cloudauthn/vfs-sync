import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/sync.js';
import { sha256 } from '../src/hash.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let clock = 1_700_000_000_000;
const tick = (): number => (clock += 1000);

interface Peer {
  node: VFSNode;
  fs: MemoryAdapter;
}

/** A peer whose store treats the working folder as the blob store. */
async function reconstructPeer(name: string): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, { id: name, now: () => tick(), reconstructBlobs: true });
  return { node, fs };
}

async function normalPeer(name: string): Promise<Peer> {
  const fs = new MemoryAdapter(name, { clock: () => tick() });
  const node = await VFSNode.open(fs, { id: name, now: () => tick() });
  return { node, fs };
}

const put = (p: Peer, path: string, text: string): Promise<void> =>
  p.node.write(path, encoder.encode(text));
const files = (p: Peer): Record<string, string> => p.fs.snapshot();

describe('reconstruct mode (working folder as blob store)', () => {
  it('does not duplicate a file into objects/, but still reads it back', async () => {
    const p = await reconstructPeer('r');
    await put(p, 'notes.md', 'hello');
    await p.node.commit();

    const hash = await sha256(encoder.encode('hello'));
    // The blob is not copied under objects/ …
    expect(await p.node.store.hasStoredObject(hash)).toBe(false);
    // … yet the store reports it present and reconstructs it from the file.
    expect(await p.node.store.hasObject(hash)).toBe(true);
    expect(decoder.decode(await p.node.store.getObject(hash))).toBe('hello');
  });

  it('syncs two reconstruct peers to identical content', async () => {
    const a = await reconstructPeer('a');
    const b = await reconstructPeer('b');
    await put(a, 'notes.md', '# notes');
    await put(a, 'docs/readme.md', 'read me');
    await sync(a.node, b.node);

    expect(files(b)).toEqual(files(a));
    expect(files(b)['docs/readme.md']).toBe('read me');
  });

  it('syncs a reconstruct peer with a normal peer', async () => {
    const drive = await reconstructPeer('drive'); // stands in for Google Drive
    const mem = await normalPeer('mem');
    await put(drive, 'a.txt', 'from drive');
    await put(mem, 'b.txt', 'from mem');
    await sync(drive.node, mem.node);

    expect(files(drive)).toEqual(files(mem));
    expect(files(mem)['a.txt']).toBe('from drive');
    expect(files(drive)['b.txt']).toBe('from mem');
  });

  it('keeps the conflict loser as a copy even though its blob was never stored', async () => {
    const a = await reconstructPeer('a');
    const b = await reconstructPeer('b');
    await put(a, 'notes.md', 'seed');
    await sync(a.node, b.node); // common ancestor

    await put(a, 'notes.md', 'from a');
    a.fs.setMtime('notes.md', 5_000);
    await put(b, 'notes.md', 'from b');
    b.fs.setMtime('notes.md', 9_000);

    const result = await sync(a.node, b.node);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe('b');

    // Winner content everywhere, and the loser ('from a') survives as a copy —
    // which on the losing peer means its own about-to-be-overwritten file had to
    // be pinned before the winner landed on top of it.
    expect(files(a)['notes.md']).toBe('from b');
    const copyOnA = Object.entries(files(a)).find(([path]) => path.includes('conflict'));
    expect(copyOnA?.[1]).toBe('from a');
    expect(files(b)).toEqual(files(a));
  });
});
