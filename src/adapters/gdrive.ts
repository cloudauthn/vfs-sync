import { basename, dirname, normalizePath } from '../path.js';
import { chunked } from '../stream.js';
import type {
  ByteRange,
  VFSAdapter,
  VFSChange,
  VFSChangeFeed,
  VFSListEntry,
  VFSStat,
} from '../types.js';

/**
 * An OAuth access token, or a function that returns one. The function form is
 * called before every request, so a provider that refreshes an expiring token
 * can hand back the current one each time — which is exactly the shape Google
 * Identity Services' token client gives you in a browser (see the class docs).
 */
export type GDriveTokenProvider = string | (() => string | Promise<string>);

export type GDriveSpace = 'drive' | 'appDataFolder';

export interface GDriveAdapterOptions {
  /** How to authorise each request. Required. */
  token: GDriveTokenProvider;
  /**
   * Which Drive space to work in.
   *
   * - `'drive'` (default): the user's My Drive. Everything the adapter creates
   *   is a normal file the user sees and can edit at drive.google.com. Pair with
   *   the `drive.file` scope.
   * - `'appDataFolder'`: a per-app folder that is **hidden** from the user's
   *   Drive UI — good for sync state you do not want them to touch. It is wiped
   *   when the user disconnects the app. Pair with the `drive.appdata` scope.
   *
   * The space also picks the default {@link rootFolderId} (`'root'` or the
   * special `'appDataFolder'` alias), so setting this is usually all you need.
   */
  space?: GDriveSpace;
  /**
   * Drive id of the folder to treat as the adapter root. Defaults to `'root'`
   * for the `drive` space and to `'appDataFolder'` for the app-data space. Point
   * it at a dedicated folder to keep a sync tree out of the way of everything
   * else the user keeps in Drive.
   */
  rootFolderId?: string;
  /** Label used in logs and conflict-copy names. Defaults to `'gdrive'`. */
  name?: string;
  /**
   * Override the `fetch` used for every call. Defaults to the global one.
   * Injected so the adapter can be driven against a fake Drive in tests, and so
   * a host can add retry/backoff around the network.
   */
  fetch?: typeof fetch;
  /** Override the API origin. Only useful for tests and proxies. */
  apiOrigin?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_ORIGIN = 'https://www.googleapis.com';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

/**
 * Google Drive backend, driven entirely from the browser — no server of your
 * own. Drive's REST API is CORS-enabled, so with an access token from Google
 * Identity Services the whole sync loop runs client-side:
 *
 * ```ts
 * // load https://accounts.google.com/gsi/client once, then:
 * const client = google.accounts.oauth2.initTokenClient({
 *   client_id: '<your-oauth-client-id>',
 *   scope: 'https://www.googleapis.com/auth/drive.file',
 *   callback: () => {},
 * });
 * const token = () =>
 *   new Promise<string>((resolve) => {
 *     client.callback = (r) => resolve(r.access_token);
 *     client.requestAccessToken();
 *   });
 *
 * const drive = new GDriveAdapter({ token });
 * const node = await VFSNode.open(drive);
 * ```
 *
 * ### Why Drive needs no rename heuristic
 *
 * Unlike a filesystem, a Drive file is not identified by its path: it has a
 * stable `fileId` and a set of parent folders. This adapter implements
 * {@link fileId}, so the engine tracks identity across renames and moves with
 * certainty and never falls back to the hash heuristic. The flip side is that a
 * path is not a primary key — resolving `a/b/c.txt` means walking the folder
 * tree by name — so the adapter keeps a path→id cache and invalidates it on
 * every write, delete and rename.
 *
 * ### Scope
 *
 * `drive.file` (per-file access to what your app creates) is the least
 * privilege that works and is what the snippet above requests. Full `drive`
 * scope also works if you need to sync a folder the user made elsewhere. Either
 * way, point {@link GDriveAdapterOptions.rootFolderId} at one folder rather
 * than syncing the whole of My Drive.
 */
export class GDriveAdapter implements VFSAdapter {
  readonly name: string;

