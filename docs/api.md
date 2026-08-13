# API reference

Everything is exported from `@cloudauthn/vfs-sync`, except `NodeFsAdapter`, which lives in
`@cloudauthn/vfs-sync/node` so browser bundlers never resolve `node:fs`.

- [VFSNode](#vfsnode)
- [Conflicts](#conflicts)
- [sync](#sync)
- [syncMesh / syncUntilStable](#syncmesh--syncuntilstable)
- [Pairing](#pairing)
- [ConflictError](#conflicterror)
  - [legalAnswers](#legalanswers)
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
| `ignore` | none | Return `true` to keep a path out of sync entirely. Composes by union with `.vfsignore` and `local.ignore` — see [Excluding files](./recipes.md#excluding-files). |
| `materialize` | keep everything | Return `false` to take the entry without the bytes. See [selective materialisation](#selective-materialisation). |
| `text` | the header's extension list | Return `true` to claim a path for the three-way merge. Adds to the list, never subtracts — see [selecting by path](./conflicts.md#selecting-by-path). |
| `now` | `Date.now` | Injectable clock, mostly for tests. |
| `streamThreshold` | 4 MiB | Size from which content is hashed and moved as a stream. |
| `rotateAt` | 256 KB | Active log segment size that triggers a rotation. |

Creates `.vfs/` if it is not there. Opening the same folder twice returns nodes with the same `id`
— it is read back from `vfs.json`.

The header carries two identities, and they answer different questions.

| | Identifies | Born | Converges |
| --- | --- | --- | --- |
| `peerId` | **the node** | at init, a UUIDv4 | never |
| `syncId` | **the group** | on the first sync | yes, on the smaller — after the guard |

`syncId` is an explicit `null` until the folder has synced with someone. That `null` carries
information: it is what tells a folder that has never paired apart from one written by an engine
that had no notion of a group. Two folders showing the same `syncId` belong to the same mesh; two
showing different non-null ones are separate meshes, and [pairing them is refused](#pairing).

`options.id` overrides the generated `peerId`. **In production, omit it** — the default is already a
UUIDv4 per folder, and the option only exists because tests want fixed ids. If you do pass it, it
has to be globally unique: two folders that derive it the same way are the collision the guard
below is built to catch, and the guard is the only thing standing between that and a corrupted log
offset.

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

`node.name` is the adapter's label; `node.peerId` is this node's identity.

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

### Selective materialisation

A node can hold an entry without holding its content. The tree is complete on every peer; the folder
is not. Which bytes a node keeps is the `materialize` predicate, evaluated locally — the engine
stores nothing about it, so nothing about it travels and no two peers have to agree.

```ts
const phone = await VFSNode.open(adapter, { materialize: (entry) => entry.size < 10_000_000 });

node.wants(entry);                              // would this node keep these bytes?
materialised(entry);                            // does it have them right now?
await node.materialize(path, peer);             // fetch them, verified against the hash
await node.dematerialize(path, peer);           // release them, keep the entry
```

`materialised(entry)` is exported at the top level and is the way to ask whether an entry has a file
behind it: `mtime` is deleted on every adopt and only ever re-set from a real `stat()`, so its
presence means exactly "this node has seen this file on disk". It is also what keeps reconciliation
from reading a missing file as a deletion.

Three rules that are easier to know than to derive:

- **The policy governs what arrives, never what is already on disk.** Turning it `false` for content
  a node holds does not free the bytes, and does not leave them stranded at an old hash either.
- **`dematerialize` needs a peer that can serve the content**, checked before anything is removed.
  Releasing the last copy would leave the entry live mesh-wide with the bytes nowhere, which no node
  can detect on its own. If nobody holds it, the operation you want is `delete`.
- **The policy is the steady state.** Both methods are manual moves against it, so widening the
  predicate pulls content down on the next sync and a policy that still wants a file undoes a
  `dematerialize`.

Neither method writes a log row and neither changes `state`: which content a node stores is a local
storage decision, not an operation on the mesh.

### Which paths merge as text

```ts
const node = await VFSNode.open(adapter, { text: (path) => path.startsWith('catalog/') });

await node.isText('catalog/index');   // the full answer: mesh list OR this node's policy
node.marksText('catalog/index');      // this node's policy alone, synchronously
```

The `text` list in the header selects by extension and converges by union across the mesh; the
predicate selects by path and stays local. It is consulted when a version is **recorded**, not only
when a conflict is merged — that is where the base copy a three-way merge needs comes from, so a
policy added today does nothing for versions written yesterday. It adds to the list and cannot
subtract from it. [Selecting by path](./conflicts.md#selecting-by-path) has the reasoning.

Nothing adds to the travelling list at runtime. It converges by union and never shrinks, so widening
it is permanent for every peer — a decision the library does not offer as a one-liner.

### Exclusion rules

Three sources, composed by union: `.vfsignore` in the working folder (travels, plain text),
`local.ignore` in the header (does not travel), and the `ignore` predicate.

```ts
await node.setLocalIgnore(['scratch/', '*.local.json']);   // throws on a rule excluding .vfsignore

parseIgnore(text);              // string -> IgnoreRule[]
matchIgnore(rules, path);       // does any rule cover this path?
excludesRulesFile(patterns);    // would these exclude .vfsignore?
IGNORE_FILE;                    // '.vfsignore'
```

`parseIgnore` and `matchIgnore` are pure and exported so the language can be tested — and matched —
on its own. The syntax, the one place it differs from gitignore, and why `.vfsignore` can never be
excluded are all in [Excluding files](./recipes.md#excluding-files).

`.vfsignore` is not re-read on every scan: the walk already carries its `mtime` and `size`, which is
the same evidence the scan trusts to skip re-reading any other file. When it *has* changed, the pass
is redone under the new rules, so a rule takes effect in the pass it appears in rather than the one
after.

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

**A pass writes nothing while a conflict is waiting for a person** — not the disputed file, and not
the files travelling alongside it. Without a way to answer, it **throws**
[`ConflictError`](#conflicterror); with one, the answer settles it. The full catalogue of what can
stop a pass is [`conflicts.yaml`](./conflicts.yaml).

Answer in the moment, in one pass:

```ts
await sync(laptop, phone, {
  decide: async (conflict) => await askTheUser(conflict),   // or null to abort the pass
});
```

Or answer after a round trip through a UI:

```ts
try {
  await sync(laptop, phone);
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  const decisions = error.conflicts.map((conflict) => ({ id: conflict.id, action: 'keep-both' }));
  await sync(laptop, phone, { decisions });
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `decide` | none | Asked once per conflict, before anything is written. Return an answer, or `null` to abort the pass. |
| `decisions` | none | The same answers as data, each naming a conflict by `id`. Wins over `decide` when both answer one. |
| `conflictCopies` | `'edits'` | `'edits'`, `'always'` or `false`. See [conflicts.md](./conflicts.md#policy). |
| `conflictName` | `defaultConflictName` | Names conflict copies. |
| `heldAt` | 64 MB | Size from which a conflict copy stays on the peer that made it. |
| `autoMerge` | `true` | Set `false` to skip the three-way merge of text. |
| `resolveText` | none | Hook for interactive text resolution; return `null` for the headless path. |
| `dryRun` | `false` | Plan and report without writing either folder. |
| `now` | `Date.now` | Clock for the sync's own bookkeeping. |

Returns:

| Field | Type | Meaning |
| --- | --- | --- |
| `applied` | `boolean` | `false` when nothing was written: a dry run, or a conflict somebody declined. |
| `changed` | `boolean` | `false` when the two were already identical. |
| `configChanged` | `boolean` | `true` when the `text` config converged in this pass. |
| `conflicts` | `ConflictReport[]` | Everything that diverged. See [conflicts.md](./conflicts.md#reading-the-report). |
| `pending` | `ConflictPayload[]` | The subset needing a person, in the shape `decide` and `ConflictError` use. Non-empty means **nothing was written**. |
| `transferred` | `{ toA: number; toB: number }` | Files copied in each direction — predicted on a dry run. |
| `merged` | `number` | Text conflicts settled by a three-way merge instead of a copy. |
| `mergedPaths` | `string[]` | Which paths those were. |
| `actions` | `{ toA: SyncAction[]; toB: SyncAction[] }` | Filesystem actions per peer, performed or predicted. |
| `state` | `Hash \| null` | The digest both peers end on. |

```ts
const { changed, conflicts, transferred, merged } = await sync(laptop, phone);

if (!changed) console.log('nothing to do');
console.log(`moved ${transferred.toA + transferred.toB} file(s), auto-merged ${merged}`);
```

With confirmation — look first, then call the one that writes:

```ts
const preview = await sync(local, remote, { dryRun: true });
showPreviewToUser(preview.actions, preview.conflicts);
if (await userAccepted()) await sync(local, remote);
```

There was an `approveMerge` hook here and it is gone. Its only vocabulary was "no", which is the one
thing a caller can always do for itself, and it could not express the question that actually comes
up — *which version?* — which is what `decide` and `decisions` are for. What the hook did buy is
worth knowing: it previewed and applied inside **one** pass, where the two calls above are two, and
the folders are free to move between them. The next pass heals what lands in that window; if you
need it not to exist, do not show a preview at all.

`sync` reconciles both sides for you; calling `commit()` first is not required.

A quiet edge costs the reconciliation and nothing more: one `state` comparison decides there is
nothing to transfer, nothing to merge and nothing to append. `sync(a, b)` drives *both* nodes, and
reconciling a node means walking its working folder against its entries — so the floor here is that
walk, not a single read. `VFSStore.header()` exists for the other case: inspecting a store you are
not opening as a node.

---

### Planning without writing

```ts
const preview = await sync(a, b, { dryRun: true });
```

Computes what `sync(a, b)` would do **without writing either side**. It still scans both peers, so
pending local edits are included; it appends no log rows, moves no content and writes no header.

It is the same code path as a real sync, stopped where the first write would happen. That is the
point: a preview computed by different code than the sync it previews is a preview of nothing in
particular.

```ts
const preview = await sync(local, remote, { dryRun: true });
showPreviewToUser(preview.actions, preview.conflicts);

if (userAccepted()) {
  await sync(local, remote);
}
```

`SyncAction`:

```ts
type SyncActionType = 'write' | 'delete' | 'rename' | 'mkdir';

interface SyncAction {
  type: SyncActionType;
  uuid: string;
  kind: 'file' | 'directory';
  path: string;
  created?: boolean; // on a write that creates the file on that side
  from?: string;     // for rename
  to?: string;       // for rename
}
```

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

One bad edge does not paralyse the mesh: an edge that throws is reported in place and every other
edge in the pass still runs, so `MeshResult` carries `result` **or** `error`.

```ts
for (const { edge, result, error } of await syncMesh(edges)) {
  if (error) console.warn(`${edge.a.name} <-> ${edge.b.name}: ${error.message}`);
  else if (result.changed) console.log('updated', edge.a.name);
}
```

`syncUntilStable` does not count a failing edge as progress — a throw that repeats identically every
pass is not a reason to keep going.

---

## Pairing

Before anything is merged, `sync()` decides whether these two folders *may* merge. Nothing has been
written at that point, which is what makes stopping safe.

Two checks, in this order — reading `peerId` and `syncId` means nothing until you know which version
wrote them:

| Code | Means |
| --- | --- |
| `version-unreconcilable` | this engine cannot interpret the other folder's format |
| `peer-collision` | both folders claim the same `peerId`: one is a copy, or the id was imposed |
| `foreign-mesh` | two established groups with different `syncId`s |

Everything else is ordinary. Equal `syncId`s is every sync after the first; two `null`s mint one; a
`syncId` against a `null` is a folder joining a group, and needs no tiebreak because the one without
an affiliation has none to lose.

```ts
try {
  await sync(a, b);
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  const [refusal] = error.conflicts;          // at most one, with level: 'pairing'
  console.log(refusal.reason, refusal.ctxA.entries, 'files against', refusal.ctxB.entries);
}
```

A pairing refusal arrives as [`ConflictError`](#conflicterror) like everything else — one
`conflicts` entry with `level: 'pairing'`, carrying both folders' `peerId`, `syncId`, `version`, live
entry count, log digest and whether either has ever synced. That is what lets a caller present
*"1,240 files against 890"* instead of two uuids.

The library detects, describes and stops. Note what is **not** being decided here — there is no "this
folder wins" mode. Resolution stays per file and per version, with ancestry above the clock; the only
question settled is whether to merge at all.

To authorise a merge, name one of the two reported `syncId`s:

```ts
await sync(a, b, { adopt: { syncId: error.a.syncId } });
```

Specific on purpose. A blanket `true` would disarm the guard at that call site for ever, including a
different collision months later — it is the same "prove you knew the prior state" idiom as
`writeIf(path, data, tag)`. Once authorised the merge is the ordinary merge, and the smaller
`syncId` survives.

**`peer-collision` is not authorisable.** Merging two nodes with one identity is not a decision
anyone can make well: `peers` is keyed by `peerId`, so the two share a slot, each sync overwrites
the other's mark, and the log offset that mark carries is then applied to a log it does not describe.

The remedy is `node.reidentify()`, which mints a fresh `peerId` and returns it. It fixes one of the
two causes:

| Cause | Fixed by `reidentify()`? |
| --- | --- |
| the `.vfs` folder was copied | **yes** |
| `options.id` is derived from something non-unique | **no** — the next `open()` imposes it again |

The library cannot tell those apart: a clone predating the first sync and an imposed id look
identical from here. So it offers the operation rather than applying one, and a caller who
reidentifies and collides again has learned which case they are in.

`syncId` survives the call — reidentifying is not leaving the group, and for a copied folder both
sides are replicas of one mesh. Entries and log rows keep the old `peerId`, because that records who
changed what. One visible cost: every peer that has met this node holds a mark keyed by the old id,
so the next sync with each of them re-reads the whole log rather than the tail since an offset.

### Format versions

`vfs.json` migrates **eagerly** on read; the commit log migrates **in the reader**, because closed
segments are immutable and cached for ever. The rule generalises: what is mutable migrates eagerly,
what is immutable migrates in the reader.

```ts
CURRENT_VERSION;              // the version this engine writes
readable(2);                  // can it interpret a version 2 folder?
FORMAT_CHANGES;               // the registry, one entry per step
```

Each step declares whether it is `additive`, `migratable` or `breaking`. The distinction is not
cosmetic — it answers whether the change can ship in one go:

| `kind` | new engine reads old | **old engine reads new** |
| --- | --- | --- |
| `additive` | yes, nothing to do | **yes** — new fields it ignores |
| `migratable` | yes, via `migrate` | **no** |
| `breaking` | no | no |

The second column is the one that matters, because on shared storage the old engine *is* going to
read what the new one writes.

---

## ConflictError

Everything the engine can stop for, in one error with one list.

```ts
try {
  await sync(a, b);
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  for (const conflict of error.conflicts) {
    console.log(conflict.level, conflict.reason, conflict.path ?? '');
  }
}
```

| | |
| --- | --- |
| `conflicts` | One payload per unanswered conflict. `level: 'pairing'` is about the two folders and there is at most one; `level: 'entry'` is about one file and there can be many. |
| `pairing` | True when the pass stopped over the folders rather than over their files. |

Thrown **only when there was nobody to ask**. A `decide` callback that answered `{ action: 'abort' }`
was asked and said no, which comes back as a result with `applied: false` — a person cancelling a
dialog is an outcome, not a failure. `dryRun` never throws either: its job is to report.

Each payload names the conflict with `id` — the entry's uuid, or the `reason` for a pairing refusal —
and that is what an answer names back. The shape of every variant, and the answers legal for each, is
[`conflicts.yaml`](./conflicts.yaml).

```ts
type ConflictAnswer =
  | { action: 'keep'; side: 'a' | 'b' }        // that version survives
  | { action: 'keep-both' }                    // winner in place, loser parked beside it
  | { action: 'replace'; content: Uint8Array } // neither; the caller's bytes
  | { action: 'adopt'; side: 'a' | 'b' }       // both folders take that syncId
  | { action: 'reidentify'; side: 'a' | 'b' }  // that peer keeps its id; the other mints one
  | { action: 'abort' };
```

**`side` names the side that stays as it is**; the other yields. That holds for every action that
takes one, which is why it is not called `wins`: for `reidentify` the side named is the one that does
*not* change. `'a'` and `'b'` mean `ctxA` and `ctxB` of that payload — never the arguments of
`sync(a, b)`.

### legalAnswers

Not every action answers every reason, and the table is exported rather than left in a YAML file no
program can read:

```ts
legalAnswers('content');         // ['keep', 'keep-both', 'replace', 'abort']
legalAnswers('path-collision');  // ['keep', 'keep-both', 'abort']  — bytes cannot answer a name
legalAnswers('peer-collision');  // ['reidentify', 'abort']
```

Build a dialog from it and it cannot drift from what the engine accepts. **An answer a reason does
not admit throws `AnswerError`** (`reason`, `action`, `allowed`) at the call that supplied it. That
is a caller's mistake rather than a conflict, and it fails loudly for a reason: the shape every
consumer ends up writing is a loop —

```ts
async function settle(a, b, decisions = []) {
  try {
    return await sync(a, b, { decisions });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const answers = await askTheUser(error.conflicts);   // one answer per conflict
    return settle(a, b, answers);
  }
}
```

— and an answer the engine quietly declined to apply would come back as the same conflict, forever.

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
| `text` | `true` for paths that should get a three-way merge; drives `ConflictReport.text`. `sync()` builds this one by folding the header's extension list together with both nodes' `text` policies. |
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

Inside `sync()` the same three reasons reach the caller as `ConflictReport.textReason`, widened with
`'no-base'` and `'unreadable'` for the two ways a merge is skipped before `diff3` is ever called.

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
  PendingConflict, CopyReason,
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
  reason?: CopyReason;
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
