# VFS Sync v2 — a minimal `.vfs` and sync by metadata

Succeeds [`design.md`](./design.md), which describes what is implemented today. It replaces its
sections 3 (commit model), 5 (deletes), 6 (renames), 7 (conflicts) and 8 (sync algorithm); sections 1
(VFSAdapter), 2 (`.vfs` as a control folder) and 4 (mtime+size filter) still hold as they are.

There is no migration: none of this is in production, so v2 replaces the format without negotiating
it.

## Why

Two observations, one from the code and one from the product.

**From the code.** The whole commit graph — `commits/`, `known-commits.log`, the tree objects, the
common-ancestor negotiation — exists to produce **one field per file**. It is literally this, in
`merge.ts`:

```ts
const contentChangedA = !ancestor || ancestor.hash !== left.hash || …
const contentChangedB = !ancestor || ancestor.hash !== right.hash || …
```

The ancestor is used to answer "did this side change?" and for the location dimension
(`ancestor.path`). Nothing else. If every entry carries its previous version, the merge works just as
well with no graph.

**From the product.** The synchroniser does not need to reason about file content: if one version is
newer than another, the newer one wins. The hash is still needed — to know whether two sides really
differ, and to verify what is received — but **not as a storage address**. And on Drive we barely
store blobs any more: with `reconstructBlobs` the working file *is* the blob, so `objects/` mostly
holds trees.

That is where v2 comes from: the working tree is the content, `.vfs` is metadata only, and the
metadata is compact enough to be read whole in one go.

### What goes away

| v1 | v2 |
| --- | --- |
| `config.json` | the `vfs.json` header |
| `objects/<xx>/<hash>` | **gone** — the working file is the content |
| `commits/<hash>.json` | rows of `commits` |
| `known-commits.log` | **gone** — there is no DAG to negotiate |
| `hash-cache.json` | entries of `vfs.json` (they already are `path → {hash, mtime, size}`) |

With it go the `reconstruct` mode (it becomes the only behaviour),
`materialize`/`hasStoredObject`/`objectPath`, the two-character bucket split, and the garbage
collection over `objects/` that was left pending in v1.

### Cost on Drive

The v1 numbers are measured in `test/gdrive-traffic.test.ts` and in the explorer model (a folder with
1 subfolder and 3 files); the v2 ones are the structural cost of the protocol.

| action | v1 (measured) | v2 |
| --- | --- | --- |
| open a vFS folder | 11 calls | **1** (read `vfs.json`) |
| expand `.vfs` | 1 per folder, ~1 per bucket | **1** (two entries) |
| sync with no changes | ~10 | **1 per peer** (read its header with `readRange`) |
| sync moving N files | ~36 with N=3 | 1 + N reads + N writes + 2 |

## 0. Expected workload

The system is for **media catalogues**: video-game ROMs and music files, each with its metadata files
alongside. That has a very specific shape, and several decisions in this document come out of it:

| catalogue trait | design consequence |
| --- | --- |
| Heavy content is **immutable**: a ROM or a `.flac` is written once and never edited again | The log grows with creations and renames, not with rewrites of the same file. Pruning superseded rows would barely save anything: what bounds the active file is rotation (§3) |
| What gets edited is the **metadata**: `.nfo`, `gamelist.xml`, `.cue`, `.m3u`, tags | Real conflicts are over small files. Keeping a copy of the loser is dirt cheap |
| **Organising means renaming and moving**, a lot | First-class `rename`, `prevPath`, and Drive's native `fileId` are worth more than content deduplication |
| Structure of **folders per system, artist or album**, sometimes empty | Recording directories in `vfs.json` is not an extra: today an empty folder does not sync |
| Files of **hundreds of MB** | The `mtime`+`size` filter of v1 §4 stops being an optimisation and becomes essential: re-hashing a 700 MB ROM because something touched it costs a full read |
| Collections of **thousands of files** that almost never change | A sync at rest has to cost one read, not a walk (§5, §6) |

One detail that follows from large files: the `hash` in `vfs.json` is **always computed by whoever
writes the file**, locally. A remote peer can never verify a hash without downloading the content, so
it trusts what the other declares — and that is why the received hash is checked on write (§4), which
is the only moment the bytes go past.

What is *not* a worry: trees with tens of thousands of files in `vfs.json`. A catalogue of 20,000
entries is a few MB of JSON, and with the `state` digest (§2) it is not even read in the normal case.

## 1. `.vfs` in v2

```
.vfs/
  vfs.json                     # mutable: current tree state + header
  commits                      # append-only: union of operations, active segment
  commits-<ts>                 # closed segments, immutable (§3)
  vfs-<ts>.json                # cumulative snapshot taken when each segment closes (§3)
  base/<hash>                  # local only: previous content of text entries (§4)
```

