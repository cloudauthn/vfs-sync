# Changelog

## 0.2.0

The on-disk format goes to **version 3**. Existing folders migrate themselves; your code needs a
handful of renames. Both are covered below.

### Fixed

**Data loss: an exclusion rule deleted the files it was meant to skip.** `scan()` inferred deletions
from what the directory walk did not return, and a walk skips a path for three different reasons —
the user removed it, a rule filters it, or this node never held the bytes. Only the first is a
delete. The other two emitted a tombstone, and a tombstone travels, so adding an `ignore` rule on one
machine deleted the file on every other one. The peer that lost data was the one that did *not* have
the rule yet, which during any staggered rollout is somebody.

An entry is now preserved unless the current rule leaves it alone **and** this node has actually seen
the file on disk.

If you may already have lost files this way, see
[Recovering files a pre-0.2.0 rule deleted](./docs/recipes.md#recovering-files-a-pre-020-rule-deleted). The bytes usually
still exist, orphaned, on the peer that added the rule.

Removing the false tombstone exposed four bugs it had been covering, all fixed here: `apply()`
deleted a directory before renaming files out of it; content lookup gave up on a peer after the
first path it checked; two conflicting entries could resolve onto one path; and `MemoryAdapter`
renamed a directory without its empty subfolders.

### Added

- **Selective materialisation.** A node can hold an entry without holding its bytes — the tree is
  complete on every peer, the folder need not be. Pass `materialize` to `VFSNode.open`, and use
  `node.materialize(path, peer)` / `node.dematerialize(path, peer)` to fetch and release content on
  demand. Nothing about it is stored and nothing travels. See
  [Holding the entry without the bytes](./docs/recipes.md#holding-the-entry-without-the-bytes).
- **A pairing guard.** `sync()` now refuses to merge two folders that belong to different meshes, or
  that claim the same peer identity, stopping before anything is written — as a `ConflictError` with
  one `level: 'pairing'` payload, like every other conflict. Merge two groups by naming the one that
  survives, `{ adopt: { syncId } }`. See [Pairing](./docs/api.md#pairing).
- **A format-change registry**: `CURRENT_VERSION`, `FORMAT_CHANGES`, `migrateFile()`, `readable()`.
- `syncMesh` no longer loses the whole pass when one edge throws: each `MeshResult` carries `result`
  **or** `error`, and every other edge still runs.
- Newly exported: `materialised()`, `holds()`, `syncDryRun()` and its types.

### Changed — breaking

**Answering `foreign-mesh` now names the winner, and the other folder rejoins as a newcomer.** Same
shape, same `{ action: 'adopt', side }`, same `{ adopt: { syncId } }` — different outcome, so a
caller that passes what it passed before gets something else. Previously the answer merely authorised
the merge and the smaller `syncId` survived either way; now the group you name is the one that
survives, and the folder on the other side discards its `.vfs` and joins as a folder that has never
synced.

Every byte of content survives on both sides. What the losing folder gives up is everything it knew
*about* its files, and three consequences are worth reading before you ship this:

- **deletions it made come back**, if the winning group still holds the file — a tombstone is the
  only record that a deletion was deliberate;
- **conflict copies parked on it stop being pending**: the bytes stay as ordinary files under their
  conflict names, and `node.conflicts()` no longer lists them;
- **text-merge bases are gone**, so the first text conflict on those paths refuses with `no-base` and
  parks a copy instead of merging. It recovers once both sides have written.

Its `local.ignore` survives — that is configuration, not history. The full list is in
[docs/api.md](./docs/api.md#what-the-folder-that-is-not-named-gives-up).

What this buys: two groups that both created `notes.txt` no longer produce a question per file. The
joining side takes the group's identity by path, so identical bytes settle silently and different
bytes arrive as one file with two versions — which `keep`, `keep-both` and the text merge can all
answer — instead of two files claiming one name, where they could not.

The decision travels in a new header field, `absorbed`, which converges by union like `text`. A peer
of the losing group that was offline when the answer was given rejoins **without being asked again**,
whenever it turns up, with nobody present. That is deliberate: the answer is already forced, since
adopting the other way would undo a decision the mesh has recorded.

New alongside it: `SyncResult.discarded` reports what happened (and a `dryRun` reports it *instead of*
planning a merge whose inputs it refused to create), and `node.discard()` performs the same thing on
its own for a caller that has decided outside a sync.

The renames below are typed, so `tsc` points at every call site. None of them changes behaviour.

| Before | After |
| --- | --- |
| `node.id` | `node.peerId` |
| `VFSEntry.peer` | `VFSEntry.peerId` |
| `LogRow.peer` | `LogRow.peerId` |
| `VFSHeader.peer` / `VFSFile.peer` | `peerId` |
| `MergeSide.peer` | `MergeSide.peerId` |
| `ConflictNameInfo.peer` | `ConflictNameInfo.peerId` |
| `PendingConflict.peer` | `PendingConflict.peerId` |
| `file.storeId` | `file.syncId` — see below, the semantics differ |
| `emptyFile(peerId, storeId, segment, text)` | `emptyFile(peerId, segment, text)` |
| `store.init({ peer, storeId })` | `store.init({ peerId })` |

`VFSNodeOptions.id` keeps its name — it is the option, not the field. In production you should omit
it: the default is a UUIDv4 per folder, and an id derived from something non-unique is exactly the
collision the new guard exists to catch.

**`MeshResult.result` is now optional.** Code that reads it directly has to account for a failed
edge, and this one the compiler will flag:

```ts
for (const { edge, result, error } of await syncMesh(edges)) {
  if (error) console.warn(`${edge.a.name} <-> ${edge.b.name}: ${error.message}`);
  else if (result.changed) …
}
```

**`storeId` is gone, and `syncId` is not a rename of it.** `storeId` was written, converged and read
by nothing — it indexed nothing and authorised nothing. `syncId` names the group and is what the
pairing guard checks: it is an explicit `null` until the folder's first sync, then minted once and
shared. If you displayed `storeId` as a pairing identity, `syncId` is what you wanted; handle the
`null` for a folder that has never synced.

### Data migration

**Automatic, and there is nothing to run.** A v2 folder is migrated on read: `peer` becomes `peerId`
in the header and in every entry, and `syncId` is seeded from the old `storeId` rather than minted
fresh — which is what keeps an existing mesh from reading as two foreign ones on the first sync
after upgrading. A folder that had never synced gets `syncId: null` and adopts a group when it does.

The commit log is **not** rewritten. Closed segments are immutable and cached, so the reader accepts
both shapes instead. Operation ids are unaffected: they are computed from values, not field names,
so history stays comparable across the format change.

Upgrade every peer before syncing them. A v2 and a v3 engine now refuse each other with
`version-unreconcilable` rather than failing quietly — without that check they would agree on their
log digests, disagree on `state` for identical trees, and sync forever without converging.
