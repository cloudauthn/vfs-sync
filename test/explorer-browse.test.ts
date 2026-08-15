import { describe, expect, it, vi } from 'vitest';
import { browsing, encoder, prompting } from './explorer-model.js';
import { ExplorerModel } from '../explorer/src/model';
import type { BrowseSource } from '../explorer/src/model';
import { FSAAdapter } from '../src/adapters/fsa.js';
import { FakeDirectoryHandle } from './fake-handle.js';

/**
 * The tabs and folders a person opens, closes and deletes.
 *
 * `explorer-cache.test.ts` asks what the browse column *reads*; this asks what
 * it destroys. Two of these methods take something back that nothing can
 * return — a folder and everything under it, and every tab of a filesystem —
 * and until now nothing called either of them.
 */

/** The open tabs, by key — `source:path`, which is how a root is addressed. */
const tabs = (model: ExplorerModel): string[] => model.peers.map((peer) => peer.key);

/**
 * A picked local folder whose permission answers as told — the one source kind
 * that can go unreadable mid-session, and the only browser API in this file.
 */
function localFolder(state: PermissionState, onRequest: PermissionState): BrowseSource {
  const root = new FakeDirectoryHandle('picked') as never as Record<string, unknown>;
  root.queryPermission = async (): Promise<PermissionState> => state;
  root.requestPermission = async (): Promise<PermissionState> => onRequest;
  const fsa = FSAAdapter.fromHandle(root as never);
  return {
    key: `local-${onRequest}`,
    label: 'Picked folder',
    icon: '📁',
    backend: 'local folder',
    adapter: fsa,
    fsa,
    expanded: new Set(),
  };
}

describe('deleting a browsed folder', () => {
  it('closes the tab on it and the tabs inside it, and leaves a sibling that shares its name', async () => {
    // `one-b` is the whole point: a prefix match without the slash takes it too.
    const { model, source, base } = await browsing(['one', 'one-b', 'one/inner']);
    await model.openVfsTab(source, 'one');
    await model.openVfsTab(source, 'one/inner');
    await model.openVfsTab(source, 'one-b');
    expect(tabs(model)).toEqual(['test:one', 'test:one/inner', 'test:one-b']);

    const person = prompting(model, () => true);
    await model.deleteBrowseEntry(source, 'one', 'directory');
    person.stop();

    expect(tabs(model)).toEqual(['test:one-b']);
    expect(await base.stat('one/notes.md')).toBeNull();
    expect(await base.stat('one/inner/notes.md')).toBeNull();
    expect(await base.stat('one-b/notes.md')).not.toBeNull();
  });

  it('says which folder it is about, and that everything inside goes with it', async () => {
    const { model, source } = await browsing();
    const person = prompting(model, () => true);
    await model.deleteBrowseEntry(source, 'one', 'directory');
    person.stop();

    // The last sentence a person reads before losing a folder.
    expect(person.last?.title).toBe('Delete folder');
    expect(person.last?.message).toBe('Delete one and everything inside it?');
  });

  it('deletes nothing and closes no tab when the confirm is declined', async () => {
    const { model, source, base, calls } = await browsing();
    await model.openVfsTab(source, 'one');
    calls.reset();

    const person = prompting(model, () => false);
    await model.deleteBrowseEntry(source, 'one', 'directory');
    person.stop();

    expect(tabs(model)).toEqual(['test:one']);
    expect(await base.stat('one/notes.md')).not.toBeNull();
    // No cache was dropped and no tree was rebuilt, so nothing was re-listed:
    // a decline costs the backend nothing at all.
    expect(calls.list).toEqual([]);
  });
});

describe('deleting a browsed file', () => {
  it('takes the file, and does not promise to take anything inside it', async () => {
    const { model, source, base } = await browsing();
    // The details pane's Delete button hands over whatever is selected, and a
    // file can be selected — which is how the folder-only wording was reached.
    model.selectBrowse(source, 'one/notes.md', 'file');
    await vi.waitFor(() => expect(model.newTab?.details.kind).toBe('file'));
    const data = model.newTab?.details;
    if (!data || data.kind === 'intro') throw new Error('the details pane selected nothing');

    const person = prompting(model, () => true);
    await model.deleteBrowseEntry(source, data.path, data.kind);
    person.stop();

    expect(person.last?.title).toBe('Delete file');
    expect(person.last?.message).toBe('Delete one/notes.md?');
    expect(person.last?.message).not.toContain('everything inside it');
    expect(await base.stat('one/notes.md')).toBeNull();
    expect(model.browseSel).toBeNull();
  });
});