Two entries on the normal path. The `commits-<ts>` / `vfs-<ts>.json` pairs appear on rotation, are
immutable and are only read cold — never to decide a file's state, only to avoid an unnecessary
conflict copy (§4). `base/` is purely local: it keeps the previous content of text files for the
three-way merge (§4), it does not travel and no peer reads it.

## 2. `vfs.json`

It is the mirror of the tree and the only thing a sync needs to read in order to decide.

```jsonc
{
  "version": 2,
  "syncId": "9f3c…",           // identity of the group; null until the first sync
  "peer": "device-a",          // identity of this node
  "state": "4a28fc…",          // digest of the live entries, fixed fields (see below)
  "text": ["xml", "nfo", "m3u", "cue", "txt", "md"],   // extensions that get a text merge (§4)
  "log": {
    "segment": 1785102000000,  // current rotation; identifies the active file
    "digest": "1f4a9c…",       // XOR of the segment's `op`s: same set of operations?
    "rows": 412,
    "size": 51200,
    "snapshot": "vfs-1785102000000.json",   // cumulative snapshot on rotation (§3)
    "archives": [1784000000000, 1785102000000]   // closed segments, in case we have to look back
  },
  "peers": {
    "device-b": {
      "lastSync": 1785102021367,
      "segment": 1785102000000,  // how far I read, and from which segment
      "offset": 51200,
      "digest": "1f4a9c…"
    }
  },
  "local": {                   // this node only; whoever reads it from outside ignores it
    "driveChangeToken": "8421",
    "verifiedAt": 1785102021367,
    "pendingRenames": []
  },
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
      "prev": "0a11b2…",       // previous hash: one step of history, inline
      "prevPath": "docs/start.md",
      "native": "1xP3rma92h5…" // Drive fileId, when the backend provides one
    }
  ]
}
```

**Header first, `entries` last.** Everything before `entries` fits in a few hundred bytes, so a peer
reads the header with `readRange` and has `state`, `log` and `peers` without downloading the tree.
That is what keeps the "one read per peer" of §5 when `entries` weighs megabytes: the full file is
only read when the digests differ.

**Flat entries, not nested.** Nesting is of no use to the engine — pairing and merging are per entry
— and it complicates the diff. The explorer already rebuilds the tree from the paths (`buildTree`).

**Canonical order** (by `path`, then by `uuid` on ties) and a **digest over only what converges**:
`state` is computed over the live entries, and from each one the fields `uuid`, `kind`, `path`,
`hash`, `size` and `updated` take part. Left out are `native` (each backend has its own), `created`
and `prev*` (they depend on which route the version arrived by) and tombstones (each peer prunes them
on its own schedule, §4). With that subset two converged peers produce the same digest even when
their files are not byte-identical, and **a single comparison decides whether there is anything to
sync**, without walking entries.

**It records directories** (`kind: "directory"`). The v1 tree only had files, and a real hole comes
out of that: today **an empty folder does not sync** — you create the folder, sync, and it does not
show up on the other side. If `vfs.json` is going to be the mirror of the tree, let it be so all the
way.

**`prev` and `prevPath`** are one step of history, inline, and they replace the ancestor: `prev` says
which version this one descends from (and `prev2` the second one, when the version is a text
auto-merge, §4), and `prevPath` where it moved from. The common case is settled with that single
step; when it is not enough, the chain continues through the log and the snapshot (§4).

**`updated` is a hybrid clock, not the system time**: on write,
`updated = max(now, highest updated seen in the store + 1)`. It costs remembering a maximum and
removes the bulk of the clock risk: as soon as two peers have seen each other once, their logical
dates are ordered relative to one another, and a lagging clock cannot "lose against the past". Skew
only still bites on writes made offline with a fast clock (§10). The disk `mtime` stays separate, for
the filter of v1 §4; `updated` is the logical date that travels.

