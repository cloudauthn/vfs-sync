import { afterEach, describe, expect, it } from 'vitest';
import {
  clearGoogleToken,
  googleTokenExpiry,
  googleTokenProvider,
  hasCachedGoogleToken,
} from '../explorer/src/gis';
import { ExplorerModel } from '../explorer/src/model';
import type { ExplorerOptions } from '../explorer/src/model';
import { FSAAdapter } from '../src/adapters/fsa.js';
import { VFSNode } from '../src/vfs-node.js';
import { fakeGis, fakeStorage, stub, unstub } from './browser-globals.js';
import type { FakeGis, FakeStorage, TokenResponse } from './browser-globals.js';
import { makeFakeDrive } from './fake-drive.js';
import { prompting } from './explorer-model.js';
import { FakeDirectoryHandle } from './fake-handle.js';

/**
 * The four places a person **grants** something: two folder pickers, and the
 * Google token behind Drive.
 *
 * They were the last of the explorer that nothing drove, and they were left
 * alone for three sessions on the belief that they needed fakes nobody had
 * written. Most of those fakes were already here — see §0 of this session — so
 * what is new is the scripted token client and the Map behind `localStorage`,
 * both in `browser-globals.ts`.
 *
 * The model itself touches no browser global (checked: `window`, `document`,
 * `localStorage` and `navigator` appear in `model.ts` once, in a comment), so
 * stubbing one here cannot reach anything but the code under test.
 */

/** A folder on disk, with the permission the browser would report for it. */
function folder(name: string, permission: PermissionState = 'granted'): FakeDirectoryHandle {
  const root = new FakeDirectoryHandle(name);
  Object.assign(root, {
    queryPermission: async (): Promise<PermissionState> => permission,
    requestPermission: async (): Promise<PermissionState> => permission,
  });
  return root;
}

