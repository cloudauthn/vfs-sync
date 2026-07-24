# @cloudauthn/vfs-sync

Multi-peer folder sync for the browser and Node, with a git-shaped core: content-addressed
blobs, tree snapshots, and merge commits.

Any combination of backends can sync with any other — OPFS, a real folder picked through the
File System Access API, a Node directory, or plain memory. Peers form a **mesh, not a
hub-and-spoke**: a node only knows the peers it syncs with directly, and a change travels down a
chain (`OPFS ↔ local folder ↔ local folder`) because every edge runs its own sync independently.

**[▶ Live demo](https://cloudauthn.github.io/vfs-sync/)** — three OPFS peers wired as a chain, with
conflicts, renames and deletes you can trigger by hand.

```sh
npm install @cloudauthn/vfs-sync
```

## Quick start

```ts
import { FSAAdapter, OPFSAdapter, VFSNode, sync } from '@cloudauthn/vfs-sync';

const a = await VFSNode.open(await OPFSAdapter.open({ path: 'workspace' }));
const b = await VFSNode.open(await FSAAdapter.pick()); // user picks a folder

await a.write('notes.md', new TextEncoder().encode('# Notes'));

const result = await sync(a, b);
// -> { base, head, changed: true, conflicts: [], transferred: { toA: 0, toB: 1 } }
```

Both folders now hold the same files and point at the same merge commit.

### Chains and meshes

`sync` handles one edge. Declare the edges you have and let changes propagate:

```ts
import { syncUntilStable } from '@cloudauthn/vfs-sync';

const edges = [
  { a: laptop, b: phone },
  { a: phone, b: desktop }, // laptop and desktop never talk directly
];

await syncUntilStable(edges); // repeats passes until the mesh stops changing
```

Each pass moves a change one hop, so a change on `laptop` reaches `desktop` on the second pass.

## Adapters

| Adapter | Import | Notes |
| --- | --- | --- |
| `OPFSAdapter` | `@cloudauthn/vfs-sync` | Origin Private File System. No prompts, permission never expires — the right home for a background sync loop. |
| `FSAAdapter` | `@cloudauthn/vfs-sync` | A real folder via `showDirectoryPicker()`. Permission is revocable; see below. |
| `NodeFsAdapter` | `@cloudauthn/vfs-sync/node` | A directory on disk. For CLIs and server-side peers. |
| `MemoryAdapter` | `@cloudauthn/vfs-sync` | In-memory. Tests, demos, and a scratch peer. |

Writing your own is six methods:

```ts
interface VFSAdapter {
  readonly name: string;
  list(path: string): Promise<VFSListEntry[]>;   // shallow listing
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<VFSStat | null>;   // { kind, size, mtime }
  fileId?(path: string): Promise<string | null>; // backends with native ids
}
```

`rename` is a first-class operation rather than write-plus-delete: it is what lets a move travel
as a move instead of as a delete and a re-upload.

### File System Access API permissions

FSA handles lose permission across reloads, and re-requesting needs a user gesture. Check before
a sync run:

```ts
if (!(await adapter.ensurePermission())) {
  // prompt the user to re-grant, from a click handler — not from a timer
}
```

## How it works

Each synced folder carries a `.vfs/` control directory, the way a repo carries `.git`:

```
.vfs/
  config.json                  # this node's id, HEAD, peer bookkeeping
  objects/<hash[0:2]>/<hash>   # blobs and trees, content-addressed (SHA-256)
  commits/<hash>.json          # { tree, parents[], timestamp, peer }
  known-commits.log            # flat index of every commit this node has seen
  hash-cache.json              # local only: { path: { hash, mtime, size, id } }
```

**Change detection.** A scan compares `mtime` + `size` against `hash-cache.json`. Matching files
are not re-read; only the rest are hashed. The cache is local to each peer and never syncs — what
travels between peers are the resolved hashes inside trees.

**Common ancestor.** `known-commits.log` lists every commit a node knows, its own and the ones
learned from peers. Negotiation is then a set intersection (`mine ∩ theirs`, most recent wins)
instead of a walk of the DAG — the same trick as git's commit-graph. It is the only mechanism
used, for peers that have met before and for first encounters alike.

**File identity.** Diffs match on `id`, not on path, so renames survive. Backends with a native
stable id (Google Drive's `fileId`) supply it directly; OPFS, FSA and Node get a synthetic id
assigned at discovery. When two peers discovered the same file independently and have never
synced, their ids disagree — matching falls back to path, and the lexicographically smaller id
wins and becomes canonical from then on.

**Deletes** are explicit tombstones (`hash: null, deleted: true`), kept in history rather than
purged, so a peer that never saw the delete does not conclude the file never existed.

**Renames** are recorded in the tree (`renamedFrom`). Going through `node.rename()` captures the
intent at the moment it happens; a same-hash-different-path heuristic is the safety net for moves
made outside the VFS, such as the user dragging a file in Finder.

## Conflicts

Content and location are resolved independently, so *renamed on one side, edited on the other*
merges cleanly. When both sides really changed the same dimension, **the more recent `mtime`
wins**, and the losing version is kept as a copy rather than silently overwritten — clock skew
between peers is real, and binaries have no line-by-line merge to fall back on.

```
notes.md  ->  notes (conflict device-a b34883c4).md
```

The copy is credited to the peer that actually wrote it, not to the neighbour that relayed it, so
the name stays truthful several hops down a chain. Its path is derived from content, so re-merging
the same pair does not pile up duplicates.

```ts
await sync(a, b, {
  conflictCopies: 'edits',       // 'edits' (default) | 'always' | false
  conflictName: ({ path, peer, hash }) => `${path}.${peer}.${hash.slice(0, 8)}`,
});
```

- `'edits'` — keep a copy when both sides had real content. A winning delete really deletes.
- `'always'` — also keep the content when a delete beats an edit.
- `false` — no copies; the loser is discarded.

Every `sync()` returns what happened:

```ts
const { base, head, changed, conflicts, transferred } = await sync(a, b);
for (const c of conflicts) {
  console.log(c.path, c.kind, c.winner, c.copy?.path);
  //          notes.md 'content' 'b' 'notes (conflict device-a b34883c4).md'
}
```

## API

| Export | What it does |
| --- | --- |
| `VFSNode.open(adapter, opts?)` | Opens a folder as a peer, creating `.vfs/` if needed. |
| `node.scan()` / `node.commit()` | Snapshot the folder / record it. `commit()` returns `null` when nothing changed. |
| `node.read` `.write` `.delete` `.rename` | Working-folder operations. `rename` records intent. |
| `node.head()` / `node.headTree()` / `node.log()` | Current commit, its tree, and history. |
| `sync(a, b, opts?)` | Sync one edge. Both peers end on the same merge commit. |
| `syncMesh(edges, opts?)` | One pass over every edge. |
| `syncUntilStable(edges, opts?)` | Repeat passes until the mesh stops changing. |
| `mergeTrees(base, a, b, opts)` | The three-way merge on its own — pure, no I/O. |
| `walk(adapter, opts?)` | Recursive file listing, `.vfs` excluded. |

`VFSNode.open` takes `{ id, ignore, now }`: a stable peer id (generated and persisted otherwise), a
predicate for paths to keep out of sync entirely, and an injectable clock.

## Demo

```sh
npm run demo         # vite dev server
npm run demo:build   # static build in demo/dist
```

## Status

OPFS, FSA, Node and memory adapters are implemented and tested. A Google Drive adapter is the
planned next backend — `changes.list` + `pageToken` for incremental sync, and its native `fileId`
plugs straight into `fileId()`, so it slots in without touching the engine.

Not yet implemented: garbage collection over `objects/` for blobs and trees no longer reachable
from any commit.

The design this implements is written up in [vfs-sync-design.md](./vfs-sync-design.md) (Spanish).

## License

MIT © Jesús Germade