**`native`** stores the backend id when there is one (Drive's `fileId`). It is what makes it possible
to map an external change — the changes API returns a `fileId`, not a path — to an entry. The uuid
remains the logical identity.

**What travels and what does not.** The whole file is read as it stands, but `peers` and `local` are
markers of this node: whoever reads it from outside ignores them. The `text` list converges by union
on sync, the same way `syncId` settles on the smaller: two stores end up classifying the same way,
which is what §4 requires. `hash-cache.json` disappears because `entries` already carries
`hash`+`size`+`updated` per path, which is exactly the filter of v1 section 4.

## 3. `commits` — a merged append-only log

One row per operation, one JSON object per line, with no opening or closing brackets and no commas:
that way the file grows by **appending**, and each line parses on its own.

```
{"op":"7f3a…","batch":"c81f…","at":1785102021367,"peer":"device-a","uuid":"b7c1…","type":"write","kind":"file","path":"notes.md","hash":"68796a…","prev":"0a11b2…","size":29}
{"op":"9b02…","batch":"c81f…","at":1785102021368,"peer":"device-a","uuid":"e440…","type":"delete","kind":"file","path":"todo.md","prev":"7c9e…"}
```

- **`op`** — the operation id, `sha256(peer|uuid|at|type|path|hash)`. Computed by whoever originates
  it, **replica-independent**, and recording the same operation twice gives the same id: dedup by
  `op` is what makes the union idempotent.
- **`batch`** — groups the operations of one save or one merge, so the UI can say "this sync moved 3
  files". It is the unit that in v1 was a commit.
- **`type`** — `write` | `rename` | `delete`, a readable label; the fields are the truth (a `write`
  with `prev: null` is a creation; a change of `path` is a rename).
- **`prev2`** — only on the row that records a text auto-merge (§4): that version descends from
  **two** parents, and if only one were recorded, the third peer in a mesh could not prove that its
  version is an ancestor of the merge and would reclassify the same conflict on every pass. For the
  ancestry chain (§4), a row's parents are `prev` and `prev2`.

### Merging is union

The rows are immutable and identified, so merging two logs is **set union**, deduplicating by `op`.
The precedent already exists in v1: `known-commits.log` is one's own plus those learned from peers
(`addKnown`), only rewritten whole and sorted on every commit.

**Appended in arrival order; sorted in memory.** If the file had to be sorted by date, merging would
insert in the middle and it would have to be rewritten whole — losing the only thing we want from
append-only: that offsets are stable and the tail can be read with `readRange` (on Drive, an HTTP
`Range:`). The disk records "when I found out"; the real order is reconstructed by whoever reads.

This has a consequence that has to be respected: **the log does not depend on any peer**. The peer's
identity goes in the row (`peer`), not in the file name. A log per peer looked cleaner but is worse:
A would not have B's operations when syncing with C, and with the merged log they reach it through A.
Besides, both sides decide conflicts from the same information, which is what makes the decision
deterministic without another round.

### Hash chain: rejected

Chaining each row to the previous one (`id = sha256(previousId + row)`) would give incremental
verification, but **it does not compose with a merged log**: the arrival order differs on each
replica, so a row's id would depend on who wrote it and when they found out — and dedup by id, which
is what makes the union idempotent, would stop working.

Instead, two markers in the header with different jobs:

- **`log.digest`** — the XOR of every `op`. Order-independent and replica-independent, so it answers
  *"do we have the same set of operations?"* with one comparison. If it matches the one I recorded
  for that peer, **I do not read their log**.
- **`log.size` / `log.rows`** — they detect growth and truncation. The size comes from the listing
  (which already carries `size`) or from a `stat`.

XOR caveat: it is not a robust multiset digest — an `op` inserted twice cancels out. It depends on
dedup by `op` being correct, which is an invariant we need anyway. Alternative if it ever becomes a
problem: sum modulo 2²⁵⁶, also incremental and without that flaw.

### Rotating by segments

The log grows forever, so it is **rotated**: when the active file passes a threshold it is renamed to
`commits-<timestamp>`, a **cumulative snapshot** is saved (`vfs-<timestamp>.json`, see below) and the
new `commits` starts empty referencing both.

```
.vfs/
  vfs.json
  commits                      # active, bounded
  commits-1785102000000        # archive, immutable
  vfs-1785102000000.json       # cumulative snapshot: every known uuid, tombstones included
```

This is not just hygiene, it is what makes the log viable on Drive: **appending there means uploading
the whole file**, so without rotation every sync resends the entire history — the exact problem
`known-commits.log` has today. With rotation, what gets re-uploaded is bounded by the threshold.

**The snapshot is cumulative — previous snapshot ∪ state at rotation, tombstones included — and the
order matters: rotate and photograph first, prune `vfs.json` after.** It is not "the tree at that
moment" but "the last known state of every `uuid` that has ever existed". The difference bites as
soon as tombstones are pruned: a delete pruned two segments ago is no longer in the current
`vfs.json`, so a non-cumulative snapshot would not carry it — and resurrection would come back
through the back door. By accumulating, the invariant is structural: the latest snapshot always knows
at least as much as any lagging peer, with no rules to remember when compacting.

And it subsumes compaction twice over. The active segment can start from zero with no invariants to
respect, because **rows older than my snapshot can be ignored when merging**: the live state arrives
via `vfs.json` and what I knew is in the snapshot. And **old archives become deletable**: everything
they know is subsumed by the latest snapshot, except old `prev` chains, which only serve to avoid an
unnecessary conflict copy (§4) — deleting them degrades to some extra copies, never to a wrongly
decided state. The `segment` plays the role `epoch` was going to play: if the peer rotated, my offset
no longer applies and I read the new segment from the beginning.

### One writer per store

Real appending only exists on some backends: native in node (`'a'`) and in OPFS/FSA
(`createWritable({ keepExistingData: true })` + seek); on Drive the whole file has to be uploaded.
With a single shared file, two concurrent writers lose rows (last one wins). It is not a regression —
`known-commits.log` has the same exposure today — but the mitigation is explicit: **compare
`size`/`rows` against what I hold before appending**, and if the file grew underneath, re-read the
tail, merge and then append. Where the backend offers a conditional write — on Drive, ETag +
`If-Match` — the check-then-act becomes genuinely atomic: it enters the contract as an optional
`writeIf?` (§8).

### What the log is needed for, exactly

It is worth delimiting, because when it has to be read depends on it:

| for | essential? |
| --- | --- |
| Converging the content of a file both sides have | **No** — LWW over `vfs.json` is enough |
| Telling a real conflict from a propagation (§4) | No: without a log, assume conflict and keep a copy |
| User-readable history | No |
| **Knowing that an absent entry is a delete and not something new** (§4) | **Yes**, if tombstones are pruned |

The first three degrade well: the worst failure is *"I kept a conflict copy that was not needed"*.
The fourth is correctness, and it is the reason the active segment is accompanied by its snapshot
(§3): what the segment does not reach, the snapshot does, and neither of the two is pruned.

## 4. Merge

Replaces sections 5, 6 and 7 of v1. The rule agreed there is kept — **the more recent `updated` wins,
with the hash as tiebreak so both sides decide the same** — and so is the separation of content and
location.

**Pairing**: by `uuid`. When two peers discovered the same file separately and have different uuids,
it falls back to `path` — only between live entries whose `uuid` the other side knows neither by
entry nor by log — and the smaller of the two wins and propagates (same as today, §3 of v1). The
guard matters: in v1 the base tree provided it (`pairEntries` only pairs by path what the ancestor
does not know), and without it a delete-and-recreate would merge into the wrong entry.

For each paired entry:

| case | result |
| --- | --- |
| only one side has it, the other has a tombstone | `updated` decides: newer tombstone → it is deleted |
| only one side has it, and the other has neither entry nor tombstone | **look in the active segment and its snapshot** for that `uuid`: if the last thing they say is a newer `delete`, it is deleted; if they do not know it, it is new and is taken |
| both, same `hash` | no conflict; the higher `updated` wins for the metadata |
| both, different `hash` | the higher `updated` wins (tiebreak by `hash`) |
| `deleted` on one side, edited on the other | LWW; if the delete wins and content was at risk, a copy |

**Conflict detection without an ancestor: the `prev` chain.** When hashes differ, "the other side is
behind" has to be told from "both edited", and the question is one of ancestry, not presence: the
loser is an ancestor of the winner **if its hash appears while following the winner's `prev` chain
backwards**. It is not enough for the loser's hash to "appear earlier" in the log — two divergent
edits of the same parent both appear, one before the other, and they are the canonical conflict, not
a propagation.

The chain is followed in layers, cheapest first:

1. `winner.prev === loser.hash` — one step, reading nothing. It is the overwhelmingly common case:
   each side edited at most once since the last sync.
2. the active segment's rows for that `uuid`: each one is a `hash → prev` link (and `prev2` if it was
   a merge), followed until the loser's hash is reached or the chain runs out;