/** The folder chooser, answering with a handle — or refusing the way it does. */
function picker(answer: FakeDirectoryHandle | Error): void {
  stub('window', {
    showDirectoryPicker: async (): Promise<FakeDirectoryHandle> => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
}

/** What the browser throws when the person closes the chooser. */
function aborted(): Error {
  return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
}

async function explorer(options: ExplorerOptions = {}): Promise<ExplorerModel> {
  const model = new ExplorerModel({ seed: null, localFolder: false, ...options });
  await model.boot();
  return model;
}

afterEach(() => unstub('window', 'localStorage', 'fetch'));

describe('picking a filesystem to browse', () => {
  it('puts the chosen folder in the switcher, and looks at it', async () => {
    const model = await explorer();
    // Something is selected in the filesystem that was open before, so that
    // "the selection is cleared" is a change and not the state it started in.
    model.browseSel = { source: 'mem', path: 'somewhere', kind: 'directory' };
    picker(folder('Documents'));

    await model.pickFsaSource();

    const source = model.sources.at(-1);
    expect(source).toMatchObject({ label: 'Documents', backend: 'local folder', removable: true });
    expect(source?.key).toMatch(/^fsa:/);
    expect(model.activeSource).toBe(source?.key);
    // It belonged to the other filesystem, and the browse pane is now showing
    // this one: a selection that survived would point at a row nobody can see.
    expect(model.browseSel).toBeNull();
    expect(model.lastMessage).toBe('browsing Documents from disk');
  });

  it('adds nothing when the folder is picked but not granted', async () => {
    const model = await explorer();
    const before = model.sources.length;
    picker(folder('Secret', 'denied'));

    await model.pickFsaSource();

    expect(model.sources).toHaveLength(before);
    expect(model.lastMessage).toBe('permission denied for that folder');
  });

  it('says nothing at all when the person closes the chooser', async () => {
    const model = await explorer();
    const quiet = model.logs.length;
    picker(aborted());

    await model.pickFsaSource();

    // The absence is the behaviour: a warning in the log for every time somebody
    // opened the picker and changed their mind is noise, and this is the one
    // place a swallowed error is right.
    expect(model.logs).toHaveLength(quiet);
  });

  it('but says so when the picker fails for any other reason', async () => {
    const model = await explorer();
    picker(new Error('the disk went away'));

    await model.pickFsaSource();

    expect(model.lastMessage).toContain('the disk went away');
    expect(model.logs[0]?.kind).toBe('warn');
  });
});

describe('opening a folder from disk as a tab', () => {
  it('opens a folder that is already a vFS root without asking anything', async () => {
    const root = folder('Notes');
    await VFSNode.open(FSAAdapter.fromHandle(root as never, 'Notes'), { id: 'Notes' });
    const model = await explorer();
    picker(root);

    // Answers yes to anything, so a confirm that appeared would still open the
    // tab — what fails is the assertion that nobody was asked.
    const person = prompting(model, () => true);
    await model.pickFsaVfs();
    person.stop();

    expect(person.titles).toEqual([]);
    expect(model.peers.map((peer) => peer.label)).toEqual(['Notes']);
    expect(model.lastMessage).toBe('opened Notes from disk');
  });

  it('asks before writing a store into a folder that holds none', async () => {
    const root = folder('Fresh');
    const model = await explorer();
    picker(root);

    const person = prompting(model, () => true);
    await model.pickFsaVfs();
    person.stop();

    expect(person.last?.title).toBe('Initialise vFS root');
    // The folder is named in the question: it is a write into a folder of
    // theirs, and the picker is the only thing that knows which one.
    expect(person.last?.message).toContain('Fresh');
    expect(model.peers.map((peer) => peer.label)).toEqual(['Fresh']);
    expect(model.lastMessage).toBe('initialised Fresh as vFS');
    expect(root.children.has('.vfs')).toBe(true);
  });

  it('writes nothing into the folder when the question is declined', async () => {
    const root = folder('Untouched');
    const model = await explorer();
    picker(root);

    const person = prompting(model, () => false);
    await model.pickFsaVfs();
    person.stop();

    expect(model.peers).toHaveLength(0);
    // Asserted on the folder, not on the log: what matters is that a folder
    // somebody declined to convert is byte-for-byte as it was.
    expect(root.children.has('.vfs')).toBe(false);
    expect([...root.children.keys()]).toEqual([]);
  });

  it('is silent about a closed chooser here too, and loud about anything else', async () => {
    const model = await explorer();
    const quiet = model.logs.length;

    picker(aborted());
    await model.pickFsaVfs();
    expect(model.logs).toHaveLength(quiet);

    // The same two arms as the browse picker, in the method beside it. They are
    // separate code and were separately unreached: one of them swallowing
    // everything would be invisible from the other's tests.
    picker(new Error('the folder went away'));
    await model.pickFsaVfs();
    expect(model.lastMessage).toContain('the folder went away');
    expect(model.peers).toHaveLength(0);
  });

  it('opens no tab when the folder is not granted', async () => {
    const root = folder('Locked', 'denied');
    const model = await explorer();
    picker(root);

    await model.pickFsaVfs();

    expect(model.peers).toHaveLength(0);
    expect(root.children.has('.vfs')).toBe(false);
    expect(model.lastMessage).toBe('permission denied for that folder');
  });
});

// ------------------------------------------------------------------- Drive

const CLIENT = 'client-1';
const SCOPE = 'scope-x';
const drive: ExplorerOptions = { gdriveClientId: CLIENT, gdriveScope: SCOPE };
const tokenKey = `vfs-explorer:gtoken:${CLIENT}:${SCOPE}`;

/**
 * Google, web storage and Drive itself, all stubbed together.
 *
 * `fetch` goes in for every one of these and not only the test that reads a
 * file: connecting sets the Drive source active, and the render that follows
 * lists its root. A test that left the global alone would reach the network.
 */
function googleIsThere(...responses: TokenResponse[]): {
  gis: FakeGis;
  storage: FakeStorage;
  /** The `Authorization` header of every request Drive received. */
  bearers: string[];
} {
  const gis = fakeGis(...responses);
  const storage = fakeStorage();
  const fake = makeFakeDrive();
  const bearers: string[] = [];
  stub('localStorage', storage);
  stub('window', { google: gis.google });
  stub('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    bearers.push(new Headers(init?.headers).get('Authorization') ?? '');
    return fake.fetch(input, init);
  }) as typeof fetch);
  return { gis, storage, bearers };
}

