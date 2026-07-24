# @cloudauthn/vfs-sync

Multi-peer folder sync for the browser and Node, with a git-shaped core: content-addressed blobs,
tree snapshots, and merge commits.

Any backend syncs with any other — OPFS, a real folder picked through the File System Access API,
a Node directory, or plain memory. Peers form a **mesh, not a hub-and-spoke**: a node knows only
the peers it syncs with directly, and changes travel down a chain because every edge syncs
independently.

**[▶ Live demo](https://cloudauthn.github.io/vfs-sync/)** — a file explorer with one tab per
backend, wired as a chain, with conflicts, renames and deletes you can trigger by hand.
**[Coverage report](https://cloudauthn.github.io/vfs-sync/coverage/)** — both are published from
the tag of the last release.

```sh
npm install @cloudauthn/vfs-sync
```

## Getting started

A node is a folder plus the `.vfs/` control directory it carries, like a git repo. Give it an
adapter and it is ready to sync.

```ts
import { OPFSAdapter, VFSNode, sync } from '@cloudauthn/vfs-sync';

const laptop = await VFSNode.open(await OPFSAdapter.open({ path: 'workspace' }));
const phone = await VFSNode.open(await OPFSAdapter.open({ path: 'backup' }));

await laptop.write('notes.md', new TextEncoder().encode('# Notes'));

const result = await sync(laptop, phone);
// { base: null, head: '4a1c…', changed: true, conflicts: [], transferred: { toA: 0, toB: 1 } }
```

Both folders now hold the same files and point at the same merge commit. `sync` commits both sides
for you.

### Editing and syncing back

```ts
await phone.write('notes.md', new TextEncoder().encode('# Notes\n\nedited on the phone'));
await sync(laptop, phone);

new TextDecoder().decode(await laptop.read('notes.md'));
// '# Notes\n\nedited on the phone'
```

Renames go through the node so they travel as renames — keeping the file's identity, and
transferring no content:

```ts
await laptop.rename('notes.md', 'archive/notes.md');
await sync(laptop, phone);
// phone now has archive/notes.md, and no copy was re-sent
```

### When both sides changed

The newer edit wins, and the other is kept beside it rather than being overwritten:

```ts
const encode = (text: string) => new TextEncoder().encode(text);

await laptop.write('notes.md', encode('written on the laptop'));
await phone.write('notes.md', encode('written on the phone'));

const { conflicts } = await sync(laptop, phone);

conflicts[0].kind;        // 'content'
conflicts[0].copy?.path;  // 'notes (conflict device-a b34883c4).md'
```

Both peers end up with the same two files. Nothing is lost silently, and nothing needs a server to
adjudicate. See [conflicts.md](./docs/conflicts.md) for the full rules and how to change them.

### Chains and meshes

`sync` handles one edge. Declare the edges you have, and changes find their way across:

```ts
import { syncUntilStable } from '@cloudauthn/vfs-sync';

const edges = [
  { a: laptop, b: phone },
  { a: phone, b: desktop }, // laptop and desktop never talk directly
];

await syncUntilStable(edges); // repeats passes until the mesh settles
```

Each pass moves a change one hop, so an edit on `laptop` reaches `desktop` on the second pass.

### Picking a backend

```ts
import { FSAAdapter, MemoryAdapter, OPFSAdapter } from '@cloudauthn/vfs-sync';
import { NodeFsAdapter } from '@cloudauthn/vfs-sync/node';

await OPFSAdapter.open({ path: 'workspace' }); // browser, private, no prompts
await FSAAdapter.pick();                       // browser, a real folder the user picks
await NodeFsAdapter.open('./workspace');       // Node, a directory on disk
new MemoryAdapter('scratch');                  // anywhere, nothing persists
```

`FSAAdapter.pick()` must be called from a user gesture, and its permission does not survive a
reload — [adapters.md](./docs/adapters.md#permissions-expire) covers how to handle that.

### Large files and partial reads

Content is bytes throughout — `Uint8Array` in, `Uint8Array` out — so text and binary are the same
thing to the engine. Beyond `read`/`write` there are streams and ranges:

```ts
// a few hundred bytes off the front of a file of any size
const header = await node.readRange('track.mp3', { end: 10 });

// and the last 128, for an ID3v1 trailer
const { size } = (await node.stat('track.mp3'))!;
const trailer = await node.readRange('track.mp3', { start: size - 128 });

// never holds the file
await (await node.readStream('movie.mkv')).pipeTo(await node.writeStream('copy.mkv'));
```

Blobs from 4 MiB up are hashed, stored and synced as streams rather than buffered, so peak memory
is a chunk rather than a file. Adapters that cannot seek get both emulated on top of `read`/`write`
— always correct, just not always cheap. [recipes.md](./docs/recipes.md#large-files) has the
threshold knob and the two caveats.

## Documentation

| | |
| --- | --- |
| [**Adapters**](./docs/adapters.md) | Every backend, its options and quirks, and how to write your own. |
| [**Architecture**](./docs/architecture.md) | The `.vfs` folder, change detection, file identity, and the sync algorithm. |
| [**Conflicts**](./docs/conflicts.md) | Resolution rules, conflict copies, policies, and custom merging. |
| [**API reference**](./docs/api.md) | Every export, with examples. |
| [**Recipes**](./docs/recipes.md) | Background loops, topologies, large files, partial reads, progress, history, testing, CLI. |
| [**Design notes**](./docs/design.md) | The original design this implements (Spanish). |

## Demo

```sh
npm run demo         # vite dev server
npm run demo:build   # static build in demo/dist
npm run pages:build  # the same build plus the HTML coverage report in demo/dist/coverage
```

A tabbed file explorer: one tab per peer, each on a different backend — two OPFS folders, an
in-memory adapter, and a real local folder you add through the File System Access API. The tabs
are laid out as the chain `opfs-a ⇄ opfs-b ⇄ memory ⇄ local`; the `⇄` handles between them sync
that edge alone. Below the explorer sit a file editor and an activity log. Switching tabs keeps
the open file selected, so the same path can be watched across filesystems. When OPFS is blocked
(private window, sandboxed iframe) every tab falls back to memory.

The published site is refreshed only by a release: `release.yml` bumps the version, publishes to
npm, and then calls `pages.yml` with the new tag.

## Status

OPFS, File System Access, Node fs and memory adapters are implemented and tested — 209 tests, 99%
statement coverage. Every backend runs the same contract suite, streaming methods included.

A Google Drive adapter is the planned next backend: `changes.list` + `pageToken` for incremental
sync, and its native `fileId` plugs straight into the optional `fileId()` method, so it slots in
without touching the engine.

Not implemented: garbage collection over `objects/` for blobs unreachable from any commit, and
delta transfer — streaming bounds memory, not bytes moved, so a blob still travels in full.

## License

MIT © Jesús Germade
