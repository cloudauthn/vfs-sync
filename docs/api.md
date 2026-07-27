# API reference

Everything is exported from `@cloudauthn/vfs-sync`, except `NodeFsAdapter`, which lives in
`@cloudauthn/vfs-sync/node` so browser bundlers never resolve `node:fs`.

- [VFSNode](#vfsnode)
- [Conflicts](#conflicts)
- [sync](#sync)
- [syncMesh / syncUntilStable](#syncmesh--syncuntilstable)
- [mergeEntries](#mergeentries)
- [History](#history)
- [diff3](#diff3)
- [VFSStore](#vfsstore)
- [The `vfs.json` codec](#the-vfsjson-codec)
- [The commit log](#the-commit-log)
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
| `id` | generated, then persisted | Stable peer id. Appears in log rows and conflict-copy names. |
| `ignore` | none | Return `true` to keep a path out of sync entirely. |
| `now` | `Date.now` | Injectable clock, mostly for tests. |
| `streamThreshold` | 4 MiB | Size from which content is hashed and moved as a stream. |
| `rotateAt` | 256 KB | Active log segment size that triggers a rotation. |

Creates `.vfs/` if it is not there. Opening the same folder twice returns nodes with the same `id`
— it is read back from `vfs.json`.

The header also carries a `storeId`: the shared identity of the dataset, as opposed to `peer`, which
names this one replica. It is generated at init, and every sync makes both peers adopt the
lexicographically smaller of their two — deterministic and transitive, so a whole mesh settles on
one value. Two folders showing the same `storeId` are replicas of the same data.

### Working-folder operations

```ts
await node.write('notes.md', new TextEncoder().encode('# Notes'));
const bytes = await node.read('notes.md');
await node.delete('notes.md');
await node.rename('notes.md', 'archive/notes.md');
await node.mkdir('roms/megadrive');       // empty folders sync in v2
```

`rename` is not `write` + `delete`: it records the move so the change travels as a rename, keeping
the file's identity and transferring no content. Renaming through the adapter directly still works —
the hash heuristic catches it — but going through the node is exact.

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
200 MB track costs a few hundred bytes rather than 200 MB. It is also what the engine reads the
header of `vfs.json` and the tail of the log with. See
[Reading a file header](./recipes.md#reading-a-file-header) for a worked example.

Backends that do not implement these get them emulated on top of `read`/`write`, so the calls are
always available — just not always cheap. `canStream(adapter)` tells you which you have.

Writes through `writeStream` are ordinary working-folder writes: `commit()` afterwards to record
them.

### Reading the mirror

```ts
const entries = await node.entries();   // everything, tombstones included
const live = await node.live();         // tombstones dropped
const state = await node.state();       // digest of the live entries
const file = await node.file();         // the whole of vfs.json
```

None of these touches the disk — they read the mirror the engine wrote. That is the point (opening a
folder is one read, not a listing per folder) and also the caveat: as soon as something writes around
the engine the mirror drifts, and `file.local.verifiedAt` is the honest answer to "when was this last
checked?". Reconcile with `scan()` or `commit()`.

### `node.scan()`

Reconciles the working folder into entries without recording anything. Files whose `mtime` and
`size` still match what the entry records are not re-read.

```ts
const { entries, rows, batch } = await node.scan();
for (const entry of entries) {
  if (entry.deleted) console.log('gone:', entry.path);
  else console.log(entry.path, entry.kind, entry.size, entry.hash?.slice(0, 8));
}
console.log(`${rows.length} operation(s) in batch ${batch}`);
```

### `node.commit()`

Scans, appends what changed to the log, and writes `vfs.json`. Returns the batch id, or `null` when
nothing moved — so a polling loop does not grow the log.

```ts
const batch = await node.commit();
if (batch) console.log('recorded', batch);
```

Rotation and tombstone pruning happen here, in that order: photograph first, prune after.

### `node.externalChanges()`

What has changed under this root since the last look, from the backend's change feed — one request
instead of a listing per folder.

```ts
const changed = await node.externalChanges();
if (changed === null) await node.commit();          // no feed, or the token expired: walk
else if (changed.length > 0) await node.commit();   // something moved out there
```

`null` means the caller has to fall back to a full walk, and that is not an error path: the walk is
how this has always worked, and the feed is an optimisation on top of it. The first call returns
`null` too — there is no baseline until one has been established.

Two filters make the answer usable, and both are worth knowing about. The feed is **account-wide**
on the backend that motivates it (Drive), so changes are attributed to entries by their `native` id,
and anything that cannot be attributed — a file in a folder that has never been resolved — is
dropped until the next walk. And **your own writes come back in the feed**, so a change whose size
and mtime still match what the mirror records is discarded.

### `node.history()`

The ancestry this node can answer from without paying for an archive — its entries, the active log
segment and its cumulative snapshot. See [History](#history).

### `node.apply(target, source)` / `node.adopt(target)`

`apply` makes the working folder match a list of entries, pulling missing content from `source` and
**re-hashing everything that arrives** against the hash the entry declares. `adopt` then records
that list as the mirror, re-stamping the two node-local fields (`native`, `mtime`).

This is the pair `sync` uses, and what you drive when merging by hand — see
[conflicts.md](./conflicts.md#custom-resolution).

```ts
interface ContentSource {
  open(hash: Hash, entry: VFSEntry): Promise<ContentHandle | null>;
}
interface ContentHandle {
  size: number;
  read(): Promise<Uint8Array>;
  stream(): Promise<ReadableStream<Uint8Array>>;
}
```

### `node.store`

The underlying [`VFSStore`](#vfsstore), for inspection and for building tooling.

---

## Conflicts

```ts
const pending = await node.conflicts();          // reads vfs.json; no network, no sync
await node.resolve(pending[0].uuid, 'mine');     // keep what is at the disputed path
await node.resolve(pending[0].uuid, 'theirs');   // promote the copy
await node.resolve(pending[0].uuid, bytes);      // or write something else entirely
```

`PendingConflict` carries what a two-column or three-way view needs:

| Field | Meaning |
| --- | --- |
| `uuid` | The conflict copy's own uuid — what `resolve()` takes. |
| `of` | uuid of the entry in dispute. |
| `reason` | `'binary' \| 'block' \| 'delete-edit' \| 'kind'`. |
| `path` / `copyPath` | Where the winner lives, and where the loser was parked. |
| `peer` | Who wrote the losing version. |
| `held` | Set when the copy's bytes stayed on the peer that made it. |
| `base` | Ancestor hash, when whoever detected the conflict had it. |
| `mine` / `theirs` | `{ hash, size, updated }` for each side. |

Full treatment in [conflicts.md](./conflicts.md#pending-conflicts).

---

## sync

```ts
const result = await sync(a, b, options?);
```

Syncs one edge. Both peers end up with identical content and the same `state` digest.

| Option | Default | Meaning |
| --- | --- | --- |
| `conflictCopies` | `'edits'` | `'edits'`, `'always'` or `false`. See [conflicts.md](./conflicts.md#policy). |
| `conflictName` | `defaultConflictName` | Names conflict copies. |
| `heldAt` | 64 MB | Size from which a conflict copy stays on the peer that made it. |
| `autoMerge` | `true` | Set `false` to skip the three-way merge of text. |
| `resolveText` | none | Hook for interactive text resolution; return `null` for the headless path. |
| `now` | `Date.now` | Clock for the sync's own bookkeeping. |

Returns:

| Field | Type | Meaning |
| --- | --- | --- |
| `changed` | `boolean` | `false` when the two were already identical. |
| `conflicts` | `ConflictReport[]` | See [conflicts.md](./conflicts.md#reading-the-report). |
| `transferred` | `{ toA: number; toB: number }` | Files copied in each direction. |
| `merged` | `number` | Text conflicts settled by a three-way merge instead of a copy. |
| `state` | `Hash \| null` | The digest both peers end on. |

```ts
const { changed, conflicts, transferred, merged } = await sync(laptop, phone);

if (!changed) console.log('nothing to do');
console.log(`moved ${transferred.toA + transferred.toB} file(s), auto-merged ${merged}`);
```

`sync` reconciles both sides for you; calling `commit()` first is not required.

A quiet edge costs the reconciliation and nothing more: one `state` comparison decides there is
nothing to transfer, nothing to merge and nothing to append. `sync(a, b)` drives *both* nodes, and
reconciling a node means walking its working folder against its entries — so the floor here is that
walk, not a single read. `VFSStore.header()` exists for the other case: inspecting a store you are
not opening as a node.

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

`syncMesh` returns `{ edge, result }` per edge. `syncUntilStable` returns an array of those arrays,
one per round, and stops when a round changes nothing or after `maxRounds` (default 10).

```ts
const rounds = await syncUntilStable(edges, { maxRounds: 5 });
console.log(`settled after ${rounds.length} round(s)`);

const conflicts = rounds.flat().flatMap((r) => r.result.conflicts);
```

A change moves one hop per pass, so a chain of *n* peers needs up to *n − 1* rounds.

---

## mergeEntries

The merge on its own. Pure: no I/O, no adapters.

```ts
const { entries, conflicts } = mergeEntries(
  { peer: 'device-a', entries: aEntries },
  { peer: 'device-b', entries: bEntries },
  { history, conflictCopies: 'always', text: (path) => path.endsWith('.xml') },
);
```

| Option | Meaning |
| --- | --- |
| `history` | Ancestry. An empty one is legal and merely pessimistic — every divergence reads as a conflict. |
| `conflictCopies` | `'edits'` (default), `'always'` or `false`. |
| `conflictName` | Names the conflict copies. |
| `text` | `true` for paths that should get a three-way merge; drives `ConflictReport.text`. |
| `heldAt` | Size from which a conflict copy does not travel. |

Each `MergeSide` may also carry `knows(uuid)` — *that peer's own* knowledge, which is what the
path fallback turns on. The shared `history` is the union of both peers' and would vouch for
everything, which is exactly wrong there.

`pairEntries(a, b)` exposes the matching step alone, returning `{ uuid, a?, b? }` items.
`pickNewer(left, right)` is the tiebreak rule, exported so a caller can apply it identically.

---

## History

The ancestry index that replaces the commit DAG. It is just links, gathered from whatever the caller
was willing to read.

```ts
import { History } from '@cloudauthn/vfs-sync';

const history = History.from([entries, logRows, snapshotEntries]);

history.knows(uuid);                                   // heard of this identity at all?
history.last(uuid);                                    // { at, deleted, path } — the latest record
history.descends(uuid, hash, ancestor, [prev, prev2]); // is `ancestor` behind `hash`?
history.movedFrom(uuid, from, path, prevPath);         // was `path` once this uuid's home?
history.commonAncestor(uuid, left, right);             // the base a three-way merge needs
```

Log rows and entries carry the same links under the same names, so both feed in through `add()`.
Everything degrades the same way: a missing link makes the answer "unknown", and unknown ancestry is
treated as a real conflict — an extra copy, never a wrong decision.

---

## diff3

The line-based three-way merge, all-or-nothing by design.

```ts
import { diff3, MAX_TEXT_MERGE } from '@cloudauthn/vfs-sync';

const result = diff3(base, mine, theirs);
if (result.ok) console.log(result.text);
else console.log('declined:', result.reason);  // 'block' | 'size' | 'eol'
```

There is no mode that emits `<<<<<<<`. `splitLines(text)` is exported too; it keeps terminators, so
joining is exactly the original.

---

## VFSStore

The `.vfs/` folder as an object. `node.store` is the usual way to reach one.

```ts
// the mirror
const file = await store.read();          // the whole of vfs.json
const header = await store.header();      // just the header, via a range read
await store.write(file);                  // sorts, re-digests, writes

// the log
const rows = await store.logRows();       // the active segment, arrival order
const tail = await store.rowsSince(offset);
await store.append(rows, file);           // adds only what is missing, refreshes log.*

// rotation
if (await store.shouldRotate(file)) await store.rotate(file);
const snapshot = await store.readSnapshot(file);
const archive = await store.readArchive(segment);

// base copies for three-way merges (local only)
await store.putBase(hash, bytes);
await store.getBase(hash);
await store.pruneBase(keep);

store.invalidate();                       // drop memoised state, re-read from the adapter
```

`invalidate()` matters when something else writes to the same folder — another tab, another process
— since a store memoises `vfs.json`, the active segment and the snapshot.

---

## The `vfs.json` codec

```ts
import {
  encodeVFSFile, decodeVFSFile, parseHeader, headerOf,
  normalizeFile, canonicalEntry, sortEntries, stateDigest,
  emptyFile, extensionOf, HEADER_PROBE, DEFAULT_TEXT_EXTENSIONS,
} from '@cloudauthn/vfs-sync';

const bytes = encodeVFSFile(await normalizeFile(file));
const header = parseHeader(bytes.slice(0, HEADER_PROBE));  // null if the prefix stopped short
await stateDigest(entries);                                 // the converging digest
```

The layout is a format guarantee, not a formatting choice: header first, one entry per line, in
canonical order. `parseHeader` relies on it, and two converged peers produce byte-identical output.

---

## The commit log

```ts
import {
  makeRow, opId, canonicalRow, encodeRows, parseRows,
  unionRows, missingRows, sortRows, xorDigest, xorHex,
} from '@cloudauthn/vfs-sync';

const row = await makeRow({ batch, at, peer, uuid, type: 'write', kind: 'file', path, hash, prev });
const bytes = encodeRows([row]);
unionRows(mine, theirs);      // set union, deduplicated by `op`
xorDigest(rows);              // order- and replica-independent set digest
```

`opId` is `sha256(peer|uuid|at|type|path|hash)` — computed by whoever originates the operation,
never from the file it lands in, which is what makes union idempotent.

---

## walk

Recursive file listing with `.vfs/` excluded.

```ts
import { walk } from '@cloudauthn/vfs-sync';

for (const file of await walk(adapter)) {
  console.log(file.path, file.stat.size, file.stat.mtime);
}

await walk(adapter, { ignore: (path) => path.endsWith('.tmp') });
await walk(adapter, { directories: true });   // folders too, which v2 records
```

Results are sorted by path. `ignore` receives directories too, so returning `true` for one skips the
whole subtree.

---

## Utilities

```ts
import {
  sha256, sha256Stream, Sha256, hashJSON, canonicalJSON, randomId,
  normalizePath, joinPath, dirname, basename, splitExtension,
  CONTROL_DIR, ROTATE_AT, HELD_AT, ZERO_DIGEST,
} from '@cloudauthn/vfs-sync';

await sha256(bytes);                    // hex digest
canonicalJSON({ b: 1, a: 2 });          // '{"a":2,"b":1}' — stable key order
normalizePath('/a//b/../c/');           // 'a/c'
splitExtension('archive.tar.gz');       // ['archive.tar', '.gz']
```

`sha256` needs Web Crypto, which in browsers means a secure context. It throws with an explicit
message rather than failing obscurely if `crypto.subtle` is missing.

`sha256Stream(stream)` and the `Sha256` class are the incremental form, for content too big to hold.
They produce the identical digest — `crypto.subtle.digest` is one-shot, so streaming needs its own
implementation, and the two are checked against each other at every block boundary in
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

These take an adapter rather than a node, and each falls back to `read`/`write` when the backend has
no native implementation. `pump` is `pipeTo` with a per-chunk hook, and works against wrapped
writables that are not real `WritableStream`s.

---

## Types

```ts
import type {
  VFSAdapter, VFSListEntry, VFSStat, EntryKind, ByteRange,
  VFSChange, VFSChangeFeed,
  VFSEntry, VFSFile, VFSHeader, LogRow, LogMark, LogOpType, PeerMark, LocalState, Hash,
  PendingConflict, ConflictReason,
  ConflictReport, ConflictKind, ConflictCopyPolicy, ConflictNameInfo,
  MergeItem, MergeOptions, MergeResult, MergeSide, Side,
  SyncOptions, SyncResult, TextConflictInfo, MeshEdge, MeshResult,
  VFSNodeOptions, ScanResult, ContentSource, ContentHandle,
  WalkOptions, WalkedFile, Diff3Result,
} from '@cloudauthn/vfs-sync';
```

The two you will touch most:

```ts
interface VFSEntry {
  uuid: string;            // survives renames
  kind: 'file' | 'directory';
  path: string;
  hash: Hash | null;       // null for directories and tombstones
  size: number;
  created: number;
  updated: number;         // hybrid logical clock, not the filesystem's
  peer: string;            // who last changed it
  deleted?: true;
  prev?: Hash | null;      // the version this descends from
  prev2?: Hash;            // second parent, on an auto-merged text version
  prevPath?: string;       // where it moved from
  native?: string;         // backend id (Drive fileId). Node-local.
  mtime?: number;          // disk mtime when `hash` was computed. Node-local.
  conflictOf?: string;     // only on a conflict copy
  reason?: ConflictReason;
  base?: Hash;
  held?: string;           // the copy's bytes stayed on this peer
}

interface VFSStat {
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
}
```

`VFSAdapter` is documented in full in [adapters.md](./adapters.md#writing-an-adapter).