3. the snapshot, whose entries also carry `prev`, one link further back.

If the chain runs out and the loser's `updated` predates the current rotation, the answer may be in
an archive (below); if that read is not worth paying for — or the archive has already been deleted
(§3) — a real conflict is assumed → **the loser is kept as a copy** (`notes (conflict device-b
1f4a9c2e).md`, the same convention as today). Assuming conflict is always the safe degradation.

### When an archive is needed

This is the only question that may need to look backwards, and the answer is bounded:

| question | is the active segment + its snapshot enough? |
| --- | --- |
| is this absent entry a delete? | **Yes, always** — the cumulative snapshot carries the last state of every `uuid` that has existed (§3) |
| does the loser descend from the winner? | Yes, if its version postdates the rotation. If it predates it, the archive would know |

In other words: **an archive is never needed to decide state, only to avoid a conflict copy that was
not needed.** And you can tell when to look without opening it: if the loser's `updated` predates the
current `segment`, the answer is in the archive whose time range covers it (the name carries the
timestamp, and `log.archives` gives the ordered list). If that read is not worth paying for, a
conflict is assumed and the copy is kept — a safe degradation, and with this workload (§0) extremely
rare.

Archives are immutable: they are read cold, cached forever and never rewritten — and they are
deletable (§3): losing one only costs some extra conflict copies.

**Location.** Same logic, same chain: if `loser.path` appears in the winner's `prevPath` chain — the
segment's `rename` rows reconstruct it at any distance — then the winner moved the file and its path
rules: `a→b→c` against a peer still at `a` is propagation, however far away it is. Symmetrically, if
`winner.path` appears in the loser's chain, the loser is the one that moved and its path wins **even
though its content loses**: content and location are resolved separately, just as today. If neither
chain explains the move, both moved it → LWW by `updated`.