  private readonly token: GDriveTokenProvider;
  private readonly space: GDriveSpace;
  private readonly rootId: string;
  private readonly origin: string;
  private readonly doFetch: typeof fetch;
  /** Path (relative to the root) → Drive fileId. `''` is the root itself. */
  private readonly ids = new Map<string, string>();
  /**
   * Paths a lookup just confirmed do not exist. It lets a `write` that follows a
   * `stat` (the store's `hasObject` → `putObjectAt` pattern) skip re-asking
   * whether the file is there — on Drive that saved query is a whole request per
   * object. Only ever holds paths a resolve/stat found absent this moment, and
   * every create/discovery clears the entry, so it never suppresses a real file.
   */
  private readonly absent = new Set<string>();

  constructor(options: GDriveAdapterOptions) {
    this.token = options.token;
    this.space = options.space ?? 'drive';
    this.rootId =
      options.rootFolderId ?? (this.space === 'appDataFolder' ? 'appDataFolder' : 'root');
    this.name = options.name ?? 'gdrive';
    this.origin = options.apiOrigin ?? DEFAULT_ORIGIN;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // --------------------------------------------------------------- requests

  private async authorized(path: string, init: RequestInit = {}): Promise<Response> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return this.doFetch(`${this.origin}${path}`, { ...init, headers });
  }

  /** Authorised request that expects JSON back; throws on any non-2xx. */
  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.authorized(path, init);
    if (!res.ok) throw await driveError(res, path);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------ id resolver

  /** Resolves a path to a fileId, or `null` if no such entry exists. */
  private async resolve(path: string): Promise<string | null> {
    return (await this.locate(path))?.id ?? null;
  }

  /**
   * Resolves a path, and hands back the metadata when the lookup had to fetch it
   * — the name query returns size and modifiedTime along with the id, so a
   * `stat` of a path nobody has resolved yet needs no second request. `file` is
   * absent when the id came from the cache, where the metadata may have moved on.
   */
  private async locate(path: string): Promise<{ id: string; file?: DriveFile } | null> {
    const p = normalizePath(path);
    if (p === '') return { id: this.rootId };
    const cached = this.ids.get(p);
    if (cached) return { id: cached };
    const parent = await this.resolve(dirname(p));
    if (!parent) return null;
    const child = await this.childByName(parent, basename(p));
    if (!child) {
      this.absent.add(p); // a following write can skip re-checking existence
      return null;
    }
    this.ids.set(p, child.id);
    this.absent.delete(p);
    return { id: child.id, file: child };
  }

  /**
   * Resolves a folder path, creating it and any missing ancestors. Returns the
   * folder's id. Existing entries are reused; only genuinely missing segments
   * are created, so concurrent `write`s under the same new folder converge.
   */
  private async ensureFolder(path: string): Promise<string> {
    const p = normalizePath(path);
    if (p === '') return this.rootId;
    const cached = this.ids.get(p);
    if (cached) return cached;
    const parent = await this.ensureFolder(dirname(p));
    // A resolve/stat that just missed this folder means it is not there, so skip
    // the existence query and create straight away.
    const existing = this.absent.has(p) ? null : await this.childByName(parent, basename(p));
    if (existing) {
      this.ids.set(p, existing.id);
      this.absent.delete(p);
      return existing.id;
    }
    const created = await this.json<DriveFile>('/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(p), mimeType: FOLDER_MIME, parents: [parent] }),
    });
    this.ids.set(p, created.id);
    this.absent.delete(p);
    return created.id;
  }

  private async childByName(parentId: string, name: string): Promise<DriveFile | null> {
    const q = `'${parentId}' in parents and name='${escapeQuery(name)}' and trashed=false`;
    const url =
      `/drive/v3/files?spaces=${this.space}&pageSize=1` +
      `&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size)`;
    const { files } = await this.json<{ files: DriveFile[] }>(url);
    return files[0] ?? null;
  }

  /** Drop cached ids for a path and everything beneath it. */
  private forget(path: string): void {
    const p = normalizePath(path);
    for (const key of [...this.ids.keys()]) {
      if (key === p || key.startsWith(`${p}/`)) this.ids.delete(key);
    }
  }