describe('connecting Google Drive', () => {
  it('says so and adds nothing when no client id is configured', async () => {
    googleIsThere({ access_token: 'never asked for' });
    const model = await explorer(); // no gdriveClientId
    const before = model.sources.length;

    await model.connectGDrive();

    expect(model.canGDrive).toBe(false);
    expect(model.sources).toHaveLength(before);
    expect(model.lastMessage).toContain('VITE_GDRIVE_CLIENT_ID');
  });

  it('asks Google for a token, and puts the drive in the switcher', async () => {
    const { gis } = googleIsThere({ access_token: 'tok-1', expires_in: 3600 });
    const model = await explorer(drive);

    await model.connectGDrive();

    expect(gis.clients).toEqual([{ client_id: CLIENT, scope: SCOPE }]);
    // The empty prompt is the whole of the "no second consent screen" promise:
    // it asks the first time and is silent afterwards while the grant stands.
    expect(gis.requests).toEqual([{ prompt: '' }]);
    expect(model.sources.at(-1)).toMatchObject({ label: 'Google Drive', backend: 'GDrive' });
    expect(model.canGDrive).toBe(true);
    expect(model.gdriveConnected).toBe(true);
    expect(model.lastMessage).toBe('connected Google Drive');
  });

  it('reconnecting refreshes in place instead of adding a second drive', async () => {
    const { gis } = googleIsThere({ access_token: 'tok-1', expires_in: 3600 });
    const model = await explorer(drive);

    await model.connectGDrive();
    const after = model.sources.length;
    await model.connectGDrive();

    expect(model.sources).toHaveLength(after);
    expect(model.sources.filter((source) => source.backend === 'GDrive')).toHaveLength(1);
    // The provider is reused, so the live token is served from its closure: no
    // second client, and no second popup. A fresh provider would have asked
    // again with the adapter still holding the old one.
    expect(gis.clients).toHaveLength(1);
    expect(gis.requests).toHaveLength(1);
    expect(model.lastMessage).toBe('refreshed Google Drive');
  });

  it('holds the live token in the drive, not in web storage', async () => {
    const { gis, storage } = googleIsThere({ access_token: 'tok-1', expires_in: 3600 });
    const model = await explorer(drive);

    await model.connectGDrive();
    const asked = gis.requests.length;

    // Storage goes away mid-session: cleared site data, a full quota, a private
    // window. The live token is in the provider the drive in the switcher is
    // holding, so reconnecting costs nothing — where a provider minted afresh
    // from storage would have to send the person back to Google for a token
    // they already granted.
    storage.map.clear();
    await model.connectGDrive();

    expect(gis.requests).toHaveLength(asked);
    expect(gis.clients).toHaveLength(1);
    expect(model.sources.filter((source) => source.backend === 'GDrive')).toHaveLength(1);
    expect(model.lastMessage).toBe('refreshed Google Drive');
  });

  it('leaves the switcher alone when Google refuses', async () => {
    googleIsThere({ error: 'access_denied' });
    const model = await explorer(drive);
    const before = model.sources.length;

    await model.connectGDrive();

    expect(model.sources).toHaveLength(before);
    expect(model.gdriveConnected).toBe(false);
    expect(model.lastMessage).toContain('access_denied');
  });

  it('builds a drive that works, with the token it was just granted', async () => {
    const { bearers } = googleIsThere({ access_token: 'tok-1', expires_in: 3600 });
    const model = await explorer(drive);

    await model.connectGDrive();
    const source = model.sources.find((entry) => entry.backend === 'GDrive');
    await source?.adapter?.write('hello.txt', new TextEncoder().encode('from the explorer\n'));

    expect(await source?.adapter?.list('')).toMatchObject([{ name: 'hello.txt', kind: 'file' }]);
    // The token Google handed over is the one Drive is asked with. Everything
    // else here is bookkeeping; this is the wire.
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.every((header) => header === 'Bearer tok-1')).toBe(true);
  });
});

describe('re-attaching Drive on boot', () => {
  it('restores a cached session without going near a popup', async () => {
    const { gis, storage } = googleIsThere({ access_token: 'not needed' });
    storage.map.set(
      tokenKey,
      JSON.stringify({ token: 'cached-token', expiresAt: Date.now() + 3_600_000 }),
    );

    const model = await explorer(drive);

    expect(model.sources.filter((source) => source.backend === 'GDrive')).toHaveLength(1);
    // Boot has no user gesture behind it, so a popup here would be blocked by
    // the browser and would be wrong even if it were not: nothing is asked.
    expect(gis.clients).toEqual([]);
    expect(gis.requests).toEqual([]);
    expect(model.lastMessage).toBe('restored Google Drive session');
  });

  it('restores nothing, and says nothing, when the cached token has expired', async () => {
    const { gis, storage } = googleIsThere({ access_token: 'not needed' });
    storage.map.set(tokenKey, JSON.stringify({ token: 'stale', expiresAt: Date.now() - 1000 }));

    const model = await explorer(drive);

    expect(model.sources.filter((source) => source.backend === 'GDrive')).toEqual([]);
    expect(gis.clients).toEqual([]);
    expect(model.logs.some((entry) => entry.message.includes('Drive'))).toBe(false);
  });
});