describe('closing a tab', () => {
  it('activates a neighbour and drops what described the root that is gone', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    await model.openVfsTab(source, 'two');
    const [one, two] = model.peers;
    if (!one || !two) throw new Error('expected two tabs');

    await model.select(two, { path: 'notes.md', kind: 'file' });
    model.markDirty('half-typed, never saved\n');
    expect(model.active).toBe(two.key);

    await model.closePeer(two);

    expect(model.active).toBe(one.key);
    // A selection, a details pane and an unsaved edit belonging to a root that
    // is no longer open would all be describing nothing.
    expect(model.selection).toBeNull();
    expect(model.details).toBeNull();
    expect(model.dirty).toBe(false);
  });

  it('leaves the active tab and its selection alone when another one closes', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    await model.openVfsTab(source, 'two');
    const [one, two] = model.peers;
    if (!one || !two) throw new Error('expected two tabs');
    await model.select(two, { path: 'notes.md', kind: 'file' });

    await model.closePeer(one);

    expect(tabs(model)).toEqual([two.key]);
    expect(model.active).toBe(two.key);
    expect(model.selection?.path).toBe('notes.md');
  });

  it('falls back to the new-tab view when the last one closes', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    const [only] = model.peers;
    if (!only) throw new Error('expected one tab');

    await model.closePeer(only);

    expect(tabs(model)).toEqual([]);
    expect(model.active).toBe(''); // '' is the new tab
  });
});

describe('forgetting a filesystem', () => {
  it('closes every tab it opened and stops being the source anything points at', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    await model.openVfsTab(source, 'two');
    model.selectBrowse(source, 'one', 'directory');

    await model.removeSource(source);

    expect(tabs(model)).toEqual([]);
    expect(model.sources.some((entry) => entry.key === source.key)).toBe(false);
    expect(model.activeSource).toBe('mem'); // the first one left in the switcher
    expect(model.browseSel).toBeNull();
  });

  it('leaves the tabs of every other filesystem open', async () => {
    const { model, source } = await browsing();
    const mem = model.sources.find((entry) => entry.key === 'mem');
    if (!mem?.adapter) throw new Error('no memory source');
    await mem.adapter.write('other/notes.md', encoder.encode('# other\n'));
    await model.openVfsTab(mem, 'other', true);
    await model.openVfsTab(source, 'one');

    await model.removeSource(source);

    expect(tabs(model)).toEqual(['mem:other']);
  });
});

describe('creating a browsed folder', () => {
  it('creates it inside whatever is selected', async () => {
    const { model, source, base } = await browsing();
    const person = prompting(model, () => 'sub');

    // A picked folder is the parent.
    model.selectBrowse(source, 'one', 'directory');
    await model.newBrowseFolder(source);
    expect((await base.stat('one/sub'))?.kind).toBe('directory');

    // A picked file contributes its folder, not itself.
    model.selectBrowse(source, 'two/notes.md', 'file');
    await model.newBrowseFolder(source);
    expect((await base.stat('two/sub'))?.kind).toBe('directory');

    // Nothing picked means the root of the filesystem.
    model.browseSel = null;
    await model.newBrowseFolder(source);
    person.stop();
    expect((await base.stat('sub'))?.kind).toBe('directory');
  });

  it('reveals the new folder without asking the backend what is in it', async () => {
    const { model, source, calls } = await browsing();
    model.selectBrowse(source, 'one', 'directory');
    calls.reset();

    const person = prompting(model, () => 'a/b');
    await model.newBrowseFolder(source);
    person.stop();

    // Every ancestor unfolds, so the new folder is on screen where it was made.
    expect([...source.expanded]).toEqual(expect.arrayContaining(['one', 'one/a']));
    // It was just created, so it is known-empty and known to hold no store:
    // nothing under it is listed, and its header is never probed.
    expect(calls.read.filter((path) => path.startsWith('one/a'))).toEqual([]);
    expect(calls.list.filter((path) => path.startsWith('one/a/b'))).toEqual([]);
  });

  it('creates nothing when the prompt is cancelled', async () => {
    const { model, source, base } = await browsing();
    const person = prompting(model, () => null);
    await model.newBrowseFolder(source);
    person.stop();

    expect(await base.stat('new-folder')).toBeNull();
  });
});

