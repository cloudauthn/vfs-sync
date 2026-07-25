// Google Identity Services, just enough of it to hand GDriveAdapter a token.
// This is the whole "no backend" story: a public OAuth client id, a script from
// Google, and an access token minted in the browser — nothing server-side.
//
// The token is cached in localStorage so a page reload keeps browsing Drive
// without a fresh popup, up to the token's ~1h lifetime. That is a deliberate
// trade-off: an access token in web storage is a mild XSS exposure (short-lived,
// drive.file scope). GIS has no silent refresh in its token model — a new token
// always needs a user gesture — so once the cached one expires, the next
// interactive call has to come from a click.

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  callback: (response: TokenResponse) => void;
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: { initTokenClient: (config: TokenClientConfig) => TokenClient };
      };
    };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let loading: Promise<void> | null = null;

/** Inject the GIS client script once; resolve when `window.google` is ready. */
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('could not load Google Identity Services'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

// ------------------------------------------------------------ token storage

interface StoredToken {
  token: string;
  /** Epoch ms; treated as expired a minute early so calls never race the edge. */
  expiresAt: number;
}

function storageKey(clientId: string, scope: string): string {
  return `vfs-explorer:gtoken:${clientId}:${scope}`;
}

function loadStored(clientId: string, scope: string): StoredToken | null {
  try {
    const raw = localStorage.getItem(storageKey(clientId, scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    if (!parsed.token || Date.now() >= parsed.expiresAt - 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStored(clientId: string, scope: string, value: StoredToken): void {
  try {
    localStorage.setItem(storageKey(clientId, scope), JSON.stringify(value));
  } catch {
    // storage unavailable (private mode); the session just won't survive reload
  }
}

/** True when a still-valid token is cached — lets boot re-attach without a popup. */
export function hasCachedGoogleToken(clientId: string, scope: string): boolean {
  return loadStored(clientId, scope) !== null;
}

/** Forget the cached token, e.g. when the user disconnects Drive. */
export function clearGoogleToken(clientId: string, scope: string): void {
  try {
    localStorage.removeItem(storageKey(clientId, scope));
  } catch {
    // nothing to clear
  }
}

// ---------------------------------------------------------------- provider

/**
 * A token provider for {@link GDriveAdapter}: yields a live access token,
 * serving the cached one until it nears expiry and only then opening Google's
 * popup for a fresh one. Creating the provider does no I/O and never prompts —
 * the GIS script and the popup are deferred to the first interactive refresh,
 * so boot can re-attach a cached session silently.
 */
export function googleTokenProvider(clientId: string, scope: string): () => Promise<string> {
  const stored = loadStored(clientId, scope);
  let token = stored?.token ?? '';
  let expiresAt = stored?.expiresAt ?? 0;
  let client: TokenClient | null = null;

  async function refresh(): Promise<string> {
    await loadGis();
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) throw new Error('Google Identity Services is unavailable');
    client ??= oauth2.initTokenClient({ client_id: clientId, scope, callback: () => {} });
    return new Promise<string>((resolve, reject) => {
      client!.callback = (response) => {
        if (response.access_token) {
          token = response.access_token;
          expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          saveStored(clientId, scope, { token, expiresAt });
          resolve(token);
        } else {
          reject(new Error(response.error || 'Google denied the token request'));
        }
      };
      // Empty prompt asks only the first time: consent on the initial grant,
      // then silent thereafter while the authorisation stands.
      client!.requestAccessToken({ prompt: '' });
    });
  }

  return () => {
    if (token && Date.now() < expiresAt - 60_000) return Promise.resolve(token);
    return refresh();
  };
}
