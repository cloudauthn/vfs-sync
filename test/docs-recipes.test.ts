import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { VFSNode } from '../src/vfs-node.js';
import { concat } from '../src/stream.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// the exact function from docs/recipes.md#reading-a-file-header
async function id3(node: VFSNode, path: string) {
  const stat = await node.stat(path);
  if (!stat) return null;
  const head = await node.readRange(path, { end: 10 });
  if (decoder.decode(head.subarray(0, 3)) === 'ID3') {
    const size = (head[6]! << 21) | (head[7]! << 14) | (head[8]! << 7) | head[9]!;
    return { version: `2.${head[3]}.${head[4]}`, tagBytes: size + 10 };
  }
  if (stat.size < 128) return null;
  const tail = await node.readRange(path, { start: stat.size - 128 });
  if (decoder.decode(tail.subarray(0, 3)) !== 'TAG') return null;
  const field = (at: number, len: number) =>
    decoder.decode(tail.subarray(at, at + len)).replace(/\0+$/, '').trim();
  return { version: '1', title: field(3, 30), artist: field(33, 30) };
}

describe('docs/recipes.md — reading a file header', () => {
  it('parses an ID3v2 header', async () => {
    const node = await VFSNode.open(new MemoryAdapter('m'), { id: 'm' });
    const header = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 2, 1]);
    await node.write('a.mp3', concat([header, new Uint8Array(300)]));
    expect(await id3(node, 'a.mp3')).toEqual({ version: '2.4.0', tagBytes: 267 });
  });

  it('parses an ID3v1 trailer', async () => {
    const node = await VFSNode.open(new MemoryAdapter('m'), { id: 'm' });
    const tag = new Uint8Array(128);
    tag.set(encoder.encode('TAG'), 0);
    tag.set(encoder.encode('Blue Monday'), 3);
    tag.set(encoder.encode('New Order'), 33);
    await node.write('b.mp3', concat([new Uint8Array(5000), tag]));
    expect(await id3(node, 'b.mp3')).toEqual({ version: '1', title: 'Blue Monday', artist: 'New Order' });
  });

  it('returns null for a file with neither', async () => {
    const node = await VFSNode.open(new MemoryAdapter('m'), { id: 'm' });
    await node.write('c.mp3', new Uint8Array(500));
    expect(await id3(node, 'c.mp3')).toBeNull();
    expect(await id3(node, 'missing.mp3')).toBeNull();
  });
});
