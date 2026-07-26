import { describe, expect, it, vi } from 'vitest';
import { CONTROL_DIR } from '../src/index';
import { ExplorerModel } from '../explorer/src/model';
import type { Peer } from '../explorer/src/model';

/**
 * The explorer's read-only `.vfs` view, exercised through the model — no DOM.
 * MemFS is the one backend that needs neither a browser API nor a permission,
 * so a booted model can open a root on it and drive the real code paths.
 */
async function openMemRoot(): Promise<{ model: ExplorerModel; peer: Peer }> {
  const model = new ExplorerModel({ seed: null, localFolder: false });
  await model.boot();
  const source = model.sources.find((candidate) => candidate.key === 'mem');
  if (!source) throw new Error('MemFS source missing');
  await model.openVfsTab(source, '', true); // initialise: writes the .vfs store
  const peer = model.activePeer();
  if (!peer) throw new Error('root did not open');
  return { model, peer };
}

/** Unfold `.vfs` and wait for the listing its opening kicks off. */
async function openControl(model: ExplorerModel, peer: Peer): Promise<void> {
  model.toggleControl(peer, CONTROL_DIR);
  await vi.waitFor(() => expect(model.snapshotOf(peer.key).control).not.toBeNull());
}

describe('explorer .vfs view', () => {
  it('keeps the store out of the working tree and lists it only when opened', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');

    const before = model.snapshotOf(peer.key);
    expect(before.files.map((file) => file.path)).toEqual(['notes.md']);
    expect(before.control).toBeNull(); // folded: nothing has been read

    await openControl(model, peer);
    const control = model.snapshotOf(peer.key).control ?? [];
    expect(control.map((file) => file.path)).toContain(`${CONTROL_DIR}/config.json`);
    // every row is addressed under .vfs, and the working tree is untouched
    expect(control.every((file) => file.path.startsWith(`${CONTROL_DIR}/`))).toBe(true);
    expect(model.snapshotOf(peer.key).files.map((file) => file.path)).toEqual(['notes.md']);
  });

  it('re-reads the store while it is open, so a commit’s objects appear', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await openControl(model, peer);
    expect(model.snapshotOf(peer.key).control?.some((f) => f.path.includes('/objects/'))).toBe(
      false,
    );

    await peer.node.commit();
    await model.render();
    const control = model.snapshotOf(peer.key).control ?? [];
    expect(control.some((file) => file.path.includes('/objects/'))).toBe(true);
    expect(control.some((file) => file.path.includes('/commits/'))).toBe(true);
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

  it('an object’s checksum is the name it is filed under', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();
    await openControl(model, peer);

    const object = (model.snapshotOf(peer.key).control ?? []).find((file) =>
      file.path.includes('/objects/'),
    );
    if (!object) throw new Error('commit stored no object');
    await model.select(peer, { path: object.path, kind: 'file' });
    expect(model.details?.hash).toBe(object.path.slice(object.path.lastIndexOf('/') + 1));
    // an extensionless blob still previews, because the bytes read as text
    expect(model.details?.text).toBe('# notes\n');
  });

  it('rolls the whole store up under its own row', async () => {
    const { model, peer } = await openMemRoot();
    await model.write(peer, 'notes.md', '# notes\n');
    await peer.node.commit();
    await model.select(peer, { path: CONTROL_DIR, kind: 'directory' });

    const control = model.snapshotOf(peer.key).control ?? [];
    expect(control.length).toBeGreaterThan(1);
    expect(model.details?.control).toBe(true);
    expect(model.details?.count).toBe(control.length);
    expect(model.details?.bytes).toBe(control.reduce((sum, file) => sum + file.stat.size, 0));
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
