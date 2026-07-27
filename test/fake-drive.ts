/**
 * A tiny in-memory Google Drive, faithful to exactly the slice of the REST API
 * that {@link GDriveAdapter} uses: the file-graph model (id + name + parents),
 * name-scoped queries, media up/download with ranges, and metadata patches for
 * rename/move. It exists so the adapter can be driven through the shared
 * adapter contract without a network or OAuth.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const encoder = new TextEncoder();

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Uint8Array;
  modifiedTime: string;
  /** Bumped on every mutation, which is all an ETag has to be. */
  version: number;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function unescapeName(raw: string): string {
  return raw.replace(/\\(['\\])/g, '$1');
}

export interface FakeDrive {
  fetch: typeof fetch;
  nodes: Map<string, Node>;
  /** Forces the next `changes` call to answer 410, as an expired token does. */
  expireToken(): void;
}

export function makeFakeDrive(): FakeDrive {
  const nodes = new Map<string, Node>();
  let counter = 0;
  let clock = Date.now();
  const nextId = () => `f${++counter}`;
  const nextTime = () => new Date((clock += 1)).toISOString();

  /** The change journal: one entry per mutation, in order, like Drive's. */
  const journal: Array<{ seq: number; fileId: string; removed?: boolean }> = [];
  let seq = 1;
  let expired = false;
  const record = (fileId: string, removed?: boolean) => {
    journal.push({ seq: seq++, fileId, ...(removed ? { removed: true } : {}) });
  };

  const etagOf = (node: Node) => `"${node.id}-${node.version}"`;

  const project = (node: Node) => ({
    id: node.id,
    name: node.name,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    ...(node.mimeType === FOLDER_MIME ? {} : { size: String(node.content.byteLength) }),
  });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const error = (status: number, message: string) => json({ error: { message } }, status);

  const removeSubtree = (id: string) => {
    nodes.delete(id);
    record(id, true);
    for (const node of [...nodes.values()]) {
      if (node.parents.includes(id)) removeSubtree(node.id);
    }
  };

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const upload = url.pathname.startsWith('/upload/drive/v3/files');
    const rest = url.pathname.replace(/^\/upload/, '');
    const idMatch = rest.match(/^\/drive\/v3\/files\/([^/]+)$/);

    // ---- media download: GET /drive/v3/files/{id}?alt=media
    if (!upload && idMatch && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const node = nodes.get(idMatch[1]!);
      if (!node) return error(404, 'File not found');
      const range = new Headers(init.headers).get('Range');
      if (!range) return new Response(node.content as BodyInit);
      const [, s, e] = range.match(/bytes=(\d*)-(\d*)/) ?? [];
      const start = s ? Number(s) : 0;
      if (start >= node.content.byteLength && node.content.byteLength > 0) {
        return new Response(null, { status: 416 });
      }
      const end = e ? Number(e) + 1 : node.content.byteLength;
      return new Response(node.content.slice(start, end) as BodyInit, { status: 206 });
    }

    // ---- media upload: PATCH /upload/drive/v3/files/{id}?uploadType=media
    if (upload && idMatch && method === 'PATCH') {
      const node = nodes.get(idMatch[1]!);
      if (!node) return error(404, 'File not found');
      // Conditional write: If-Match is what makes an append a race somebody
      // actually wins, rather than one that is merely narrowed.
      const ifMatch = new Headers(init.headers).get('If-Match');
      if (ifMatch !== null && ifMatch !== etagOf(node)) {
        return json({ error: { message: 'Precondition Failed' } }, 412);
      }
      node.content = await bodyBytes(init.body);
      node.modifiedTime = nextTime();
      node.version++;
      record(node.id);
      return new Response(JSON.stringify(project(node)), {
        status: 200,
        headers: { 'Content-Type': 'application/json', etag: etagOf(node) },
      });
    }

    // ---- metadata read: GET /drive/v3/files/{id}?fields=...
    if (!upload && idMatch && method === 'GET') {
      const node = nodes.get(idMatch[1]!);
      if (!node) return error(404, 'File not found');
      return new Response(JSON.stringify(project(node)), {
        status: 200,
        headers: { 'Content-Type': 'application/json', etag: etagOf(node) },
      });
    }

    // ---- rename / move: PATCH /drive/v3/files/{id}
    if (!upload && idMatch && method === 'PATCH') {
      const node = nodes.get(idMatch[1]!);
      if (!node) return error(404, 'File not found');
      const patch = JSON.parse(new TextDecoder().decode(await bodyBytes(init.body))) as {
        name?: string;
      };
      if (patch.name != null) node.name = patch.name;
      const add = url.searchParams.get('addParents');
      const remove = url.searchParams.get('removeParents');
      if (remove) node.parents = node.parents.filter((p) => p !== remove);
      if (add && !node.parents.includes(add)) node.parents.push(add);
      node.version++;
      record(node.id);
      return json(project(node));
    }

    // ---- delete: DELETE /drive/v3/files/{id}
    if (!upload && idMatch && method === 'DELETE') {
      if (!nodes.has(idMatch[1]!)) return error(404, 'File not found');
      removeSubtree(idMatch[1]!);
      return new Response(null, { status: 204 });
    }

    // ---- create: POST /drive/v3/files
    if (!upload && rest === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(await bodyBytes(init.body))) as {
        name: string;
        mimeType?: string;
        parents?: string[];
      };
      const node: Node = {
        id: nextId(),
        name: meta.name,
        mimeType: meta.mimeType ?? 'application/octet-stream',
        parents: meta.parents ?? ['root'],
        content: new Uint8Array(),
        modifiedTime: nextTime(),
        version: 1,
      };
      nodes.set(node.id, node);
      record(node.id);
      return json({ id: node.id });
    }

    // ---- list / query: GET /drive/v3/files?q=...
    if (!upload && rest === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const nameFilter = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1];
      const wanted = nameFilter != null ? unescapeName(nameFilter) : null;
      const files = [...nodes.values()]
        .filter((n) => parent != null && n.parents.includes(parent))
        .filter((n) => wanted == null || n.name === wanted)
        .map(project);
      return json({ files });
    }

    // ---- GET /drive/v3/changes/startPageToken
    if (rest === '/drive/v3/changes/startPageToken' && method === 'GET') {
      expired = false;
      return json({ startPageToken: String(seq) });
    }

    // ---- GET /drive/v3/changes?pageToken=...
    if (rest === '/drive/v3/changes' && method === 'GET') {
      if (expired) return error(410, 'Change token expired');
      const from = Number(url.searchParams.get('pageToken') ?? '1');
      // Drive collapses repeated changes to one entry per file, newest state.
      const latest = new Map<string, { fileId: string; removed?: boolean }>();
      for (const item of journal) {
        if (item.seq < from) continue;
        latest.set(item.fileId, { fileId: item.fileId, ...(item.removed ? { removed: true } : {}) });
      }
      const changes = [...latest.values()].map((item) => {
        const node = nodes.get(item.fileId);
        return {
          fileId: item.fileId,
          ...(item.removed || !node ? { removed: true } : { file: { ...project(node), trashed: false } }),
        };
      });
      return json({ changes, newStartPageToken: String(seq) });
    }

    return error(400, `unhandled ${method} ${url.pathname}`);
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    nodes,
    expireToken: () => {
      expired = true;
    },
  };
}
