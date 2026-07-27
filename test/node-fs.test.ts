import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFsAdapter } from '../src/adapters/node-fs.js';
import { sync } from '../src/sync.js';
import { VFSNode } from '../src/vfs-node.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'vfs-sync-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function node(name: string): Promise<VFSNode> {
  const adapter = await NodeFsAdapter.open(join(workspace, name), name);
  return VFSNode.open(adapter, { id: name });
}

describe('NodeFsAdapter', () => {
  it('implements the adapter contract', async () => {
    const adapter = await NodeFsAdapter.open(join(workspace, 'plain'));

    await adapter.write('docs/notes.md', encoder.encode('hello'));
    expect(decoder.decode(await adapter.read('docs/notes.md'))).toBe('hello');

    const stat = await adapter.stat('docs/notes.md');
    expect(stat).toMatchObject({ kind: 'file', size: 5 });

    expect(await adapter.list('')).toEqual([
      { name: 'docs', path: 'docs', kind: 'directory' },
    ]);

    await adapter.rename('docs/notes.md', 'moved.md');
    expect(await adapter.stat('docs/notes.md')).toBeNull();
    expect(decoder.decode(await adapter.read('moved.md'))).toBe('hello');

    await adapter.delete('moved.md');
    expect(await adapter.stat('moved.md')).toBeNull();
    expect(await adapter.list('missing')).toEqual([]);
  });

  it('syncs two real folders', async () => {
    const a = await node('device-a');
    const b = await node('device-b');

    await a.write('notes.md', encoder.encode('from A'));
    await b.write('todo.md', encoder.encode('from B'));

    await sync(a, b);

    expect(decoder.decode(await b.read('notes.md'))).toBe('from A');
    expect(decoder.decode(await a.read('todo.md'))).toBe('from B');
    expect(await a.state()).toBe(await b.state());
  });

  it('survives a reopen: state lives in .vfs, not in memory', async () => {
    const a = await node('device-a');
    await a.write('notes.md', encoder.encode('v1'));
    await a.commit();
    const state = await a.state();

    const reopened = await node('device-a');
    expect(await reopened.state()).toBe(state);
    expect(await reopened.commit()).toBeNull(); // nothing changed on disk
  });

  it('propagates a nested rename to the other folder', async () => {
    const a = await node('device-a');
    const b = await node('device-b');

    await a.write('docs/notes.md', encoder.encode('hello'));
    await sync(a, b);

    await a.rename('docs/notes.md', 'archive/2026/notes.md');
    await sync(a, b);

    expect(decoder.decode(await b.read('archive/2026/notes.md'))).toBe('hello');
    expect(await b.adapter.stat('docs/notes.md')).toBeNull();
  });
});
