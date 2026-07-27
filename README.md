# @cloudauthn/vfs-sync

Multi-peer folder sync for the browser and Node. The working folder *is* the content, `.vfs/` holds
only metadata, and the whole state of a folder is one file a peer reads in one request.

Any backend syncs with any other — OPFS, a real folder picked through the File System Access API,
Google Drive (client-side, no server of your own), a Node directory, or plain memory. Peers form a
**mesh, not a hub-and-spoke**: a node knows only
the peers it syncs with directly, and changes travel down a chain because every edge syncs
independently.

**[▶ Live demo](https://cloudauthn.github.io/vfs-sync/)** — three peers wired as a chain, with
conflicts, renames and deletes you can trigger by hand.
**[File explorer](https://cloudauthn.github.io/vfs-sync/explorer/)** — an embeddable app with one
tab per backend, mounted into a page of the demo.
**[Coverage report](https://cloudauthn.github.io/vfs-sync/coverage/)** — all three are published
from the tag of the last release.

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
// { changed: true, conflicts: [], transferred: { toA: 0, toB: 1 }, merged: 0, state: '4a28fc…' }
```

Both folders now hold the same files and the same `state` digest. `sync` reconciles both sides for
you, and that digest is what makes a quiet sync quiet: one comparison decides there is nothing to
transfer, nothing to merge and nothing to append.

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

await laptop.write('cover.jpg', encode('taken on the laptop'));
await phone.write('cover.jpg', encode('taken on the phone'));

const { conflicts } = await sync(laptop, phone);

conflicts[0].kind;        // 'content'
conflicts[0].copy?.path;  // 'cover (conflict device-a b34883c4).jpg'
```

Both peers end up with the same two files. Nothing is lost silently, and nothing needs a server to
adjudicate.

Text is different: for extensions on the store's `text` list (`xml`, `nfo`, `m3u`, `cue`, `md`, …)
a **three-way merge** is attempted first, so two people editing different parts of the same
`gamelist.xml` both keep their edits and there is no copy at all.

What cannot be settled automatically becomes a **pending decision**, not a stalled sync — the bytes
always converge, and the conflict copy *is* the durable record of what is still undecided:

```ts
const pending = await laptop.conflicts();          // reads vfs.json; no network
await laptop.resolve(pending[0].uuid, 'theirs');   // one write and one delete, in a batch
```

See [conflicts.md](./docs/conflicts.md) for the full rules and how to change them.

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

Files from 4 MiB up are hashed and synced as streams rather than buffered, so peak memory is a chunk
rather than a file, and everything that arrives is re-hashed against what the sender declared — a
truncated transfer cannot land as "the newest version". Adapters that cannot seek get streams and
ranges emulated on top of `read`/`write` — always correct, just not always cheap.
[recipes.md](./docs/recipes.md#large-files) has the threshold knob and the two caveats.

## Documentation

| | |
| --- | --- |
| [**Adapters**](./docs/adapters.md) | Every backend, its options and quirks, and how to write your own. |
| [**Architecture**](./docs/architecture.md) | `vfs.json`, the commit log, change detection, file identity, and the sync algorithm. |
| [**Conflicts**](./docs/conflicts.md) | Resolution rules, conflict copies, policies, and custom merging. |
| [**API reference**](./docs/api.md) | Every export, with examples. |
| [**Recipes**](./docs/recipes.md) | Background loops, topologies, large files, partial reads, progress, history, testing, CLI. |
| [**Design v2**](./docs/design-v2.md) | The design this implements: a two-file `.vfs`, sync by metadata, no blob store (Spanish). |
| [**Design v1**](./docs/design.md) | Its predecessor, kept for context (Spanish). |

## Demo

```sh
npm run demo         # vite dev server
npm run demo:build   # static build in demo/dist
npm run pages:build  # the same build plus the HTML coverage report in demo/dist/coverage
```

Three peers wired `A ↔ B ↔ C`, with per-edge sync buttons, a file editor, an activity log, and an
optional fourth peer backed by a real local folder. Its `/explorer/` page embeds the app below.

The published site is refreshed only by a release: `release.yml` bumps the version, publishes to
npm, and then deploys the site from the tag it just pushed.

## File explorer

An app of its own, in [`explorer/`](./explorer), built on the same library:

```sh
npm run explorer        # vite dev server, the app on its own page
npm run explorer:build  # static build in explorer/dist, ready to serve or iframe
```

It looks like an OS file manager and starts on a **new tab**: the left column browses the origin's
OPFS — folders that already hold a `.vfs` store carry a *vfs* chip and open straight into a tab,
plain folders expand (an *Open* action initialises them as roots), and folders can be created and
deleted in place. The right column offers the other backends: a fresh **MemFS**, or a real folder
from disk through the File System Access API.

Each opened root is a closable tab. Under the tabs sit two columns: the file tree on the left, and
a details pane on the right showing size, mime type, SHA-256 checksum, tracking state (recorded /
modified / untracked, entry uuid, previous version, last editor) and how the same path stands on
every other root — plus an inline editor for text files. The root view lists **pending conflicts**
with a button per side, so a decision can be settled without syncing anything.

The tree is painted from `vfs.json`, so opening a root costs one read rather than a listing per
folder — and because that is a mirror of what the engine wrote rather than of the disk, the pane
says when it was last verified. Under the working tree sits `.vfs` itself, dimmed, folded and
read-only: two files on the normal path, plus the rotated segments and their snapshots. Nothing in
there is editable — the engine is its only writer. The footer is a status bar — state digest, last
sync — with a target selector and a **Sync** button: pick another root to sync the open one against,
or *All roots* to run the whole chain until it converges. Switching roots keeps the open file
selected, so the same path can be compared across filesystems.

Browsing is built to be cheap on a backend where every call is a request. Folder listings and their
`.vfs` probes are cached together — and a probe is a *range read of the header*, so it stays a few
hundred bytes however large the tree is. A file's size and time come from the listing that named it,
and a file read is remembered under its mtime and size, so reselecting it, or comparing it against
another root, costs nothing. On Drive the caches live as long as the access token that filled them;
the ↻ button re-reads whatever is on screen straight from the backend.

It draws itself into an element you give it, carries scoped styles, and reads nothing from the
host page — the demo's `/explorer/` page is one `<main>` and one call:

```ts
import { mountExplorer } from './explorer/src/index';

const explorer = mountExplorer('#explorer', {
  opfsRoot: '', // OPFS subfolder the browser starts at; '' is the origin root
  seed: { 'notes.md': '# Notes\n' }, // written to the first root you open when it is brand new
  autoSyncMs: 3000,
  localFolder: true, // offer the "pick a folder from your system" card
  toolbar: true, // draw the footer's sync controls (target, sync, auto-sync)
  activityLog: true, // offer the activity drawer the status bar opens
  onLog: (message, kind) => console.log(kind, message),
});

await explorer.syncTarget(); // the open root against the footer's target
await explorer.syncAll(); // every edge, until the chain converges
explorer.destroy();
```

## Status

OPFS, File System Access, Google Drive, Node fs and memory adapters are implemented and tested.
Every backend runs the same contract suite, streaming methods included. The Drive adapter runs
entirely client-side — its native `fileId` plugs straight into the optional `fileId()` method, so
renames and moves are tracked with certainty and the engine stays untouched. See
[docs/adapters.md](docs/adapters.md#gdriveadapter) for the token setup (Google Identity Services,
no backend).

Not implemented: historical content (there is no object store, so a previous version cannot be
recovered), deduplication between identical files, resumable/streaming uploads to Drive (uploads
buffer whole), and delta transfer — streaming bounds memory, not bytes moved, so a file still
travels in full.

## License

MIT © Jesús Germade
