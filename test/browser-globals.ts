/**
 * The browser this suite does not have.
 *
 * Everything here stands in for a global that only exists in a page: the folder
 * picker, web storage, Google's identity script. They live in one file rather
 * than in whichever test needed them first — `stub` was private to
 * `browser-adapters.test.ts` and two suites now want it, and a second copy of a
 * global-installing helper is how one of them ends up not cleaning up after
 * itself.
 *
 * What this is *not*: a browser. These fakes exercise our own code against the
 * shape of the API, and cannot catch a browser's quirks — the same caveat
 * `fake-handle.ts` carries.
 */

type GlobalName = 'navigator' | 'window' | 'localStorage' | 'document' | 'fetch';

export function stub(name: GlobalName, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

export function unstub(...names: GlobalName[]): void {
  for (const name of names) Reflect.deleteProperty(globalThis, name);
}

// ------------------------------------------------------------- web storage

export interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** The contents, so a test can plant something malformed or read what landed. */
  readonly map: Map<string, string>;
}

/**
 * `localStorage`, as a Map.
 *
 * `failWrites` is private mode: the storage is there and throws on write, which
 * is a real browser state and the one `gis.ts` catches so that a session simply
 * does not survive a reload.
 */
export function fakeStorage(options: { failWrites?: boolean } = {}): FakeStorage {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failWrites) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// --------------------------------------------------- Google Identity Services

export interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

export interface FakeGis {
  /** Goes on `window.google`. */
  google: {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (response: TokenResponse) => void;
        }) => { callback: (response: TokenResponse) => void; requestAccessToken: (overrides?: { prompt?: string }) => void };
      };
    };
  };
  /** One entry per client created, with what it was configured with. */
  clients: Array<{ client_id: string; scope: string }>;
  /** One entry per token request, with the overrides it was given. */
  requests: Array<{ prompt?: string } | undefined>;
}

/**
 * Google's token client, scripted.
 *
 * Each `requestAccessToken` consumes the next response and the last one repeats,
 * so "grant, then refuse" is two arguments. The callback is invoked
 * synchronously: the real one waits on a popup, but `gis.ts` installs its
 * callback *before* asking, so nothing here depends on the delay — and a test
 * that hangs on a popup that never opens is worse than one that is a step ahead
 * of reality.
 */
export function fakeGis(...responses: TokenResponse[]): FakeGis {
  const record: FakeGis = {
    clients: [],
    requests: [],
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config) => {
            record.clients.push({ client_id: config.client_id, scope: config.scope });
            const client = {
              callback: config.callback,
              requestAccessToken: (overrides?: { prompt?: string }) => {
                record.requests.push(overrides);
                const index = Math.min(record.requests.length - 1, responses.length - 1);
                client.callback(responses[index] ?? { error: 'nothing scripted' });
              },
            };
            return client;
          },
        },
      },
    },
  };
  return record;
}
