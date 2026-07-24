# @cloudauthn/vfs-sync

Multi-peer folder sync for the browser and Node, with a git-shaped core: content-addressed blobs,
tree snapshots, and merge commits.

Any backend syncs with any other — OPFS, a real folder picked through the File System Access API,
a Node directory, or plain memory. Peers form a **mesh, not a hub-and-spoke**: a node knows only
the peers it syncs with directly, and changes travel down a chain because every edge syncs
independently.

**[▶ Live demo](https://cloudauthn.github.io/vfs-sync/)** — three OPFS peers wired as a chain,
with conflicts, renames and deletes you can trigger by hand.
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

## Documentation

| | |
| --- | --- |
| [**Adapters**](./docs/adapters.md) | Every backend, its options and quirks, and how to write your own. |
| [**Architecture**](./docs/architecture.md) | The `.vfs` folder, change detection, file identity, and the sync algorithm. |
| [**Conflicts**](./docs/conflicts.md) | Resolution rules, conflict copies, policies, and custom merging. |
| [**API reference**](./docs/api.md) | Every export, with examples. |
| [**Recipes**](./docs/recipes.md) | Background loops, topologies, progress, history, testing, CLI. |
| [**Design notes**](./docs/design.md) | The original design this implements (Spanish). |

## Demo

```sh
npm run demo         # vite dev server
npm run demo:build   # static build in demo/dist
npm run pages:build  # the same build plus the HTML coverage report in demo/dist/coverage
```

Three OPFS peers wired `A ↔ B ↔ C`, with per-edge sync buttons, a file editor, an activity log,
and an optional fourth peer backed by a real local folder.

The published site is refreshed only by a release: `release.yml` bumps the version, publishes to
npm, and then calls `pages.yml` with the new tag.

## Status

OPFS, File System Access, Node fs and memory adapters are implemented and tested — 161 tests, 99%
statement coverage.

A Google Drive adapter is the planned next backend: `changes.list` + `pageToken` for incremental
sync, and its native `fileId` plugs straight into the optional `fileId()` method, so it slots in
without touching the engine.

Not implemented: garbage collection over `objects/` for blobs unreachable from any commit, and
delta transfer — blobs move whole.

## License

MIT © Jesús Germade