  /** Re-key cached ids from an old path prefix to a new one, ids unchanged. */
  private reparent(from: string, to: string): void {
    for (const [key, id] of [...this.ids]) {
      if (key === from) {
        this.ids.delete(key);
        this.ids.set(to, id);
      } else if (key.startsWith(`${from}/`)) {
        this.ids.delete(key);
        const moved = `${to}${key.slice(from.length)}`;
        this.ids.set(moved, id);
        this.absent.delete(moved);
      }
    }
  }

  // ------------------------------------------------------------- operations

  async list(path: string): Promise<VFSListEntry[]> {
    const base = normalizePath(path);
    const folderId = await this.resolve(base);
    if (!folderId) return [];
    const out: VFSListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${folderId}' in parents and trashed=false`;
      const url =
        `/drive/v3/files?spaces=${this.space}&pageSize=1000` +
        `&q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(url);
      for (const file of page.files) {
        const childPath = base ? `${base}/${file.name}` : file.name;
        this.ids.set(childPath, file.id); // warm the cache while we are here
        this.absent.delete(childPath);
        // The query already asked for size and modifiedTime, so every entry
        // carries its stat: a walk of this folder needs no further requests.
        out.push({
          name: file.name,
          path: childPath,
          kind: file.mimeType === FOLDER_MIME ? 'directory' : 'file',
          stat: statOf(file),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const id = await this.resolve(path);
    if (!id) throw new Error(`ENOENT: ${path}`);
    const res = await this.authorized(`/drive/v3/files/${id}?alt=media`);
    if (res.status === 404) {
      this.forget(path);
      throw new Error(`ENOENT: ${path}`);
    }
    if (!res.ok) throw await driveError(res, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  async readRange(path: string, range: ByteRange = {}): Promise<Uint8Array> {
    const start = range.start ?? 0;
    // A degenerate or empty range never hits the network — the contract wants
    // `[]` for it, and Drive would answer 416 rather than an empty body.
    if (range.end !== undefined && range.end <= start) return new Uint8Array();
    const id = await this.resolve(path);
    if (!id) throw new Error(`ENOENT: ${path}`);
    const headers = new Headers();
    // HTTP ranges are inclusive; ours is half-open.
    headers.set('Range', `bytes=${start}-${range.end !== undefined ? range.end - 1 : ''}`);
    const res = await this.authorized(`/drive/v3/files/${id}?alt=media`, { headers });
    if (res.status === 404) {
      this.forget(path);
      throw new Error(`ENOENT: ${path}`);
    }
    // 416 means `start` is at or past the end of the file: clamp to empty.
    if (res.status === 416) return new Uint8Array();
    if (!res.ok) throw await driveError(res, path);
    const body = new Uint8Array(await res.arrayBuffer());
    // If the server ignored the Range and sent the whole file (200), slice it
    // ourselves so the result still honours `[start, end)`.
    return res.status === 200 ? body.slice(start, range.end) : body;
  }

  async readStream(path: string, range: ByteRange = {}): Promise<ReadableStream<Uint8Array>> {
    const start = range.start ?? 0;
    if (range.end !== undefined && range.end <= start) return chunked(new Uint8Array());
    const id = await this.resolve(path);
    if (!id) throw new Error(`ENOENT: ${path}`);
    const headers = new Headers();
    const ranged = range.start !== undefined || range.end !== undefined;
    if (ranged) headers.set('Range', `bytes=${start}-${range.end !== undefined ? range.end - 1 : ''}`);
    const res = await this.authorized(`/drive/v3/files/${id}?alt=media`, { headers });
    if (res.status === 416) return chunked(new Uint8Array());
    if (res.status === 404) {
      this.forget(path);
      throw new Error(`ENOENT: ${path}`);
    }
    if (!res.ok) throw await driveError(res, path);
    // A whole-file 200 to a ranged request still has to be clamped.
    if (ranged && res.status === 200) {
      return chunked((new Uint8Array(await res.arrayBuffer())).slice(start, range.end));
    }
    return res.body ?? chunked(new Uint8Array());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const target = normalizePath(path);
    const parentId = await this.ensureFolder(dirname(target));
    // Prefer a cached id; else only query for an existing file when a recent
    // lookup has not already told us there is none.
    let id = this.ids.get(target);
    if (!id && !this.absent.has(target)) {
      id = (await this.childByName(parentId, basename(target)))?.id;
    }
    if (!id) {
      // Create the metadata first to mint an id, then stream the bytes into it.
      const created = await this.json<DriveFile>('/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: basename(target), parents: [parentId] }),
      });
      id = created.id;
      this.ids.set(target, id);
    }
    this.absent.delete(target);
    const res = await this.authorized(`/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      body: data as unknown as BodyInit,
    });
    if (!res.ok) throw await driveError(res, path);
  }

  async delete(path: string): Promise<void> {
    const id = await this.resolve(path);
    if (!id) {
      this.forget(path); // already gone — idempotent
      return;
    }
    const res = await this.authorized(`/drive/v3/files/${id}`, { method: 'DELETE' });
    // Deleting a folder removes its children too, so this is recursive.
    if (!res.ok && res.status !== 404) throw await driveError(res, path);
    this.forget(path);
    this.absent.add(normalizePath(path)); // now gone — a rewrite can skip the check
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (from === to) return;
    const id = await this.resolve(from);
    if (!id) throw new Error(`ENOENT: ${oldPath}`);
    const oldParent = await this.resolve(dirname(from));
    const newParent = await this.ensureFolder(dirname(to));

    const params = new URLSearchParams({ fields: 'id' });
    if (newParent !== oldParent) {
      params.set('addParents', newParent);
      if (oldParent) params.set('removeParents', oldParent);
    }
    const res = await this.authorized(`/drive/v3/files/${id}?${params}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(to) }),
    });
    if (!res.ok) throw await driveError(res, oldPath);
    // The id is stable across the move; only the paths it is filed under change.
    this.forget(to);
    this.reparent(from, to);
    this.absent.add(from); // the old path is now empty
    this.absent.delete(to); // and the new one holds the file
  }

  async stat(path: string): Promise<VFSStat | null> {
    const target = normalizePath(path);
    if (target === '') return { kind: 'directory', size: 0, mtime: 0 };
    const found = await this.locate(target);
    if (!found) return null;
    // The query that just resolved this path returned its metadata too; only a
    // path whose id was already cached has to be fetched.
    if (found.file) return statOf(found.file);
    const id = found.id;
    const res = await this.authorized(`/drive/v3/files/${id}?fields=id,mimeType,size,modifiedTime`);
    if (res.status === 404) {
      this.forget(target);
      this.absent.add(target);
      return null;
    }
    if (!res.ok) throw await driveError(res, path);
    return statOf((await res.json()) as DriveFile);
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureFolder(path);
  }

  /** The stable native id, which is what makes renames heuristic-free. */
  async fileId(path: string): Promise<string | null> {
    return this.resolve(path);
  }

  // ----------------------------------------------------------- conditional

  /** Current `etag` of a file, the token {@link writeIf} checks against. */
  async tag(path: string): Promise<string | null> {
    const id = await this.resolve(path);
    if (!id) return null;
    const res = await this.authorized(`/drive/v3/files/${id}?fields=id`);
    if (!res.ok) return null;
    return res.headers.get('etag');
  }

  /**
   * Write that only lands if the file still carries `tag`.
   *
   * Drive has no append, so extending the commit log is a full re-upload — and a
   * full re-upload is exactly where two peers appending at once lose rows. With
   * `If-Match` the check-then-act of §3 stops being a race the engine merely
   * narrows and becomes one it actually wins or loses: `null` back means the
   * caller has to re-read and retry.
   */
  async writeIf(path: string, data: Uint8Array, tag: string | null): Promise<string | null> {
    const target = normalizePath(path);
    const id = await this.resolve(target);
    if (!id) {
      // Nothing there to conflict with; a plain create is the whole operation.
      if (tag !== null) return null;
      await this.write(target, data);
      return this.tag(target);
    }
    const headers = new Headers();
    if (tag !== null) headers.set('If-Match', tag);
    const res = await this.authorized(`/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers,
      body: data as unknown as BodyInit,
    });
    if (res.status === 412) return null; // somebody else got there first
    if (!res.ok) throw await driveError(res, path);
    return res.headers.get('etag') ?? (await this.tag(target));
  }

  // -------------------------------------------------------------- changes

  /**
   * The changes feed (§7) — in **one** request it says whether anything moved,
   * instead of a listing per folder.
   *
   * Two honest caveats. The feed is account-wide and cannot be filtered by
   * folder, so the caller filters client-side by `fileId` against the `native`
   * of its entries — which is what that field is for — and a change inside a
   * subfolder that has never been resolved cannot be attributed and is ignored
   * until the next walk. And the token expires: Drive answers `410 Gone` when it
   * has fallen too far behind, which comes back as `reset` and means the caller
   * takes the full-walk path that has always existed.
   */
  async changes(token: string | null): Promise<VFSChangeFeed> {
    if (token === null) {
      const { startPageToken } = await this.json<{ startPageToken: string }>(
        `/drive/v3/changes/startPageToken?spaces=${this.space}`,
      );
      return { changes: [], token: startPageToken };
    }

    const changes: VFSChange[] = [];
    let pageToken: string | undefined = token;
    let next = token;
    while (pageToken) {
      const url =
        `/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=1000` +
        `&spaces=${this.space}&restrictToMyDrive=true` +
        '&fields=newStartPageToken,nextPageToken,' +
        encodeURIComponent(
          'changes(fileId,removed,file(id,name,parents,mimeType,size,modifiedTime,trashed))',
        );
      const res = await this.authorized(url);
      // The token fell out of Drive's retention window: there is no delta to be
      // had, only a fresh start and a full walk.
      if (res.status === 410) {
        const { startPageToken } = await this.json<{ startPageToken: string }>(
          `/drive/v3/changes/startPageToken?spaces=${this.space}`,
        );
        return { changes: [], token: startPageToken, reset: true };
      }
      if (!res.ok) throw await driveError(res, 'changes');
      const page = (await res.json()) as {
        changes?: Array<{ fileId: string; removed?: boolean; file?: DriveFile & { trashed?: boolean } }>;
        nextPageToken?: string;
        newStartPageToken?: string;
      };
      for (const change of page.changes ?? []) {
        const gone = change.removed === true || change.file?.trashed === true || !change.file;
        const path = this.pathOf(change.fileId);
        changes.push({
          native: change.fileId,
          ...(path !== null ? { path } : {}),
          ...(gone ? { removed: true as const } : { stat: statOf(change.file as DriveFile) }),
        });
      }
      pageToken = page.nextPageToken;
      // Only the token that closes the cycle is worth persisting: on Drive every
      // write of `vfs.json` is a full re-upload, so paging is not the moment.
      if (page.newStartPageToken) next = page.newStartPageToken;
    }
    return { changes, token: next };
  }

  /** Reverse of the id cache: the path we know this id under, if any. */
  private pathOf(id: string): string | null {
    for (const [path, held] of this.ids) if (held === id) return path;
    return null;
  }
}

/**
 * A Drive file's metadata as a stat. One place for the conversion, so a listed
 * entry and a stat'd one can never disagree about the same file.
 */
function statOf(file: DriveFile): VFSStat {
  return {
    kind: file.mimeType === FOLDER_MIME ? 'directory' : 'file',
    size: file.size ? Number(file.size) : 0,
    mtime: file.modifiedTime ? Date.parse(file.modifiedTime) : 0,
  };
}

/** Escape a name for use inside a Drive query string literal. */
function escapeQuery(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Build an informative error from a failed Drive response. */
async function driveError(res: Response, path: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ? `: ${body.error.message}` : '';
  } catch {
    // no JSON body
  }
  return new Error(`Drive ${res.status} on ${path}${detail}`);
}
