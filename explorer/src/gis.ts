// Google Identity Services, just enough of it to hand GDriveAdapter a token.
// This is the whole "no backend" story: a public OAuth client id, a script from
// Google, and an access token minted in the browser — nothing server-side.

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

/**
 * Returns a token provider suitable for {@link GDriveAdapter}: a function that
 * yields a live access token, caching it until shortly before it expires and
 * refreshing silently after that. The first call shows Google's consent screen,
 * so kick it off from a user gesture.
 */
export async function googleTokenProvider(
  clientId: string,
  scope: string,
): Promise<() => Promise<string>> {
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google Identity Services is unavailable');
  const client = oauth2.initTokenClient({ client_id: clientId, scope, callback: () => {} });

  let token = '';
  let expiresAt = 0;

  return () => {
    // A minute of slack so a request never leaves with a token about to lapse.
    if (token && Date.now() < expiresAt - 60_000) return Promise.resolve(token);
    return new Promise<string>((resolve, reject) => {
      client.callback = (response) => {
        if (response.access_token) {
          token = response.access_token;
          expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
          resolve(token);
        } else {
          reject(new Error(response.error || 'Google denied the token request'));
        }
      };
      // Empty prompt means "ask only the first time": Google shows consent on
      // the initial grant and then returns tokens silently on later loads, as
      // long as the authorisation still stands. Forcing 'consent' here is what
      // made every reload ask to log in again.
      client.requestAccessToken({ prompt: '' });
    });
  };
}