**Deletes.** A delete leaves two traces, and the important one is the second:

1. an entry with `deleted: true` and its `updated` in `vfs.json` — the **shortcut**, which answers
   without reading anything else;
2. a `type: "delete"` row in the log, with its `at` — the **durable record**.

The row is the proof: its date shows the delete postdates the version an out-of-date peer brings. So
the `vfs.json` tombstone **does not have to be eternal** — it can be pruned, and the decision remains
correct by consulting the log. Rule: when one side has an entry the other does not, the `uuid` has to
be looked up in the log before treating it as new.

```
C (offline since t=50) has X with updated=50
A deleted X at t=100, and has already pruned the vfs.json tombstone

without log:  A does not have X, C does → it is taken → X resurrects
with log:     last row for X = delete@100 > 50 → it is deleted on C ✓
```

That moves the unbounded state — "everything that ever existed" — out of the file that is read
**whole on every sync** and into the rotation snapshot, which is only opened when there is an absent
entry to explain. It cannot be eliminated (forgetting a delete is incorrect in an open-membership
mesh), but it can be paid for better.

**And here rotation (§3) replaces any pruning invariant**: the snapshot carries the last state of
every `uuid` that existed when the segment closed, tombstones included. As long as rotation happens
*before* pruning `vfs.json`, resurrection is impossible by construction — there is no rule to remember
when compacting, because nothing is compacted: a segment is closed and the snapshot is saved.

One case remains that no record fully fixes: **skewed clocks**. The hybrid clock of §2 narrows it to
a single gap — writes made offline with a fast clock, before the sync that would correct it — but in
that gap an invented `updated: 150` still beats a real delete at t=100 and the file resurrects. It
fails on the safe side: it keeps data instead of losing it.

**Integrity on receipt.** In v1, `putObjectStreamAt` re-hashes what it writes: *"a truncated transfer
cannot land as a valid object"*. Dropping content addressing removes that, so the received file has
to be **re-hashed against the expected hash**, which is in `vfs.json`. It is local and cheap, and
without it a truncated upload becomes "the newest version".

**Conflict copies without blobs.** The loser is no longer taken from `objects/`: before overwriting
the working file, it is copied to its conflict path. A rename instead of `materialize()`.

### Binary versus text

Not all content conflicts are alike, and the workload of §0 splits them cleanly: the heavy stuff is
binary and immutable; what gets edited is small text (`gamelist.xml`, `.nfo`, `.cue`, `.m3u`). Two
policies:

- **binary** — LWW + copy, as described above. This includes ID3/Vorbis tags: they are the most
  frequently edited metadata, but they live inside the `.flac`/`.mp3` and are binary;
- **text** — a **three-way merge** is attempted before falling back to LWW.

**The classification is decided by the `text` list in the header (§2), never by the content.** Both
sides have to classify the same way without talking — it is the invariant of this whole section — and
sniffing the content breaks it: each side inspects *its* version, which is exactly the one that
differs, so the same file can be text on one side and binary on the other. Sniffing is useful for
suggesting the list when creating the store; in the merge, an extension outside the list means
binary. Failing towards binary is failing towards LWW + copy: nothing is lost.

**The base is local and does not travel.** A three-way merge needs base + A + B. A and B are free —
the working file is the content — and the base is kept in `base/<hash>`: before overwriting a text
entry, its previous content is copied there. Retention is bounded by a signal that already exists:
backwards as far as the oldest `lastSync` in `peers`, so it prunes itself at the pace of sync. If the
base is not there — it was never saved, it was pruned, or the conflict is detected by a third peer —
it degrades to LWW + copy: the usual safe degradation, at zero protocol cost.

**The merge is computed by one side only: the LWW winner.** If both ran diff3 on their own they would
have to produce the same bytes — same algorithm, same line endings, same treatment of a file with no
trailing newline — across two implementations and forever. That is not necessary: `sync(a, b)` has
both nodes in front of it. It is computed once, and the result travels as an ordinary write whose row
carries `prev` *and* `prev2` (§3) — the two parents, which is what stops a third peer from
reclassifying the merge as a fresh conflict on every pass.

Guards: a **maximum size** for attempting the merge (1 MB: above that, LWW even if the extension says
text); **mixed CRLF and LF** between sides degrades to LWW (normalising would change the content, and
with it the hash); and **never `<<<<<<<` markers in the working file** — they would propagate a broken
XML to the whole mesh, and the emulator frontend reads it without asking. Either the merge comes out
clean and is written whole, or it is not written.

### The conflict stays pending; the sync, never

