# Architecture

Folder sync between peers that may never all be online at once.

v1 borrowed git's shape — content-addressed blobs, tree snapshots, commits with parents. v2 keeps
the parts that earned their place and drops the rest: **the working file is the content**, `.vfs`
holds only metadata, and the whole of a folder's state is one file a peer can read in one request.

- [The mesh](#the-mesh)
- [The control folder](#the-control-folder)
- [`vfs.json`](#vfsjson)
- [The commit log](#the-commit-log)
- [Change detection](#change-detection)
- [File identity](#file-identity)
- [Deletes](#deletes)
- [Renames](#renames)
- [Ancestry without a graph](#ancestry-without-a-graph)
- [The sync algorithm](#the-sync-algorithm)
- [Large files](#large-files)
- [Not implemented](#not-implemented)

---

## The mesh

Every node is a peer. A node knows only the peers it syncs with **directly** — there is no global
view of the graph and no notion of "peers of my peers".

```
laptop  <-->  phone  <-->  desktop
```

`laptop` and `desktop` never exchange a byte. A change still reaches the far end because each edge
runs its own sync, independently and repeatedly. One pass moves a change one hop:

```ts
const edges = [
  { a: laptop, b: phone },
  { a: phone, b: desktop },
];

await syncMesh(edges);        // one pass over every edge
await syncUntilStable(edges); // repeat until nothing changes
```

This is why there is no server in the design, and why adding a peer never requires telling anyone
else about it.

---

## The control folder

Every synced folder carries a `.vfs/` directory, the way a repository carries `.git`. It is
excluded from the diff — otherwise each node would try to sync the other's metadata.

```
.vfs/
  vfs.json                     # the mirror of the folder: header, then a row per path
  commits                      # append-only log of operations, active segment
  commits-<ts>                 # closed segments, immutable
  vfs-<ts>.json                # cumulative snapshot taken when each segment closed
  base/<hash>                  # local only: previous text versions, for three-way merges
```

**Two entries on the normal path.** There is no object store, no commit per file and no
known-commits index. The pairs of rotated files appear only when the log outgrows its budget, and
`base/` never travels — no peer reads it, and losing it costs at most a conflict copy that need not
have happened.

---

## `vfs.json`

The mirror of the working tree, and the only file a sync has to read to decide anything.

```jsonc
{
  "version": 2,
  "storeId": "9f3c…",          // identity of the dataset; converges on the smaller
  "peer": "device-a",          // identity of this node
  "state": "4a28fc…",          // digest of the live entries, over the converging fields
  "text": ["xml", "nfo", "m3u", "cue", "txt", "md"],
  "log": { "segment": 1785102000000, "digest": "1f4a9c…", "rows": 412, "size": 51200 },
  "peers": { "device-b": { "lastSync": 1785102021367, "segment": …, "offset": …, "digest": … } },
  "local": { "verifiedAt": 1785102021367 },
  "entries": [
    {
      "uuid": "b7c1…",
      "kind": "file",
      "path": "docs/getting-started.md",
      "hash": "68796a…",
      "size": 18,
      "created": 1785101000000,
      "updated": 1785102021367,
      "peer": "device-a",
      "prev": "0a11b2…",       // the hash this version descends from
      "prevPath": "docs/start.md",
      "native": "1xP3rma92h5…" // fileId of Drive, where the backend has one
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `uuid` | Logical identity, stable across renames. |
| `kind` | `file` or `directory` — v2 records folders, so an empty one syncs. |
| `hash` | SHA-256 of the content, `null` for directories and tombstones. |
| `updated` | Hybrid logical clock: `max(now, highest seen + 1)`. |
| `peer` | Who last changed the entry. Travels with it, so credit survives relays. |
| `prev`, `prev2` | The hashes this version descends from — one step of history, inline. |
| `prevPath` | Where this version was moved from. |
| `native` | Backend id (Drive's `fileId`), when there is one. Node-local. |
| `mtime` | Disk mtime when `hash` was computed. Node-local, outside the digest. |
| `deleted` | Present only on tombstones. |
| `conflictOf`, `reason`, `base`, `held` | Only on a conflict copy — see [conflicts.md](./conflicts.md). |

### The header comes first

Everything before `entries` fits in a few hundred bytes, so a peer pulls `state`, `log` and `peers`
out of a range read and never fetches the tree. That is what keeps a quiet sync at **one read per
peer** when `entries` runs to megabytes.

### The state digest

`state` is computed over the **live** entries only, and over only the fields that converge: `uuid`,
`kind`, `path`, `hash`, `size`, `updated`. Left out are `native` (per backend), `created` and the
`prev*` chain (they depend on the route a version arrived by), `mtime` (per node), and tombstones
(each peer prunes those on its own schedule).

With that subset, two converged peers produce the same digest even though their `.vfs` folders
differ — so **one comparison decides whether there is anything to sync**, without walking entries.

---

## The commit log

`.vfs/commits` is append-only: one JSON object per line, no enclosing brackets and no commas, so
the file grows by *adding* and every line parses on its own.

```
{"op":"7f3a…","batch":"c81f…","at":1785102021367,"peer":"device-a","uuid":"b7c1…","type":"write","kind":"file","path":"notes.md","hash":"68796a…","prev":"0a11b2…","size":29}
{"op":"9b02…","batch":"c81f…","at":1785102021368,"peer":"device-a","uuid":"e440…","type":"delete","kind":"file","path":"todo.md","prev":"7c9e…"}
```

- **`op`** — `sha256(peer|uuid|at|type|path|hash)`. Computed by whoever originates the operation,
  independent of the replica it lands in. Recording the same operation twice yields the same id, so
  **merging two logs is set union**, deduplicated by `op`, and idempotent by construction.
- **`batch`** — groups the operations of one save or one merge, so a UI can say "this sync moved 3
  files". It is the unit v1 called a commit.
- **`type`** — `write` | `rename` | `delete`, a readable label; the fields are the truth (a `write`
  with `prev: null` is a creation, a changed `path` is a rename).
- **`prev2`** — only on the row that records an auto-merged text version, which descends from two
  parents. Without it a third peer holding one of them would reclassify the merge as a fresh
  conflict on every pass.

Rows are appended in **arrival order** and sorted in memory. If the file had to be ordered by date,
merging would insert in the middle and rewrite it whole — losing the only thing append-only buys:
stable offsets and a tail that can be read with a range request.

The log **does not belong to any peer**: identity lives in the row (`peer`), not in the filename. A
log per peer looks tidier but is worse — A would not carry B's operations when it meets C, and the
two sides of an edge would decide conflicts from different information.

### Two markers instead of a hash chain

Chaining rows (`id = sha256(previousId + row)`) would give incremental verification but does not
compose with a merged log: arrival order differs per replica, so a row's id would depend on who
wrote it and when they heard about it — and dedup by id, which is what makes union idempotent,
would stop working. Instead:

- **`log.digest`** — XOR of every `op`. Order-independent and replica-independent, so it answers
  *"do we hold the same set of operations?"* in one comparison. Equal to what was recorded for that
  peer means **their log is not read at all**.
- **`log.size` / `log.rows`** — detect growth and truncation, from a `stat` or a listing.

The XOR caveat is real: it is not a robust multiset digest, and an `op` inserted twice cancels out.
It rides on dedup by `op` being correct, which is an invariant the merge needs anyway.

### Rotation, and why it is not just hygiene

The log grows forever, so it **rotates**: past a threshold (256 KB) the active file is renamed to
`commits-<ts>`, a **cumulative snapshot** is written to `vfs-<ts>.json`, and a fresh `commits`
starts empty referring to both.

On Drive there is no append — extending the log re-uploads it — so without rotation every sync
resends the whole history. That is the exact problem `known-commits.log` had in v1.

**The snapshot is cumulative — previous snapshot ∪ current entries, tombstones included — and the
order matters: rotate and photograph first, prune `vfs.json` afterwards.** It is not "the tree at
that moment" but "the last known state of every uuid that has ever existed". The difference bites
as soon as tombstones are pruned: a delete pruned two segments ago is no longer in the current
`vfs.json`, so a non-cumulative snapshot would not carry it, and the file would come back to life.
Accumulating makes the invariant structural — the newest snapshot always knows at least as much as
any lagging peer.

Rotation also subsumes compaction twice over. The new segment can start from nothing, because rows
older than the snapshot can be ignored when merging: live state arrives through `vfs.json`, and what
this node knew is in the snapshot. And old archives become **deletable** — everything they know is
subsumed by the newest snapshot, except old `prev` chains, which only ever save a conflict copy that
need not have happened. Losing one degrades to an extra copy, never to a wrong decision.

---

## Change detection

Hashing every file on every sync would make the cost proportional to folder size rather than to what
changed. Entries carry the filter themselves:

1. Compare `mtime` + `size` against what the entry records.
2. **Match** → the recorded hash still stands. The file is not read.
3. **Differ** → read, hash, update the entry.

With catalogues of hundred-megabyte ROMs this stops being an optimisation: re-hashing a 700 MB file
because something touched it is a full read.

### `updated` is a logical clock, not the wall clock

`updated = max(now, highest updated in the store + 1)`. Remembering one maximum removes most of the
clock-skew risk: as soon as two peers have met once their logical dates are ordered against each
other, and a lagging clock cannot "lose against the past". The remaining gap is writes made offline
with a fast clock, before the sync that would correct it.

The disk `mtime` stays separate, in the node-local `mtime` field, purely for the fast filter.

---

## File identity

Entries are matched on `uuid`, not on path. Without that, a rename would read as "one file deleted,
another created" and the content would be re-transferred.

`uuid` is always the engine's own. **Backends with native ids** (Drive's `fileId`) record theirs in
`native` as well, which is what lets a change feed keyed by id be mapped back onto an entry — and
what makes rename tracking certain rather than heuristic.

For backends without one, resolution runs in this order:

1. **Recorded rename intent.** A `node.rename()` call is the strongest signal available, and the
   chain of them is collapsed to where each file *started*: a swap goes `a → tmp → b → a`, and
   reading one hop at a time pins each identity to the wrong file.
2. **Path continuity** — same path as last time. The common case. Skipped when this path was itself
   renamed away, since whatever sits there now is a different file that reused the name.
3. **Hash heuristic** — identical content under a path that has disappeared. Catches moves made
   outside the VFS entirely, such as dragging a file in Finder.
4. **A fresh uuid.**

Two files never share an identity: if a candidate uuid is already taken in this scan, the second
file starts a new one.

### When two peers disagree

Two peers that discovered the same file independently gave it different uuids. Matching then falls
back to **path** — but only between live entries of the same kind whose uuid the other side has
never heard of, by entry *or* by log. That guard is what the base tree provided in v1; without it a
file deleted and recreated at the same path merges into the entry it replaced. The lexicographically
smaller uuid wins and becomes canonical. The rule is deterministic, so both peers reach the same
answer without negotiating.

---

## Deletes

A delete leaves two traces, and the second is the important one:

1. an entry with `deleted: true` and its `updated` in `vfs.json` — the **shortcut**, which answers
   without reading anything else;
2. a `type: "delete"` row in the log, with its `at` — the **durable record**.

The row is the proof: its date shows the delete is newer than the version a lagging peer is
carrying. So the tombstone in `vfs.json` **does not have to be eternal** — it can be pruned once
every known peer has seen it, and the decision stays correct because the log (or the cumulative
snapshot behind it) still answers.

```
C (offline since t=50) has X with updated=50
A deleted X at t=100, and has already pruned the tombstone from vfs.json

without the log:  A has no X, C does → take it → X is resurrected
with the log:     last row for X = delete@100 > 50 → delete on C ✓
```

That moves the unbounded state — "everything that ever existed" — out of the file read on **every**
sync and into the rotation snapshot, which is opened only when there is an absent entry to explain.
It cannot be eliminated (forgetting a delete is wrong in a mesh with open membership) but it can be
paid for better.

---

## Renames

Renames are first-class: `prevPath` on the entry, and `type: "rename"` rows in the log.

Going through `node.rename()` captures the intent at the moment it happens:

```ts
await node.rename('notes.md', 'archive/notes.md');
```

The hash heuristic — same content, path gone — is the safety net for moves the VFS never saw. It is
a fallback and not the primary mechanism for two reasons: it is ambiguous when several files share
content, and it cannot distinguish a move from a delete-plus-create.

---

## Ancestry without a graph

v1 answered "did this side change?" by walking back to a common ancestor commit. v2 asks a narrower
question — *is the loser's version an ancestor of the winner's?* — and answers it per file, by
following `prev` links. The chain is walked in layers, cheapest first:

1. **`winner.prev === loser.hash`** — one step, nothing read. This is the overwhelmingly common
   case: each side edited at most once since the last sync.
2. **the active log segment** for that uuid — each row is a link `hash → prev` (and `prev2` when it
   was a merge).
3. **the cumulative snapshot**, whose entries also carry `prev`: one link further back.

If the chain runs out, the answer may be in a closed archive — the loser's `updated` says which one,
since the filename carries the timestamp. If that read is not worth paying for, or the archive has
been deleted, a real conflict is assumed and **the loser is kept as a copy**. Assuming conflict is
always the safe degradation.

Location works the same way and is resolved **independently of content**: if `loser.path` appears in
the winner's `prevPath` chain, the winner moved the file and its path stands — `a→b→c` against a
peer still sitting at `a` is a propagation, however far the chain runs. Symmetrically, if
`winner.path` appears in the loser's chain, the loser's path wins *even though its content loses*.
If neither chain explains the move, both moved it, and the newer `updated` decides.

An archive is therefore **never needed to decide state, only to avoid a conflict copy that was not
necessary**.

---

## The sync algorithm

What `sync(a, b)` does, in order:

1. **Reconcile both sides.** A scan turns disk state into entries; nothing changed means nothing is
   appended, so a quiet loop does not grow the log.
2. **Read the header** of the other peer's `vfs.json` — one range read.
3. **Converge config**: `storeId` on the lexicographically smaller, the `text` list by union.
4. **Compare `state`.** Equal digests, equal log digests → nothing to do. **Fin.**
5. **Merge the entries** in memory. The log is opened only when the entries cannot answer alone:
   when an entry exists on one side and not the other (it may be a delete whose tombstone was
   pruned), or when there are hash divergences to classify.
6. **Text**: content conflicts on extensions in the `text` list get a three-way merge attempt before
   anything is parked — see [conflicts.md](./conflicts.md).
7. **Transfer content**: read the working file on the winning side and write it on the other,
   **re-hashing on arrival** against the hash `vfs.json` declares.
8. **Close, in this order**: content is on disk → append the missing rows to each log → write both
   `vfs.json` with `log.*` and `peers.*` up to date.

That order is the recovery plan. If the process dies halfway, `vfs.json` comes up short — declaring
less than what is on disk — and the next reconciliation catches up. The opposite, a `vfs.json`
claiming content that never arrived, is not reachable.

### Applying renames safely

A rename whose destination is still occupied — a swap, or a chain of moves — steps through a scratch
path inside `.vfs/tmp/` first. Renaming straight into an occupied path would destroy whatever was
there. Content that is about to be overwritten but is still needed (a conflict copy is the peer's
own current file) is parked the same way, before anything moves.

### One writer per store

`commits` is a single shared file, so two concurrent appenders lose rows — the same exposure
`known-commits.log` had. The mitigation is explicit: compare `size`/`rows` against what the header
claims before appending and, if the file grew underneath us, re-read the tail and fold it in. Where
the backend offers a conditional write (`writeIf` — Drive's ETag + `If-Match`), that check-then-act
becomes atomic rather than merely likely.

---

## Reading a folder without walking it

With `vfs.json` read, the whole tree paints — sizes, dates, hashes — without a single listing. It is
the biggest saving of the redesign: opening a tab goes from a call per folder to one read.

But it mirrors **what the engine wrote**, not the disk. The moment anything writes around it (the
Drive web UI, the desktop client, Finder, another app) it stops being exact, and there is no way to
know without looking. So:

- **Paint** from `vfs.json`, always.
- **Reconcile** where it is obligatory anyway: the scan before a commit or a sync walks the disk in
  any case, plus the refresh button. `local.verifiedAt` records when that last happened.

The consequence a UI has to own: per-file state (*modified* / *untracked*) cannot be known without
touching the disk. On the first paint everything reads as recorded, and rows that differ are marked
when reconciling. That has to be shown ("verified X ago"), or a file edited from outside looks up to
date.

---

## Large files

A file at or above `streamThreshold` (4 MiB by default) is never held whole, provided both adapters
involved implement the streaming methods.

- **Hashing on scan.** `crypto.subtle.digest` is one-shot, so above the threshold the digest comes
  from the bundled incremental SHA-256 instead, fed a chunk at a time. Identical digest — a file has
  the same hash however it was computed, which is the property peers agree on.
- **Transferring.** `sync` streams from one working folder to the other, digesting on the way past.
  v1 got that verification for free, because writing to a content address *was* the check; v2 pays
  for it explicitly, and without it a truncated upload lands as "the newest version".

Range reads (`readRange`) are separate: they go straight to a `Blob.slice()` or a positional
`read()` — enough to parse a header out of a file far too large to load, and what the header of
`vfs.json` and the tail of the log are read with.

---

## Not implemented

**Historical content.** There is no way to recover a previous version of a file. `base/` holds the
last text version for merge purposes only, is local, and is pruned.

**Deduplication** between files with identical content: two copies are two transfers.

**A repository-level DAG.** There is no `log()` of commits and no "is A an ancestor of B?" across the
store. Ancestry exists, but per file — the `prev` chain, with `prev2` on merges — and the merged log
gives the per-file history, which is the one a UI shows.

**Delta transfer.** Streaming bounds memory, not bytes moved: a file still travels in full, so a
one-byte change to a large file transfers the whole file.

The v2 design notes, in Spanish, are in [design-v2.md](./design-v2.md); v1's are in
[design.md](./design.md).