describe('the source switcher', () => {
  it('re-reads a filesystem when its own chip is clicked again, and not when another one is', async () => {
    const { model, source, calls } = await browsing();
    const mem = model.sources.find((entry) => entry.key === 'mem');
    if (!mem) throw new Error('no memory source');
    calls.reset();

    // Away and back: this filesystem was not the one clicked, so its listings
    // are still good and nothing is re-read.
    model.selectSource(mem);
    await vi.waitFor(() => expect(model.newTabLoading).toBe(false));
    model.selectSource(source);
    await vi.waitFor(() => expect(model.newTabLoading).toBe(false));
    expect(calls.list).toEqual([]);

    // Clicking the chip that is already open is the refresh gesture.
    model.selectSource(source);
    await vi.waitFor(() => expect(model.newTabLoading).toBe(false));
    expect(calls.list).toContain('');
  });

  it('reports both answers when a local folder’s permission is re-requested', async () => {
    const { model } = await browsing();

    const granted = localFolder('prompt', 'granted');
    model.sources.push(granted);
    await model.regrantSource(granted);
    expect(model.lastMessage).toContain('is readable again');

    const denied = localFolder('prompt', 'denied');
    model.sources.push(denied);
    await model.regrantSource(denied);
    expect(model.lastMessage).toContain('permission denied');
  });
});

describe('the activity log', () => {
  it('counts what was missed while it was shut, and empties on clear', async () => {
    const model = new ExplorerModel({ seed: null, localFolder: false });
    await model.boot();
    const missed = model.logCount;

    model.log('something happened');
    expect(model.logCount).toBe(missed + 1);

    model.toggleLog(true);
    expect(model.logOpen).toBe(true);
    expect(model.logCount).toBe(0); // reading them is what clears the badge

    model.clearLog();
    expect(model.logs).toEqual([]);
    expect(model.logCount).toBe(0);
  });

  it('stays shut when the host asked for no activity log', async () => {
    const model = new ExplorerModel({ seed: null, localFolder: false, activityLog: false });
    await model.boot();

    model.toggleLog(true);

    expect(model.logOpen).toBe(false);
  });
});

describe('the sidebar of an open root', () => {
  it('folds and unfolds a folder without reading the backend', async () => {
    const { model, source, calls } = await browsing();
    await model.openVfsTab(source, 'one');
    const peer = model.activePeer();
    if (!peer) throw new Error('tab did not open');
    calls.reset();

    model.toggleDir(peer, 'sub', false);
    expect(peer.collapsed.has('sub')).toBe(true);
    model.toggleDir(peer, 'sub', true);
    expect(peer.collapsed.has('sub')).toBe(false);

    // The tree is painted from what the root already knows.
    expect(calls.list).toEqual([]);
    expect(calls.read).toEqual([]);
  });

  it('clears the file selection when the root itself is picked', async () => {
    const { model, source } = await browsing();
    await model.openVfsTab(source, 'one');
    const peer = model.activePeer();
    if (!peer) throw new Error('tab did not open');
    await model.select(peer, { path: 'notes.md', kind: 'file' });
    expect(model.selection?.path).toBe('notes.md');

    await model.selectRoot(peer);

    expect(model.selection).toBeNull();
  });
});

describe('a local folder whose permission lapsed', () => {
  it('reports both answers for an open tab too, not only for the source it came from', async () => {
    const { model } = await browsing();
    const source = localFolder('prompt', 'granted');
    model.sources.push(source);
    await model.openVfsTab(source, 'picked', true);
    const peer = model.activePeer();
    if (!peer?.fsa) throw new Error('the tab did not inherit the folder’s handle');

    await model.regrant(peer);
    expect(model.lastMessage).toContain('is readable again');

    // Same tab, same handle, and the person says no this time.
    const denied = localFolder('prompt', 'denied');
    await model.regrant({ ...peer, fsa: denied.fsa });
    expect(model.lastMessage).toContain('permission denied');
  });
});

describe('when the backend refuses a delete', () => {
  it('leaves the tabs closed and the folder standing, and says why', async () => {
    const { model, source, base } = await browsing();
    await model.openVfsTab(source, 'one');
    if (!source.adapter) throw new Error('no adapter');
    source.adapter = {
      ...source.adapter,
      delete: () => Promise.reject(new Error('backend refused')),
    };

    const person = prompting(model, () => true);
    await model.deleteBrowseEntry(source, 'one', 'directory');
    person.stop();

    // The tabs close *before* the delete is attempted, so a refusal leaves the
    // folder on disk with nothing open on it. That is the deliberate order:
    // closing afterwards would leave tabs pointing at a folder mid-deletion,
    // and reopening one is a click. Pinned here so the trade stays a choice.
    expect(tabs(model)).toEqual([]);
    expect(await base.stat('one/notes.md')).not.toBeNull();
    expect(model.lastMessage).toContain('backend refused');
  });
});