When the merge cannot manage alone — overlapping hunks, two edited binaries, delete versus edit, a
file against a directory — the decision belongs to the user. But sync runs in the background, in
chains and often with no UI in front: if one entry waited for an answer, the whole edge would stall,
and with it everything that peer propagates. So the two are separated: **the bytes always converge** —
the LWW lands, the copy is kept, the tree stays usable — and what stays pending is the **decision**,
as durable state that any peer with a user in front of it can attend to.

That state is not a new record: **it is the conflict copy itself**, which is already a real entry with
a real path and converges through the mesh on its own. Three fields are formalised on it:

```jsonc
{
  "uuid": "c0n1…",
  "kind": "file",
  "path": "gamelist (conflict device-b 1f4a9c2e).xml",
  "conflictOf": "b7c1…",   // the entry in dispute
  "reason": "block",       // why it did not resolve on its own
  "base": "0a11b2…"        // ancestor hash, if whoever detected the conflict had it
  // …hash, size, updated, peer: like any other entry
}
```

"Are there pending conflicts?" is "any entry with `conflictOf`?", over the file that is already being
read. And **resolving means writing the winner and deleting the copy** — two operations the engine
already knows how to do, in one `batch` — so the resolution propagates like any other write, and two
users resolving at once on different peers is an ordinary write conflict decided by the same rules.
There is no state machine.

`reason` is what the UI shows, and each value calls for a different screen:

| `reason` | what happened | what the UI offers |
| --- | --- | --- |
| `binary` | two edits of unmergeable content | keep mine / keep theirs |
| `block` | text with overlapping hunks | merge view, manual editing |
| `delete-edit` | one deleted, the other edited | recover / confirm the delete |
| `kind` | file against directory at the same path | choose who keeps the path |

A **location** conflict is deliberately absent from the table: it puts no content at risk — the file
lands at one of the two paths and that is that — so LWW is enough and asking would be noise.

**`kind` is the awkward case**, and v2 introduces it by recording directories. Setting the loser aside
stops being local: if the directory loses, it is renamed **with all its descendants** — N renames in a
single `batch`, or the tree is left inconsistent halfway through. The usual deterministic rule decides
who keeps the path, the loser is set aside in cascade, and the marker stays pending like the others.

**Large copies do not travel.** §0 assumes keeping the loser is dirt cheap because real conflicts are
over metadata — and a re-dump of a 700 MB ROM breaks that: it would be 700 MB per peer until someone
resolved it. Above a threshold (64 MB to start), the copy **stays on the peer that made it**: the
entry travels with `held: "device-a"` and its content is not transferred (§5); the explorer paints it
as remote, and "keep theirs" fetches it on demand — the same content-when-needed pattern v2 uses for
everything else.

For the explorer these are the two things it does not have today: enumerating conflicts without
syncing (today they only exist as the return value of `sync()`, and copies are detected by file name)
and a resolution that is state of the store, not of the tab. Where the base exists, a three-way view;
where it does not, two columns — which is plenty for deciding between two versions of a `.nfo`.

## 5. Sync protocol between two peers

Replaces section 8 of v1. There is no ancestor negotiation.

1. **Read the header** of the other peer's `vfs.json` (`readRange`, §2) — 1 read.
2. **Config**: the `text` list converges by union; group identity (`syncId`) is decided by the
   pairing guard rather than here, and the `text` list,
   by union.
3. **`state`**: if their digest matches mine, there is nothing to do. Done.
4. **Read the whole file** and do the **entry merge** in memory (§4) → per file: nothing / fetch /
   send / text auto-merge / conflict.
5. **Log**, when needed: if `log.digest` differs from the one I recorded, read from
   `peers[x].offset` — or the whole segment from the start if their `log.segment` is not the one I
   have recorded, because they rotated — and merge. It is needed in two cases, not just one:
   - **an entry exists on one side and not the other** → its `uuid` has to be looked up in the
     segment and its snapshot before treating it as new, because it may be a delete whose tombstone
     was already pruned (§4);
   - there are **conflicts** to classify (propagation or simultaneous edit?), and only here may an
     archive need opening — never to decide state.
6. **Transfer the content**: read the working file of the winning side and write it on the other,
   **re-hashing on arrival**. Conflicts also write their copy — except those above the threshold,
   which stay `held` on their peer (§4).
7. **Close, in this order**: the content is already on disk (step 6) → append to each log the rows it
   is missing → write both `vfs.json` files with `log.*` and `peers.*` up to date. The order is the
   recovery plan: if the process dies halfway, `vfs.json` comes up short — declaring less than what is
   on disk — and the reconciliation of §6 catches up; the opposite, a `vfs.json` declaring content
   that never arrived, must not be reachable.

A sync at rest is step 1 and step 3: **one read per peer**. The log only comes into play when the
entry sets differ, which is when something has actually happened.

## 6. Reading a vFS folder without walking it

