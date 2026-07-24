# API reference

Everything is exported from `@cloudauthn/vfs-sync`, except `NodeFsAdapter`, which lives in
`@cloudauthn/vfs-sync/node` so browser bundlers never resolve `node:fs`.

- [VFSNode](#vfsnode)
- [sync](#sync)
- [syncMesh / syncUntilStable](#syncmesh--syncuntilstable)
- [mergeTrees](#mergetrees)
- [VFSStore](#vfsstore)
- [walk](#walk)
- [Utilities](#utilities)
- [Types](#types)

---

## VFSNode

One participant in the mesh: a working folder plus its `.vfs/` control folder.

### `VFSNode.open(adapter, options?)`

```ts
const node = await VFSNode.open(adapter, {
  id: 'device-a',
  ignore: (path) => path.startsWith('node_modules'),
  now: () => Date.now(),
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | generated, then persisted | Stable peer id. Appears in commits and conflict-copy names. |
| `ignore` | none | Return `true` to keep a path out of sync entirely. |
| `now` | `Date.now` | Injectable clock, mostly for tests. |

Creates `.vfs/` if it is not there. Opening the same folder twice returns nodes with the same
`id` — it is read back from `config.json`, and a different `id` argument does not override it.

### Working-folder operations

```ts
await node.write('notes.md', new TextEncoder().encode('# Notes'));
const bytes = await node.read('notes.md');
await node.delete('notes.md');
await node.rename('notes.md', 'archive/notes.md');
```

`rename` is not `write` + `delete`: it records the move so the change travels as a rename, keeping
the file's identity and transferring no content. Renaming through the adapter directly still works
— the hash heuristic catches it — but going through the node is exact.

`node.name` is the adapter's label; `node.id` is the peer id.

### Partial reads and streams

`read`/`write` hold a whole file in memory. For files where that is not acceptable — or when only a
few bytes are wanted — there are three more:

```ts
const stat = await node.stat('track.mp3');

// [start, end), end exclusive, both optional
const header = await node.readRange('track.mp3', { end: 10 });
const trailer = await node.readRange('track.mp3', { start: stat.size - 128 });

const reading = await node.readStream('movie.mkv');           // ReadableStream<Uint8Array>
const writing = await node.writeStream('copy.mkv');           // WritableStream<Uint8Array>
await reading.pipeTo(writing);
```

`readRange` is the interesting one: on OPFS, FSA and Node it seeks, so reading an ID3 tag out of a
200 MB track costs a few hundred bytes rather than 200 MB. See
[Reading a file header](./recipes.md#reading-a-file-header) for a worked example.

Backends that do not implement these get them emulated on top of `read`/`write`, so the calls are
always available — just not always cheap. `canStream(adapter)` tells you which you have.

Writes through `writeStream` are ordinary working-folder writes: `commit()` afterwards to snapshot
them.

### `node.scan()`

Snapshots the working folder into a tree without committing. Files whose `mtime` and `size` still
match the hash cache are not re-read.

```ts
const tree = await node.scan();
for (const entry of tree.entries) {
  if (entry.deleted) console.log('gone:', entry.path);
  else console.log(entry.path, entry.size, entry.hash?.slice(0, 8));
}
```

### `node.commit(options?)`

Scans, then records a commit. Returns `null` when the tree is unchanged, so a polling loop does
not grow history. Also returns `null` for a folder that is empty and has never been committed.

```ts
const hash = await node.commit();
if (hash) console.log('committed', hash);

await node.commit({ force: true });          // commit even if unchanged
await node.commit({ timestamp: 1769000000000 });
await node.commit({ parents: [left, right] }); // hand-built merge
```

### `node.head()` / `node.headTree()` / `node.log(limit?)`

```ts
const head = await node.head();          // Hash | null
const tree = await node.headTree();      // the committed snapshot
const log = await node.log(20);          // newest first, following first parents
```

`log` entries are commits with their `hash` attached:

```ts
for (const commit of await node.log()) {
  const kind = commit.parents.length > 1 ? 'merge' : 'commit';
  console.log(commit.hash.slice(0, 7), kind, commit.peer, new Date(commit.timestamp));
}
```

### `node.applyTree(tree)`

Makes the working folder match a tree: deletes, then renames, then writes. Every blob the tree
references must already be in this node's object store, which is what `sync` guarantees before it
calls this. Useful when driving a merge by hand — see
[conflicts.md](./conflicts.md#custom-resolution).

### `node.store`

The underlying [`VFSStore`](#vfsstore), for inspection and for building tooling.

---

## sync

```ts
const result = await sync(a, b, options?);
```

Syncs one edge. Both peers end up with identical content and on the same merge commit.

| Option | Default | Meaning |
| --- | --- | --- |
| `conflictCopies` | `'edits'` | `'edits'`, `'always'` or `false`. See [conflicts.md](./conflicts.md#policy). |
| `conflictName` | `defaultConflictName` | Names conflict copies. |
| `now` | `Date.now` | Timestamp for the merge commit. |

Returns:

| Field | Type | Meaning |
| --- | --- | --- |
| `base` | `Hash \| null` | Most recent commit both peers already knew. `null` on a first encounter. |
| `head` | `Hash \| null` | The commit both peers now point at. |
| `changed` | `boolean` | `false` when the two were already identical. |
| `conflicts` | `ConflictReport[]` | See [conflicts.md](./conflicts.md#reading-the-report). |
| `transferred` | `{ toA: number; toB: number }` | Blobs copied in each direction. |

```ts
const { base, changed, conflicts, transferred } = await sync(laptop, phone);

if (base === null) console.log('first time these two have met');
if (!changed) console.log('nothing to do');
console.log(`moved ${transferred.toA + transferred.toB} blobs`);
```

`sync` commits both sides for you; calling `commit()` first is not required.

---

## syncMesh / syncUntilStable

```ts
const edges = [
  { a: laptop, b: phone },
  { a: phone, b: desktop },
];

const pass = await syncMesh(edges);              // one pass, in order
const rounds = await syncUntilStable(edges);     // repeat until settled
```

`syncMesh` returns `{ edge, result }` per edge. `syncUntilStable` returns an array of those
arrays, one per round, and stops when a round changes nothing or after `maxRounds` (default 10).

```ts
const rounds = await syncUntilStable(edges, { maxRounds: 5 });
console.log(`settled after ${rounds.length} round(s)`);

const conflicts = rounds.flat().flatMap((r) => r.result.conflicts);
```

A change moves one hop per pass, so a chain of *n* peers needs up to *n − 1* rounds.

---

## mergeTrees

The three-way merge on its own. Pure: no I/O, no adapters.

```ts
const { tree, conflicts } = mergeTrees(baseTree, aTree, bTree, {
  peerA: 'device-a',
  peerB: 'device-b',
  conflictCopies: 'always',
});
```

Useful for previewing a sync, for tests, and for custom resolution. `pairEntries(base, a, b)`
exposes the matching step alone, returning `{ id, base?, a?, b? }` items.

---

## VFSStore

The `.vfs/` folder as an object. `node.store` is the usual way to reach one.

```ts
// content-addressed objects
const hash = await store.putObject(bytes);
const bytes2 = await store.getObject(hash);
await store.hasObject(hash);

// trees and commits
const treeHash = await store.putTree(tree);
const commit = await store.getCommit(head);

// the commit index
const known = await store.known();   // Map<Hash, { hash, timestamp, parents }>

// config
const config = await store.readConfig();  // { id, head, peers }
store.invalidate();                       // drop memoised state, re-read from the adapter
```

`invalidate()` matters when something else writes to the same folder — another tab, another
process — since a store memoises `config.json`, the known-commits index and the hash cache.

---

## walk

Recursive file listing with `.vfs/` excluded.

```ts
import { walk } from '@cloudauthn/vfs-sync';

for (const file of await walk(adapter)) {
  console.log(file.path, file.stat.size, file.stat.mtime);
}

await walk(adapter, { ignore: (path) => path.endsWith('.tmp') });
```

Results are sorted by path. `ignore` receives directories too, so returning `true` for one skips
the whole subtree.

---

## Utilities

```ts
import {
  sha256, sha256Stream, Sha256, hashJSON, canonicalJSON, randomId,
  normalizePath, joinPath, dirname, basename, splitExtension,
  canonicalTree, EMPTY_TREE, CONTROL_DIR,
} from '@cloudauthn/vfs-sync';

await sha256(bytes);                    // hex digest
canonicalJSON({ b: 1, a: 2 });          // '{"a":2,"b":1}' — stable key order
normalizePath('/a//b/../c/');           // 'a/c'
splitExtension('archive.tar.gz');       // ['archive.tar', '.gz']
```

`sha256` needs Web Crypto, which in browsers means a secure context. It throws with an explicit
message rather than failing obscurely if `crypto.subtle` is missing.

`sha256Stream(stream)` and the `Sha256` class are the incremental form, for content too big to
hold. They produce the identical digest — `crypto.subtle.digest` is one-shot, so streaming needs
its own implementation, and the two are checked against each other at every block boundary in
`test/sha256.test.ts`.

```ts
const hasher = new Sha256();
for await (const chunk of chunks) hasher.update(chunk);
hasher.digest();                        // same hex as sha256(whole)
```

### Stream helpers

```ts
import {
  readRange, readStream, writeStream, canStream,
  collect, concat, chunked, pump,
  CHUNK_SIZE, STREAM_THRESHOLD,
} from '@cloudauthn/vfs-sync';

await readRange(adapter, 'track.mp3', { start: 0, end: 10 });
await collect(await readStream(adapter, 'notes.md'));   // stream -> Uint8Array
chunked(bytes, 4096);                                    // Uint8Array -> stream
await pump(source, target, (chunk) => hasher.update(chunk));
```

These take an adapter rather than a node, and each falls back to `read`/`write` when the backend
has no native implementation. `pump` is `pipeTo` with a per-chunk hook, and works against wrapped
writables that are not real `WritableStream`s.

---

## Types

```ts
import type {
  VFSAdapter, VFSListEntry, VFSStat, EntryKind,
  Tree, TreeEntry, Commit, Hash,
  NodeConfig, HashCache, CachedFile, PendingRename,
  ConflictReport, ConflictKind, ConflictCopyPolicy, ConflictNameInfo,
  MergeItem, MergeOptions, MergeResult, Side,
  SyncOptions, SyncResult, MeshEdge, MeshResult,
  VFSNodeOptions, CommitOptions,
  WalkOptions, WalkedFile, KnownCommit,
} from '@cloudauthn/vfs-sync';
```

The two you will touch most:

```ts
interface TreeEntry {
  id: string;              // survives renames
  path: string;
  hash: Hash | null;       // null on a tombstone
  size: number;
  mtime: number;           // logical, not the filesystem's
  deleted?: boolean;
  renamedFrom?: string;
  peer?: string;           // who last changed the content
}

interface VFSStat {
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
}
```

`VFSAdapter` is documented in full in [adapters.md](./adapters.md#writing-an-adapter).
