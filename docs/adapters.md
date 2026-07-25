# Adapters

An adapter is the only thing that knows about a storage backend. The engine talks to it through
seven methods and never touches a backend API directly, which is why any backend can sync with
any other.

| Adapter | Import from | Runs in |
| --- | --- | --- |
| [`OPFSAdapter`](#opfsadapter) | `@cloudauthn/vfs-sync` | Browsers |
| [`FSAAdapter`](#fsaadapter) | `@cloudauthn/vfs-sync` | Browsers (Chromium-based) |
| [`NodeFsAdapter`](#nodefsadapter) | `@cloudauthn/vfs-sync/node` | Node 18+ |
| [`MemoryAdapter`](#memoryadapter) | `@cloudauthn/vfs-sync` | Anywhere |

---

## OPFSAdapter

The Origin Private File System: per-origin storage that never prompts, works offline, and whose
handles do not lose permission. If you want a background sync loop, this is the peer to keep it
on.

```ts
import { OPFSAdapter, VFSNode, isOPFSAvailable } from '@cloudauthn/vfs-sync';

if (!isOPFSAvailable()) throw new Error('needs a secure context');

// the whole origin-private root
const root = await OPFSAdapter.open();

// or scope a peer to a subfolder, so several can coexist
const notes = await OPFSAdapter.open({ path: 'apps/notes', name: 'notes' });
const node = await VFSNode.open(notes);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `path` | `''` (the root) | Subfolder to use as the adapter root. Created if missing. |
| `name` | the path, or `'opfs'` | Label used in logs and conflict-copy names. |

OPFS requires a secure context (`https` or `localhost`). In a private window or a sandboxed
iframe `getDirectory()` can reject even when the API exists, so treat `open()` as fallible:

```ts
let adapter;
try {
  adapter = await OPFSAdapter.open({ path: 'workspace' });
} catch {
  adapter = new MemoryAdapter('workspace'); // degrade rather than fail
}
```

### Worker access

`createSyncAccessHandle()` gives synchronous, much faster file access, but only inside a Worker.
This adapter uses the async API so it works on the main thread. If you sync large files, run the
whole node inside a Worker and post results back.

---

## FSAAdapter

A real folder on the user's disk, chosen through `showDirectoryPicker()`.

```ts
import { FSAAdapter, isFSAAvailable } from '@cloudauthn/vfs-sync';

// must be called from a user gesture — a click handler, not a timer
button.addEventListener('click', async () => {
  const adapter = await FSAAdapter.pick({ id: 'workspace', mode: 'readwrite' });
  const node = await VFSNode.open(adapter);
});
```

`pick()` rejects with an `AbortError` when the user dismisses the dialog, which is a normal
outcome rather than a failure:

```ts
try {
  adapter = await FSAAdapter.pick();
} catch (error) {
  if (error.name === 'AbortError') return; // user changed their mind
  throw error;
}
```

### Permissions expire

This is the one thing that makes FSA meaningfully different from OPFS. A handle keeps working for
the life of the page, but after a reload the browser downgrades it to `prompt` and re-granting
needs a user gesture. A background sync loop therefore cannot silently resume.

```ts
if (await adapter.hasPermission()) {
  await sync(local, remote);      // safe to run unattended
} else {
  showReconnectButton(async () => {
    if (await adapter.ensurePermission()) await sync(local, remote);
  });
}
```

- `hasPermission(mode?)` — checks without prompting. Safe from a timer.
- `ensurePermission(mode?)` — prompts if needed. Needs a user gesture; returns `false` if refused.

Both default to `'readwrite'` and return `true` on browsers that expose no permission API.

### Remembering a folder across reloads

The handle itself is structured-cloneable, so IndexedDB can store it. Permission still has to be
re-granted, but the user does not have to find the folder again.

```ts
import { FSAAdapter } from '@cloudauthn/vfs-sync';

async function restore(): Promise<FSAAdapter | null> {
  const handle = await idbGet('workspace-handle'); // your IndexedDB helper
  if (!handle) return null;
  const adapter = FSAAdapter.fromHandle(handle, 'workspace');
  return (await adapter.hasPermission()) ? adapter : null;
}

async function choose(): Promise<FSAAdapter> {
  const adapter = await FSAAdapter.pick();
  await idbSet('workspace-handle', adapter.root);
  return adapter;
}
```

---

## NodeFsAdapter

A directory on disk, for CLI tools, servers, and tests against a real filesystem.

```ts
import { NodeFsAdapter } from '@cloudauthn/vfs-sync/node';
import { VFSNode, sync } from '@cloudauthn/vfs-sync';

const a = await VFSNode.open(await NodeFsAdapter.open('./workspace-a', 'a'));
const b = await VFSNode.open(await NodeFsAdapter.open('./workspace-b', 'b'));
await sync(a, b);
```

`NodeFsAdapter.open()` creates the directory if it does not exist; `new NodeFsAdapter(root)`
assumes it is already there. `mtime` is `mtimeMs` floored to whole milliseconds, so timestamps
compare identically across platforms after a JSON round trip.

It is imported from `@cloudauthn/vfs-sync/node` rather than the main entry so that browser
bundlers never have to resolve `node:fs`.

---

## MemoryAdapter

Everything lives in a `Map`. Nothing persists. Useful as a scratch peer, in tests, and as a
fallback when OPFS is unavailable.

```ts
import { MemoryAdapter } from '@cloudauthn/vfs-sync';

const adapter = new MemoryAdapter('scratch', {
  files: {
    'notes.md': '# Notes',                 // strings are encoded as UTF-8
    'data.bin': new Uint8Array([1, 2, 3]),
  },
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `files` | `{}` | Initial contents. |
| `clock` | monotonic wall clock | Source of `mtime`. Every write gets a strictly greater value than the last. |

Two extras exist for tests:

```ts
adapter.setMtime('notes.md', 5_000);  // script clock skew or a simultaneous edit
adapter.snapshot();                   // { path: text }, control folder excluded
```

The default clock never repeats a timestamp, which keeps conflict resolution unambiguous. Use
`setMtime` when you want a *specific* ordering, or pass your own `clock` to control it entirely.

---

## ScopedAdapter

A view of another adapter rooted at one of its subfolders. Any folder of any backend can host
its own `.vfs` store this way — it is how the explorer opens one subfolder of a MemFS or of a
picked local folder as a sync root.

```ts
import { MemoryAdapter, ScopedAdapter, VFSNode } from '@cloudauthn/vfs-sync';

const host = new MemoryAdapter('host');
const notes = await VFSNode.open(new ScopedAdapter(host, 'projects/notes'));
// notes reads and writes under projects/notes/; its store is projects/notes/.vfs
```

The wrapper only advertises the optional methods (`mkdir`, `fileId`, streaming) that its base
implements, so capability checks like `canStream()` keep telling the truth.

---

## Writing an adapter

Implement seven methods. Paths are relative to the adapter root, use `/` as separator, and never
start with `/` — the engine normalises before calling you, but normalising again costs nothing.

```ts
import type { VFSAdapter, VFSListEntry, VFSStat } from '@cloudauthn/vfs-sync';

export class MyAdapter implements VFSAdapter {
  readonly name = 'my-backend';

  /** Shallow listing. A missing directory returns [] rather than throwing. */
  async list(path: string): Promise<VFSListEntry[]> { /* … */ }

  /** Throws if the file is not there. */
  async read(path: string): Promise<Uint8Array> { /* … */ }

  /** Creates intermediate directories. Overwrites an existing file. */
  async write(path: string, data: Uint8Array): Promise<void> { /* … */ }

  /** Recursive. Deleting something already gone must not throw. */
  async delete(path: string): Promise<void> { /* … */ }

  /** First-class: this is how move intent reaches the engine. */
  async rename(oldPath: string, newPath: string): Promise<void> { /* … */ }

  /** null when the path does not exist. */
  async stat(path: string): Promise<VFSStat | null> { /* … */ }

  /** Optional. Only for backends with stable native identifiers. */
  async fileId?(path: string): Promise<string | null> { /* … */ }

  // Optional, all three. Omit them and the engine emulates them on top of
  // read/write — correct, but it holds whole files.

  /** Reads [start, end). `end` is exclusive. */
  async readRange?(path: string, range?: ByteRange): Promise<Uint8Array> { /* … */ }
  async readStream?(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> { /* … */ }
  /** Truncates on open, like write(). */
  async writeStream?(path: string): Promise<WritableStream<Uint8Array>> { /* … */ }
}
```

The contract the engine relies on, in full:

1. `list('')` is the root. A missing directory yields `[]`; it is not an error.
2. `stat('')` reports a directory. Anything absent is `null`, never a throw.
3. `write` creates parent directories, and overwriting replaces content and size.
4. `delete` is recursive and idempotent.
5. `rename` creates the destination's parent directories if needed.
6. `read` throws for a missing file.
7. `mtime` is milliseconds since the epoch and moves forward when content changes.

And, if you implement the streaming three:

8. Ranges clamp rather than throw: a `start` past the end yields empty, an `end` past the end
   stops at the end, and `start >= end` yields empty.
9. `readRange`/`readStream` throw for a missing file, exactly like `read`.
10. `writeStream` truncates on open, and aborting the writer must not throw.

`test/adapter-contract.test.ts` encodes exactly this and runs against every built-in backend. Point
it at yours and you will know it composes with the rest.

### Streaming

Implementing the optional trio is what lets a backend move a file bigger than memory. The engine
routes a blob through streams when it is at least `STREAM_THRESHOLD` (4 MiB, configurable per node
with `streamThreshold`) **and** both ends of the transfer report `canStream`. Below that it uses
one-shot reads, which are faster and where the memory does not matter.

The built-ins map onto native primitives:

| Backend | Range | Read | Write |
| --- | --- | --- | --- |
| OPFS / FSA | `Blob.slice()` — lazy, reads only the range | `Blob.stream()` | `createWritable()` |
| Node | `filehandle.read()` at a position | `createReadStream({ start, end })` | `createWriteStream()` |
| Memory | `subarray` | 64 KiB chunks | buffered |

`MemoryAdapter` implements them for uniformity, not for memory: the file *is* memory. It means the
streaming paths are exercised by the adapter the test-suite runs on.

Note the `end` convention: `ByteRange` is half-open `[start, end)` like `Blob.slice()`, while
node's `createReadStream({ end })` is inclusive. `NodeFsAdapter` does that conversion; a custom
adapter over a node-shaped API has to as well.

### Native ids

If your backend has a stable identifier that survives renames — Google Drive's `fileId` is the
motivating case — implement `fileId()`. The engine then tracks renames with certainty and skips
the hash heuristic entirely:

```ts
async fileId(path: string): Promise<string | null> {
  return (await this.metadataFor(path))?.id ?? null;
}
```

Return `null` for paths you have no id for; the engine falls back to synthetic ids for those. See
[architecture.md](./architecture.md#file-identity) for how identity is resolved when no native id
exists.