With `vfs.json` read, the directory tree is painted whole — with sizes, dates and hashes — without
walking anything. It is the biggest saving of the redesign: opening a tab goes from one call per
folder to one read.

But it mirrors **what the engine wrote**, not the disk: as soon as something writes from outside (the
Drive web app, the desktop client, Finder, another app) `vfs.json` stops being exact and there is no
way to know without looking. The separation:

- **Paint** from `vfs.json`, always.
- **Reconcile** where it is already mandatory: the scan before a commit or a sync walks the disk
  anyway, plus the refresh button. `local.verifiedAt` records when the last time was.

With one consequence the UI has to accept: per-file state (*modified* / *untracked*) **cannot be known
without touching the disk**. On the first paint everything shows as recorded, and rows that differ are
marked on reconciliation. That has to be shown ("verified X ago"), because otherwise a file edited
from outside looks up to date.

## 7. `/drive/v3/changes` — a self-healing mirror

It was already noted in section 1 of v1 and is now the piece that makes the mirror trustworthy: in
**one** request it says whether anything changed, instead of O(folders).

```
GET /drive/v3/changes/startPageToken            → { startPageToken }      (once)

GET /drive/v3/changes
      ?pageToken=<token>
      &pageSize=1000
      &spaces=drive
      &restrictToMyDrive=true
      &fields=newStartPageToken,nextPageToken,
              changes(fileId,removed,file(id,name,parents,mimeType,size,modifiedTime,trashed))
```

- The token is stored in `local.driveChangeToken`; each response carries `newStartPageToken` when the
  end is reached, and that is the one persisted — when the cycle closes, not per page: on Drive every
  write of `vfs.json` is a full re-upload.
- **It cannot be filtered by folder**: the feed is account-wide. It is filtered client-side by
  `file.parents` against the folders we know, and by `fileId` against the `native` values in
  `entries` — which is exactly what that field is for. A change in a subfolder we have never resolved
  cannot be attributed and is ignored until the next walk: an honest caveat.
- **Our own changes appear in the feed too.** They have to be discarded by comparing against
  `entries` (same `hash`/`size`/`updated`), or every write of ours will look like an external change.
- **The token expires**: Drive answers `410 Gone` if it falls too far behind. The way out is to
  request a fresh `startPageToken` and do a full walk — the usual path, which still exists.
- **Scope**: the feed's behaviour with `drive.file` (per-file access) has to be verified. If it only
  reports files created by the app, it still works for our purposes; if not, it requires the `drive`
  scope. It is an optimisation, so the fallback is the walk and it blocks nothing.

## 8. Changes to the adapter contract

Two more optional methods, with the same philosophy as the streaming trio: if the backend does it
better, implement it; if not, it is emulated.

| method | native | emulated |
| --- | --- | --- |
| `append?(path, data)` | node `'a'`; OPFS/FSA `keepExistingData` + seek | read, concatenate, write |
| `changes?(token)` | Drive `changes.list` | none: without it, walk |
| `writeIf?(path, data, tag)` | Drive ETag + `If-Match` | none: compare `size`/`rows` and accept the race (§3) |