describe('the token itself', () => {
  it('serves the cached one, and only opens the popup inside the last minute', async () => {
    const { gis, storage } = googleIsThere({ access_token: 'fresh', expires_in: 3600 });

    storage.map.set(tokenKey, JSON.stringify({ token: 'cached', expiresAt: Date.now() + 120_000 }));
    expect(await googleTokenProvider(CLIENT, SCOPE)()).toBe('cached');
    expect(gis.requests).toEqual([]);

    // Half a minute left is treated as expired: a call that started now could
    // still be in flight when it lapses, which is what the margin is for.
    storage.map.set(tokenKey, JSON.stringify({ token: 'nearly', expiresAt: Date.now() + 30_000 }));
    expect(await googleTokenProvider(CLIENT, SCOPE)()).toBe('fresh');
    expect(gis.requests).toHaveLength(1);
  });

  it('keeps that margin for the tokens it minted itself', async () => {
    // The check in storage only runs when the provider is built. This is the
    // other one — a token minted in this session, held in the closure, and
    // already too close to its end to hand out a second time.
    const { gis } = googleIsThere({ access_token: 'short-lived', expires_in: 30 });
    const provider = googleTokenProvider(CLIENT, SCOPE);

    expect(await provider()).toBe('short-lived');
    expect(await provider()).toBe('short-lived');

    expect(gis.requests).toHaveLength(2);
  });

  it('stores what a refresh returned, and forgets it on request', async () => {
    googleIsThere({ access_token: 'tok-1', expires_in: 3600 });
    const asked = Date.now();

    expect(await googleTokenProvider(CLIENT, SCOPE)()).toBe('tok-1');

    expect(hasCachedGoogleToken(CLIENT, SCOPE)).toBe(true);
    // Pinned to the token's own life, which is what a data cache keyed on it
    // needs — read raw, so it answers even for a token already past its end.
    expect(googleTokenExpiry(CLIENT, SCOPE)).toBeGreaterThanOrEqual(asked + 3_600_000);

    clearGoogleToken(CLIENT, SCOPE);
    expect(hasCachedGoogleToken(CLIENT, SCOPE)).toBe(false);
    expect(googleTokenExpiry(CLIENT, SCOPE)).toBeNull();
  });

  it('reads a damaged entry as no entry rather than throwing', async () => {
    const { storage } = googleIsThere({ access_token: 'fresh', expires_in: 3600 });

    // Three ways web storage lies: not JSON, JSON of the wrong shape, and an
    // entry with no token in it. A bad byte in localStorage must cost a popup,
    // not an explorer that cannot boot.
    for (const damaged of ['not json at all', JSON.stringify({ expiresAt: 'soon' }), '{}']) {
      storage.map.set(tokenKey, damaged);
      expect(hasCachedGoogleToken(CLIENT, SCOPE)).toBe(false);
    }
    storage.map.set(tokenKey, JSON.stringify({ expiresAt: 'soon' }));
    expect(googleTokenExpiry(CLIENT, SCOPE)).toBeNull();

    storage.map.set(tokenKey, 'not json at all');
    expect(await googleTokenProvider(CLIENT, SCOPE)()).toBe('fresh');
  });

  it('works where there is no storage to write to', async () => {
    const gis = fakeGis({ access_token: 'tok-1', expires_in: 3600 });
    stub('window', { google: gis.google });
    stub('localStorage', fakeStorage({ failWrites: true }));

    // Private mode: the token is minted and used, the session just does not
    // survive a reload.
    expect(await googleTokenProvider(CLIENT, SCOPE)()).toBe('tok-1');
    expect(hasCachedGoogleToken(CLIENT, SCOPE)).toBe(false);

    // And a browser with no web storage at all, which is the same three
    // `catch`es reached from the other side.
    unstub('localStorage');
    expect(hasCachedGoogleToken(CLIENT, SCOPE)).toBe(false);
    expect(googleTokenExpiry(CLIENT, SCOPE)).toBeNull();
    expect(() => clearGoogleToken(CLIENT, SCOPE)).not.toThrow();
  });

  it('rejects with what Google said', async () => {
    const { gis } = googleIsThere({ error: 'popup_closed_by_user' });
    await expect(googleTokenProvider(CLIENT, SCOPE)()).rejects.toThrow('popup_closed_by_user');
    expect(gis.requests).toHaveLength(1);

    // A response carrying neither a token nor a reason still has to reject:
    // resolving with an empty string would send the adapter to Drive unauthorised.
    googleIsThere({});
    await expect(googleTokenProvider(CLIENT, SCOPE)()).rejects.toThrow(
      'Google denied the token request',
    );
  });
});
