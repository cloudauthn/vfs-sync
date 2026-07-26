import { describe, expect, it, vi } from 'vitest';
import { CONTROL_DIR } from '../src/index';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ExplorerModel } from '../explorer/src/model';
import type { BrowseSource, Peer } from '../explorer/src/model';
import { counting } from './helpers.js';
import type { Calls } from './helpers.js';

/**
 * The explorer's read-only `.vfs` view, exercised through the model — no DOM.
 * The store is listed a folder at a time, as it is unfolded, so most of what
 * these check is what *is not* read.
 */
async function openMemRoot(
  backend: BrowseSource['backend'] = 'memory',
): Promise<{ model: ExplorerModel; peer: Peer; calls: Calls }> {
  const { adapter, calls } = counting(new MemoryAdapter('counted'));
  const model = new ExplorerModel({ seed: null, localFolder: false });
  await model.boot();
  const source: BrowseSource = {
    key: 'test',
    label: 'Counted',
    icon: '🧪',
    backend,
    adapter,
    expanded: new Set(),
  };
  model.sources.push(source);
  model.activeSource = source.key;
  await model.openVfsTab(source, '', true); // initialise: writes the .vfs store
  const peer = model.activePeer();
  if (!peer) throw new Error('root did not open');
  return { model, peer, calls };
}

/** Unfold one row of the store and wait for the listing it asks for. */
async function unfold(model: ExplorerModel, peer: Peer, path: string): Promise<void> {
  model.toggleControl(peer, path);
  await vi.waitFor(() => expect(model.snapshotOf(peer.key).control?.get(path)).toBeDefined());
}

const names = (model: ExplorerModel, peer: Peer, dir: string): string[] =>
  (model.snapshotOf(peer.key).control?.get(dir) ?? []).map((entry) => entry.name);

describe('explorer .vfs view', () => {
  it('keeps the store out of the working tree and lists it only when opened', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');

    const before = model.snapshotOf(peer.key);
    expect(before.files.map((file) => file.path)).toEqual(['notes.md']);
    expect(before.control).toBeNull(); // folded: nothing has been read

    await unfold(model, peer, CONTROL_DIR);
    expect(names(model, peer, CONTROL_DIR)).toContain('config.json');
    expect(model.snapshotOf(peer.key).files.map((file) => file.path)).toEqual(['notes.md']);
  });

  it('unfolding a folder reads that folder and nothing under it', async () => {
    const { model, peer, calls } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();

    calls.reset();
    await unfold(model, peer, CONTROL_DIR);
    // One listing. Not `commits/`, not `objects/`, and above all not a folder per
    // two-character hash bucket — which is what a walk of the store would cost.
    expect(calls.list).toEqual([CONTROL_DIR]);
    expect(names(model, peer, CONTROL_DIR)).toContain('objects');
    expect(model.snapshotOf(peer.key).control?.get(`${CONTROL_DIR}/objects`)).toBeUndefined();

    calls.reset();
    await unfold(model, peer, `${CONTROL_DIR}/objects`);
    // Re-listing the folders already open is local and cheap; the buckets that
    // just appeared under `objects/` stay unread until they are asked for.
    expect(calls.list).toContain(`${CONTROL_DIR}/objects`);
    const buckets = names(model, peer, `${CONTROL_DIR}/objects`);
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      expect(calls.list).not.toContain(`${CONTROL_DIR}/objects/${bucket}`);
    }
  });

  it('on a remote backend a repaint re-lists nothing, and unfolding costs one listing', async () => {
    // The backend label is what picks the policy, so a memory adapter wearing
    // Drive's name keeps this test about the policy and not about the transport.
    const { model, peer, calls } = await openMemRoot('GDrive');
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();
    await unfold(model, peer, CONTROL_DIR);
    const inControl = (): string[] => calls.list.filter((path) => path.startsWith(CONTROL_DIR));

    calls.reset();
    await model.render(); // a repaint — one per auto-sync tick, with the row open
    expect(inControl()).toEqual([]);

    calls.reset();
    await unfold(model, peer, `${CONTROL_DIR}/objects`);
    expect(inControl()).toEqual([`${CONTROL_DIR}/objects`]); // just the one opened

    calls.reset();
    await model.reload(); // and the refresh button is what re-reads them
    expect(inControl()).toContain(CONTROL_DIR);
    expect(inControl()).toContain(`${CONTROL_DIR}/objects`);
  });

  it('a commit’s objects appear in the folders that are open', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await unfold(model, peer, CONTROL_DIR);
    expect(names(model, peer, CONTROL_DIR)).not.toContain('objects');

    await peer.node.commit();
    await model.render();
    expect(names(model, peer, CONTROL_DIR)).toContain('objects');
    expect(names(model, peer, CONTROL_DIR)).toContain('commits');
  });

  it('shows a store file read-only: hashed and previewed, untracked, not compared', async () => {
    const { model, peer } = await openMemRoot();
    await model.select(peer, { path: `${CONTROL_DIR}/config.json`, kind: 'file' });

    const details = model.details;
    expect(details?.control).toBe(true);
    expect(details?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(details?.text).toContain('"storeId"');
    expect(details?.entry).toBeUndefined(); // the store never tracks itself
    expect(details?.across).toEqual([]);
    // selecting inside `.vfs` unfolds it, so the row is where the details say
    expect(peer.controlExpanded.has(CONTROL_DIR)).toBe(true);
  });

  it('an object’s checksum is the name it is filed under, unfolded or not', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();

    // Ask the commit which object holds the file: a store also keeps its tree
    // under objects/, and that one's hash moves with every run.
    const blob = (await peer.node.headTree()).entries[0]?.hash;
    if (!blob) throw new Error('commit stored no object for the file');
    // Deep in a folder nobody has unfolded — the details pane still resolves it.
    const path = `${CONTROL_DIR}/objects/${blob.slice(0, 2)}/${blob}`;
    await model.select(peer, { path, kind: 'file' });

    expect(model.details?.hash).toBe(blob);
    // an extensionless blob still previews, because the bytes read as text
    expect(model.details?.text).toBe('# notes\n');
  });

  it('counts the children of a store folder, not everything beneath it', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();
    await model.select(peer, { path: CONTROL_DIR, kind: 'directory' });

    const inside = model.snapshotOf(peer.key).control?.get(CONTROL_DIR) ?? [];
    expect(inside.length).toBeGreaterThan(1);
    expect(model.details?.control).toBe(true);
    expect(model.details?.count).toBe(inside.length);
    expect(model.details?.bytes).toBe(
      inside.reduce((sum, entry) => sum + (entry.stat?.size ?? 0), 0),
    );
  });

  it('refuses every write into the store, whatever asks for it', async () => {
    const { model, peer } = await openMemRoot();
    const path = `${CONTROL_DIR}/config.json`;
    const before = await peer.adapter.read(path);

    await model.write(peer, path, 'clobbered');
    expect(await peer.adapter.read(path)).toEqual(before);
    expect(model.lastKind).toBe('warn');

    // rename and delete refuse before they ever reach a prompt
    await model.renameFile(peer, path);
    await model.deleteFile(peer, path);
    expect(await peer.adapter.read(path)).toEqual(before);
  });
});