What already exists and v2 uses as is: `readRange` (reading the log's tail and the `vfs.json` header),
and the optional `stat` on `list()` entries — which is what makes it possible to reconcile a folder
with a single request.

### Conflict API

What the library exposes for pending resolution (§4):

```ts
node.conflicts(): Promise<PendingConflict[]>;  // reads vfs.json; no network, no sync
node.resolve(uuid: string, choice: 'mine' | 'theirs' | Uint8Array): Promise<void>;
                                               // writes the winner + deletes the copy, one batch
```

And in `SyncOptions`, an optional `resolveText?: (info) => Promise<string | null>` hook for the
interactive case: if it is there and returns content, that is the resolution; if it is absent or
returns `null`, the usual headless path (LWW + copy + pending). `ConflictReport` remains the immediate
result of `sync()`; the difference is that now there is durable state behind it.

## 9. What is lost

- **Historical content**: a previous version cannot be recovered. In practice that was already the
  case — there is no restore API, and old blobs no longer travel in v1 (*"blobs stay on demand"*).
- **Deduplication** between files with identical content: two copies are two transfers.
- **The DAG**: there is no commit `log()` and no "is A an ancestor of B?" at the repository level.
  Ancestry exists, but per file — the `prev` chain, with `prev2` on text merges — and the merged log
  gives the per-file history, which is the one that gets shown.

## 10. Risks

1. **A stale mirror** (§6): mitigated with explicit reconciliation, a visible `verifiedAt` and the
   changes API where it exists.
2. **Rotating without a snapshot, or pruning `vfs.json` before photographing** (§3, §4): it is the
   only thing that can resurrect a deleted file. With the cumulative snapshot it is a code invariant
   with its own test (§11), not a policy: rotate, prune, and check that an old peer with the file
   live still sees the delete.
3. **One writer per store** (§3): compare `size`/`rows` before appending; `writeIf` where the backend
   offers a conditional write (§8).
4. **XOR as a set digest** (§3): it depends on dedup by `op`.
5. **Clock skew**: the hybrid clock (§2) reduces it to a single gap — writes made offline with a fast
   clock, before the sync that would correct it — and there the conflict copy is still the net. It
   fails towards keeping data. Segment accumulation stops being a risk: old archives are deletable
   (§3).
6. **`base/` grows with an abandoned peer**: retention is tied to the oldest `lastSync`, so a peer
   configured and forgotten keeps it alive indefinitely. A hard size/age cap; going over only degrades
   the auto-merge to LWW + copy.
7. **The auto-merge is only worth as much as the real diffs**: a scraper that rewrites `gamelist.xml`
   whole (indentation, attribute order) turns any edit into a total diff and the merge will never
   apply. Measure it with real files before investing further there (§11).

## 11. Phased plan

0. **Convergence as a property**: before the format, a property test — 3 peers, a random sequence of
   writes/renames/deletes, edge sync to a fixed point, and the assertion that `state` and the disk end
   up identical on all of them. v2 trades a structural guarantee (the DAG) for a property of the merge
   algorithm, and that class of property breaks in the cases nobody writes by hand. Run it against v1
   first (it must pass) and keep it alongside every subsequent phase.
1. **Format**: read and write `vfs.json` and `commits` (canonical order, digest over live entries,
   union, offsets, header via `readRange`), plus rotation with its cumulative snapshot (§3) and the
   test that fixes the order: rotate, prune, and check that an old peer with the file live still sees
   the delete.
2. **Merge**: adapt `merge.ts` — the two-dimensional resolution is kept and the ancestor is replaced
   by the `prev`/`prevPath` chains. The tests in `merge.test.ts` are translated case by case, plus the
   ones that do not exist today: an absent entry with a pruned tombstone (§4), divergence from the
   same parent classified as a conflict and not a propagation, a chained rename `a→b→c` against a peer
   still at `a`.
3. **Sync**: rewrite `sync.ts` with the protocol of §5. `sync.test.ts` and `engine-edges.test.ts`
   should pass almost untouched: they describe behaviour, not format.
4. **Text and pending conflicts** (§4): the `text` list, `base/` with its retention, diff3 with its
   guards and `prev2`; the `conflictOf`/`reason`/`held` fields and
   `node.conflicts()`/`node.resolve()`. This is also where the measurement with real `gamelist.xml`
   files goes (§10) — if the diffs are not local, diff3 gets trimmed back before it is polished.
5. **Node**: `VFSNode` no longer has an object store; `VFSStore` shrinks to the I/O of the two files.
   `objects/`, `commits/*.json`, `known-commits.log`, `hash-cache.json`, the `reconstruct` mode and
   all of `materialize*` are deleted.
6. **Explorer**: paint from `vfs.json`, reconcile separately (§6), and the pending-conflicts view:
   enumerate without syncing, resolve in two columns or three-way (§4). The lazy `.vfs` view that
   exists today is simplified out of existence.
7. **Drive**: `changes?` in the adapter and the incremental reconciliation cycle (§7).
8. **Adapters**: `append?` and `writeIf?` with their emulations, and the contract brought up to date
   in `docs/adapters.md`.

## Open decisions

Closed in this document: the unit of `batch` (one per user save and one per merge, which is how the
UI reads it), when to prune a tombstone (as soon as every known peer has seen it —
`peers[*].lastSync` later than the delete — because the cumulative snapshot covers whoever
reappears), and the size of `vfs.json` on large trees (the header is read with `readRange`; the whole
file, only when the digests differ).

What remains is tunable and does not change the format:

- **Rotation threshold**: it is literally "how much am I willing to re-upload on each sync", because
  on Drive appending means rewriting the active segment. Start at **256 KB**, and also rotate after a
  bulk import rather than waiting for the threshold — importing a whole catalogue generates thousands
  of rows at once.
- **`held` copy threshold** (§4): 64 MB to start; it only changes when a copy travels, not whether it
  exists.
- **Initial `text` list**: which extensions ship by default (`xml`, `nfo`, `m3u`, `cue`, `txt`, `md`…)
  and whether sniffing at creation time can propose more.
- **Log index by `uuid`**: it is built by reading the active segment and its snapshot, so the first
  lookup of a pruned delete costs that read. Is the index persisted in `local` so it is not repeated
  across sessions, or is the cost accepted the first time it is needed?
- **Verified state per entry**: a global `verifiedAt` (simple) or one per entry (which allows marking
  *modified* only on what has been checked)?
- **`drive.file` and the changes API**: verify before relying on it (§7).
