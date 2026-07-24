# Architecture

The engine borrows git's shape — content-addressed blobs, tree snapshots, commits with parents —
and applies it to folder sync between peers that may never all be online at once.

- [The mesh](#the-mesh)
- [The control folder](#the-control-folder)
- [Change detection](#change-detection)
- [File identity](#file-identity)
- [Deletes](#deletes)
- [Renames](#renames)
- [Finding the common ancestor](#finding-the-common-ancestor)
- [The sync algorithm](#the-sync-algorithm)

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
  config.json                  # this node's id, HEAD, peer bookkeeping
  objects/<hash[0:2]>/<hash>   # blobs and trees, content-addressed (SHA-256)
  commits/<hash>.json          # { tree, parents[], timestamp, peer }
  known-commits.log            # flat index of every commit this node has seen
  hash-cache.json              # local only: { path: { hash, mtime, size, id } }
```

### Blobs

File contents, addressed by `sha256(content)`. Identical files — across paths, across peers —
store and transfer once.

### Trees

A snapshot of the folder: a flat list of entries, sorted by id, encoded as canonical JSON so the
same logical tree always hashes identically on every peer.

```json
{
  "entries": [
    { "id": "8f3c…", "path": "notes.md", "hash": "b348…", "size": 42, "mtime": 1769000000000, "peer": "device-a" },
    { "id": "1a9e…", "path": "docs/old.md", "hash": null, "size": 0, "mtime": 1769000500000, "deleted": true, "peer": "device-b" },
    { "id": "77b1…", "path": "moved.md", "hash": "c91f…", "size": 12, "mtime": 1769000900000, "renamedFrom": "before.md", "peer": "device-a" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Identity that survives renames. Native where the backend has one, synthetic otherwise. |
| `path` | Current location. |
| `hash` | Content address, or `null` for a tombstone. |
| `mtime` | *Logical* modification time — see [change detection](#change-detection). |
| `deleted` | Present only on tombstones. |
| `renamedFrom` | Previous path, when this entry moved. |
| `peer` | Who last changed the content. Travels with the entry. |

### Commits

```json
{ "tree": "4a1c…", "parents": ["9b2d…", "e77f…"], "timestamp": 1769001000000, "peer": "device-a" }
```

No parents means a root commit; two means a merge between peers. A sync builds one merge commit
and writes the *same bytes* to both peers, so both arrive at the same hash without another round
trip.

---

## Change detection

Hashing every file on every sync would make the cost proportional to folder size rather than to
what changed. `hash-cache.json` avoids that:

1. Compare `mtime` + `size` against the cache.
2. **Match** → the cached hash still stands. The file is not read.
3. **Differ** → read, hash, update the cache.

The cache is local to each peer and never syncs. What travels between peers are the resolved
hashes already inside trees.

### Logical versus filesystem mtime

A tree entry's `mtime` is the *logical* modification time and is deliberately not the same thing
as the file's timestamp on disk. It moves only when something actually happened:

| Event | Resulting `mtime` |
| --- | --- |
| Content changed | The filesystem `mtime` |
| File renamed | Now |
| Nothing changed | Carried forward unchanged |

This matters because a sync writes files, which bumps their filesystem timestamps everywhere they
land. Carrying the logical value forward means conflict resolution compares *edit* times, not
write-to-disk times — otherwise the last peer to receive a file would always look like the most
recent author.

---

## File identity

Diffs match on `id`, not on path. Without that, a rename would read as "one file deleted, another
created" and the content would be re-transferred.

**Backends with native ids** (Google Drive's `fileId`) supply one through `fileId()`, and renames
are tracked with certainty.

**OPFS, FSA and Node** have no such thing, so the engine assigns a synthetic id when a path is
first discovered and carries it forward. Resolution runs in this order:

1. **Recorded rename intent.** A `node.rename()` call is the strongest signal available. It has to
   outrank path continuity: in a swap (`a → b`, `b → a`) both paths still exist, and trusting the
   path would pin each identity to the wrong file.
2. **Path continuity** — same path as the last commit. The common case. Skipped when this path was
   itself renamed away, since whatever sits there now is a different file that reused the name.
3. **Hash heuristic** — identical content under a path that has disappeared. Catches moves made
   outside the VFS entirely, such as dragging a file in Finder.
4. **The hash cache** — a file discovered but not yet committed already has an id, so scanning
   twice does not mint a second identity for it.
5. **A fresh id.**

Two files never share an identity: if a candidate id is already taken in this scan, the second
file starts a new one.

### When two peers disagree

Two peers that discovered the same file independently, and have never synced, gave it different
ids. There is no shared history to consult, so at their first encounter matching falls back to
**path**, and the lexicographically smaller id wins and becomes canonical from then on. Because
the rule is deterministic, both peers reach the same answer without negotiating.

---

## Deletes

A delete is an explicit tombstone, not an absence:

```json
{ "id": "1a9e…", "path": "docs/old.md", "hash": null, "size": 0, "mtime": 1769000500000, "deleted": true }
```

Tombstones stay in history rather than being purged. A peer that never saw the delete needs to see
the tombstone; given only an absence it would conclude the file never existed and helpfully
recreate it.

A delete on one side and an edit on the other, both since the common ancestor, is a real conflict —
see [conflicts.md](./conflicts.md#delete-versus-edit).

---

## Renames

Renames are recorded in the tree via `renamedFrom` rather than only inferred.

Going through `node.rename()` captures the intent at the moment it happens:

```ts
await node.rename('notes.md', 'archive/notes.md');
```

The hash heuristic — same content, path gone — is the safety net for moves the VFS never saw. It
is a fallback and not the primary mechanism for two reasons: it is ambiguous when several files
share content, and it cannot distinguish a move from a delete-plus-create.

---

## Finding the common ancestor

`known-commits.log` is a flat index of every commit a node has seen: its own, plus everything
learned from peers.

```
<hash> <timestamp> <parent>,<parent>
```

Negotiation is then a set intersection — `mine ∩ theirs`, most recent wins — instead of walking
the DAG object by object. It is the only mechanism used, for peers that have met before and for
first encounters alike; the empty intersection *is* the first-encounter case, and it needs no
special path.

This is the same idea as git's commit-graph: it speeds up negotiation without changing the data
model.

---

## The sync algorithm

What `sync(a, b)` does, in order:

1. **Commit both sides.** Nothing changed means no commit, so a quiet loop does not grow history.
2. **Find the common ancestor** by intersecting both `known-commits.log` indexes. No intersection
   means the base is the empty tree.
3. **Exchange missing commits.** Each side sends the commits the other lacks, with their trees, so
   both keep a complete index. Blobs stay where they are for now.
4. **Merge** the two trees against the base — see [conflicts.md](./conflicts.md).
5. **Transfer blobs** the merged tree needs, in whichever direction they are missing. Content that
   both sides already have moves nowhere, which is why a rename costs no bandwidth.
6. **Apply** the merged tree to both working folders: deletes, then renames, then writes.
7. **Commit the merge** with both heads as parents, identical on both peers, and point both at it.

### Converging without an extra round

If both sides already hold the merged tree but sit on different commits, no merge commit is
created. Both adopt the same existing one instead, chosen by a rule they can each apply alone:
newest timestamp, hash as tiebreak.

Without this, a chain never settles — every pass would mint a commit for the next pass to merge,
forever.

### Applying renames safely

A rename whose destination is still occupied — a swap, or a chain of moves — steps through a
scratch path inside `.vfs/` first. Renaming straight into an occupied path would destroy whatever
was there.

---

## Large blobs

A blob at or above `streamThreshold` (4 MiB by default) is never held whole, provided both adapters
involved implement the streaming methods. Three places would otherwise buffer a file:

- **Hashing on scan.** `crypto.subtle.digest` is one-shot, so above the threshold the digest comes
  from the bundled incremental SHA-256 instead, fed a chunk at a time. Identical digest — a blob has
  the same content address however it was hashed, which is the property peers agree on.
- **Storing.** The content address is only known once the last byte has been hashed, so a streamed
  blob is read twice: once to hash, once to write straight to `objects/<hash[0:2]>/<hash>`. The
  alternative — stage under a temporary name, then rename — is worse here, because `rename()` falls
  back to copy+delete on backends without a native move, which puts the whole blob back in memory.
- **Transferring.** `sync` streams the blob from one store to the other, re-hashing as it arrives.
  A truncated transfer therefore cannot land as a valid object: the digest will not match and the
  partial file is removed.

Range reads (`readRange`) are separate from all of this. They read the working folder, not the
object store, and go straight to a `Blob.slice()` or a positional `read()` — enough to parse a
header out of a file far too large to load.

## Not implemented

**Garbage collection.** Blobs and trees unreachable from any commit are never removed from
`objects/`. For folders with heavy churn this grows without bound.

**Delta transfer.** Streaming bounds memory, not bytes moved: a blob still travels in full, so a
one-byte change to a large file transfers the whole file.

The original design notes, in Spanish, are in [design.md](./design.md).
