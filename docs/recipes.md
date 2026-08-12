# Recipes

Working examples for the things you actually end up needing.

- [Background sync loop](#background-sync-loop)
- [Sync on change, not on a timer](#sync-on-change-not-on-a-timer)
- [Two tabs, one origin](#two-tabs-one-origin)
- [Backing up OPFS to a real folder](#backing-up-opfs-to-a-real-folder)
- [Topologies](#topologies)
- [Excluding files](#excluding-files)
- [Reading a file header](#reading-a-file-header)
- [Large files](#large-files)
- [Showing progress](#showing-progress)
- [Inspecting history](#inspecting-history)
- [Testing code that syncs](#testing-code-that-syncs)
- [Node CLI](#node-cli)

---

## Background sync loop

The naive version overlaps runs and stampedes on wake from sleep. This one does not:

```ts
import { sync } from '@cloudauthn/vfs-sync';

function startSyncLoop(a: VFSNode, b: VFSNode, intervalMs = 30_000) {
  let running = false;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const result = await sync(a, b);
      if (result.conflicts.length) onConflicts(result.conflicts);
    } catch (error) {
      console.warn('sync failed, will retry', error);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
```

Two details worth keeping: the guard so a slow sync never overlaps the next tick, and scheduling
the next run in `finally` so one failure does not kill the loop.

With an FSA peer, check permission first — it cannot prompt from a timer:

```ts
if (!(await fsaAdapter.hasPermission())) {
  showReconnectPrompt();  // needs a user gesture
  return;
}
await sync(a, b);
```

---

## Sync on change, not on a timer

Polling a quiet folder is wasted work. Sync when something actually happens, with a debounce so a
burst of writes collapses into one run:

```ts
function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

const scheduleSync = debounce(() => void sync(local, remote), 2_000);

async function save(path: string, text: string) {
  await local.write(path, new TextEncoder().encode(text));
  scheduleSync();
}
```

Keep a slow timer as well as a backstop: the other peer's changes will not trigger anything
locally.

---

## Two tabs, one origin

Two tabs on the same origin share one OPFS. They are not separate peers — they are two writers to
one folder. Coordinate with a lock instead of syncing:

```ts
async function withSyncLock<T>(run: () => Promise<T>): Promise<T | undefined> {
  return navigator.locks.request('vfs-sync', { ifAvailable: true }, async (lock) => {
    if (!lock) return undefined; // another tab is on it
    return run();
  });
}

await withSyncLock(() => sync(local, remote));
```

A node memoises `vfs.json`, the active log segment and the rotation snapshot, so if another tab
wrote to the same folder, drop the memo before reading:

```ts
node.store.invalidate();
```

---

## Backing up OPFS to a real folder

The common shape: OPFS is the app's working store, and the user occasionally mirrors it to disk.

```ts
import { FSAAdapter, OPFSAdapter, VFSNode, sync } from '@cloudauthn/vfs-sync';

const workspace = await VFSNode.open(
  await OPFSAdapter.open({ path: 'workspace' }),
  { id: 'app' },
);

backupButton.addEventListener('click', async () => {
  const folder = await FSAAdapter.pick();           // needs the gesture
  if (!(await folder.ensurePermission())) return;

  const backup = await VFSNode.open(folder, { id: 'backup' });
  const { transferred, conflicts } = await sync(workspace, backup);

  status.textContent = conflicts.length
    ? `${conflicts.length} conflict(s) resolved`
    : `copied ${transferred.toB} file(s)`;
});
```

Because it is a real sync and not a copy, edits made in the backup folder come back on the next
run.

---

## Topologies

`sync` handles one edge. The shape of the mesh is just which edges you declare.

**Chain** — each peer talks only to its neighbours:

```ts
const edges = [
  { a: laptop, b: phone },
  { a: phone, b: desktop },
];
await syncUntilStable(edges);
```

**Star** — one hub, several spokes. Every change is two hops from every other:

```ts
const edges = [
  { a: hub, b: laptop },
  { a: hub, b: phone },
  { a: hub, b: tablet },
];
await syncUntilStable(edges);
```

**Full mesh** — every pair, for three or four peers. Converges in one pass, but edge count grows
quadratically:

```ts
const peers = [a, b, c];
const edges = peers.flatMap((x, i) => peers.slice(i + 1).map((y) => ({ a: x, b: y })));
```

You do not have to sync every edge every time. Sync the edges that are reachable right now; the
rest catch up when they come back.

```ts
const reachable = edges.filter(({ a, b }) => isOnline(a) && isOnline(b));
await syncUntilStable(reachable);
```

---

## Excluding files

`ignore` keeps paths out of sync completely — they are not hashed, committed or transferred, and
never appear as deletes on the other side.

It governs what a scan *watches*, not what exists. An already-tracked file that a new rule starts
covering keeps its entry and stays live on every peer: the scan leaves it exactly as it was rather
than reading its absence from the walk as a deletion. That is git's model, where `.gitignore` only
governs the untracked, and it is what makes it safe to distribute a rule to a mesh one peer at a
time — the peers that do not have it yet are the ones that would otherwise delete.

The consequence is that **there is no way to untrack without deleting**. To make a tracked file
disappear from the mesh, delete it deliberately; the rule then keeps it from coming back. Git asks
for the same two steps with `git rm --cached`.

```ts
const ignore = (path: string) =>
  path === 'node_modules' ||      // directories skip the whole subtree
  path.startsWith('.cache') ||
  path.endsWith('.tmp') ||
  path.endsWith('.DS_Store');

const node = await VFSNode.open(adapter, { ignore });
```

Use the same predicate on every peer. Where they differ, the file still arrives on the ignoring peer
and its entry stays live there, but that peer stops watching it: an edit made locally is never
noticed and never travels, so the two sides drift apart without either reporting anything.

### Recovering files a pre-0.2.0 rule deleted

Before 0.2.0 an exclusion rule read as a deletion: the entry became a tombstone and the tombstone
travelled. The peer that *added* the rule kept its bytes — its walk simply stopped visiting the path
— so the file is usually still there, orphaned: present on disk, dead in the mesh. The peers that
did not have the rule yet are the ones that lost it.

That asymmetry is what makes recovery possible, and it is a procedure rather than an API because
nothing distinguishes a tombstone caused by the bug from one somebody meant. Run this on the peer
that has the rule and still has the file:

```ts
// 1. upgrade first, or every step below runs next to the bug that caused this
// 2. reopen without the rule and reconcile: the walk sees the path again, and
//    the old entry is a tombstone, so the file is adopted as a new one
const open = await VFSNode.open(adapter, {});
await open.commit();

// 3. propagate to the peers that lost it
await syncUntilStable(edges);

// 4. put the rule back — it now preserves the entry instead of tombstoning it
const ruled = await VFSNode.open(adapter, { ignore });
await ruled.commit();
```

It costs the file's identity: the recovered entry gets a new `uuid`, the old tombstone stays in the
log as history, and ancestry starts over. Content comes back, provenance does not.

If no peer still has the bytes on disk — the file was deleted on the ignoring peer too, after the
tombstone — it is gone, and the answer is a backup. There is no object store to recover it from.

To read patterns from a file instead:

```ts
async function ignoreFrom(adapter: VFSAdapter): Promise<(path: string) => boolean> {
  const stat = await adapter.stat('.vfsignore');
  if (!stat) return () => false;

  const patterns = new TextDecoder()
    .decode(await adapter.read('.vfsignore'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  return (path) => patterns.some((p) => path === p || path.startsWith(`${p}/`));
}
```

---

## Holding the entry without the bytes

`ignore` is about paths a node does not watch. `materialize` is a different question: the node
watches the path, records the entry, agrees with every peer about its hash — and does not keep the
content on disk. The tree is complete everywhere; the folder is not.

```ts
const phone = await VFSNode.open(adapter, {
  materialize: (entry) => entry.size < 10_000_000,
});
```

The predicate is evaluated by whoever knows the policy, and the engine stores nothing about it — so
nothing about it travels, and no two peers have to agree. It can be anything: a size threshold, a
directory prefix, a set of paths the user has pinned. Change it between two calls if you like.

Entries with no bytes behind them are ordinary in every other respect. They rename, they take
deletions, they show up in `live()`. What tells them apart is `mtime`, which is only ever set from a
real look at the disk:

```ts
import { materialised } from '@cloudauthn/vfs-sync';

const remote = (await node.live()).filter((entry) => !materialised(entry));
```

### Fetching and releasing

```ts
await phone.materialize('albums/master.wav', desktop);   // bring the bytes here
await phone.dematerialize('albums/master.wav', desktop); // give the space back
```

Both take the peer explicitly. For `dematerialize` that peer is not decoration: it has to be able to
serve the content before anything is removed here. Releasing the last copy would leave the entry
live across the mesh with the bytes nowhere, and no node can detect that on its own, because nothing
about materialisation travels. If no peer holds it, what you want is `delete` — that is a real
deletion and it says so with a tombstone.

### Two things that surprise people

**The policy governs what arrives, not what is already here.** Changing it to `false` for a file you
already hold does not free the space; it also does not strand the file at a stale version — bytes on
disk are kept current whatever the policy says. Freeing space is `dematerialize`, always deliberate.

**The policy is the steady state.** `materialize` and `dematerialize` are manual moves against it, so
a policy that still wants a file will fetch it back on the next sync. Unpinning is therefore two
moves, and either alone is incomplete:

```ts
const unpinned = await VFSNode.open(adapter, { materialize: (entry) => pinned.has(entry.path) });
await unpinned.dematerialize('albums/master.wav', desktop);
```

That is also what makes pinning work in the other direction: widen the predicate and the next sync
brings the content down, with no per-file call.

---

## Reading a file header

Metadata usually sits at one end of a file. `readRange` seeks to it, so the cost is the range and
not the file — this reads an ID3v2 header and an ID3v1 trailer out of a track of any size:

```ts
const decoder = new TextDecoder();

async function id3(node: VFSNode, path: string) {
  const stat = await node.stat(path);
  if (!stat) return null;

  // ID3v2: 'ID3', two version bytes, flags, then a syncsafe 28-bit size
  const head = await node.readRange(path, { end: 10 });
  if (decoder.decode(head.subarray(0, 3)) === 'ID3') {
    const size =
      (head[6]! << 21) | (head[7]! << 14) | (head[8]! << 7) | head[9]!;
    return { version: `2.${head[3]}.${head[4]}`, tagBytes: size + 10 };
  }

  // ID3v1: the last 128 bytes, 'TAG' then fixed-width fields
  if (stat.size < 128) return null;
  const tail = await node.readRange(path, { start: stat.size - 128 });
  if (decoder.decode(tail.subarray(0, 3)) !== 'TAG') return null;
  const field = (at: number, len: number) =>
    decoder.decode(tail.subarray(at, at + len)).replace(/\0+$/, '').trim();
  return { version: '1', title: field(3, 30), artist: field(33, 30) };
}
```

The same shape works for anything with a fixed-position header — PNG dimensions from bytes 16-24, a
ZIP's end-of-central-directory from the last 22, a WAV's `fmt ` chunk.

Two things to know. On OPFS, FSA and Node this is a real seek; on a backend without `readRange` it
falls back to reading the file and slicing, so it stays correct but stops being cheap. And a range
read never touches the object store — it reads the working folder, so what you get is what is on
disk now, committed or not.

---

## Large files

Nothing has to be configured: blobs at or above 4 MiB take the streaming path automatically, as
long as both ends can stream. What that changes is peak memory — a 2 GB file moves in 64 KiB chunks
instead of being loaded, hashed and written whole.

Lower the threshold if the device is tight on memory, or raise it if the files are small and the
extra pass costs more than it saves:

```ts
const node = await VFSNode.open(adapter, {
  id: 'device-a',
  streamThreshold: 512 * 1024,   // stream anything from 512 KiB up
});
```

An edge streams a blob only when both peers agree — `Math.min` of the two thresholds, and both
adapters implementing the streaming methods. `MemoryAdapter` reports that it can stream, which is
true in the API sense and irrelevant in the memory sense.

Writing a large file in without buffering it:

```ts
const response = await fetch('https://example.com/movie.mkv');
await response.body!.pipeTo(await node.writeStream('movie.mkv'));
await node.commit();
```

Two caveats worth knowing before you rely on this:

- **Hashing a streamed blob is slower.** `crypto.subtle.digest` cannot be fed incrementally, so
  files above the threshold are hashed by the bundled JS implementation of SHA-256 instead — same
  digest, several times the CPU. Files below it still use the native one-shot digest.
- **Content still moves whole.** Streaming is about memory, not bytes on the wire: a one-byte edit
  to a 2 GB file still transfers 2 GB. Delta transfer is not implemented.

---

## Showing progress

`sync` resolves once, so for per-file feedback wrap the adapter:

```ts
function withProgress(adapter: VFSAdapter, onWrite: (path: string) => void): VFSAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop !== 'write') return Reflect.get(target, prop, receiver);
      return async (path: string, data: Uint8Array) => {
        if (!path.startsWith('.vfs')) onWrite(path);
        return target.write(path, data);
      };
    },
  });
}

const node = await VFSNode.open(
  withProgress(adapter, (path) => (status.textContent = `writing ${path}…`)),
  { id: 'device-a' },
);
```

For a total to count against, scan first:

```ts
const total = (await node.scan()).entries.filter((e) => !e.deleted).length;
```

---

## Inspecting history

There is no repository-level DAG in v2. History is **per file**, and it lives in the merged commit
log: one row per operation, grouped into batches by whatever produced them.

```ts
import { sortRows } from '@cloudauthn/vfs-sync';

for (const row of sortRows(await node.store.logRows()).slice(-20)) {
  console.log(
    row.op.slice(0, 7),
    row.type.padEnd(6),
    row.peerId.padEnd(12),
    new Date(row.at).toISOString(),
    row.path,
  );
}
```

What a specific file has been through — the rows for its `uuid`, newest last:

```ts
async function historyOf(node: VFSNode, path: string) {
  const entry = (await node.live()).find((item) => item.path === path);
  if (!entry) return [];
  const rows = [...(await node.store.logRows()), ...(await node.store.readSnapshot())];
  return sortRows(rows.filter((row) => row.uuid === entry.uuid));
}
```

Rows from before the last rotation are in the closed segments, which are immutable and listed in
`file.log.archives`:

```ts
const file = await node.file();
for (const segment of file.log.archives ?? []) {
  const rows = await node.store.readArchive(segment);   // cached forever once read
  console.log(`segment ${segment}: ${rows.length} row(s)`);
}
```

Old content is **not** recoverable: there is no object store, and the working file is the content.
`.vfs/base/<hash>` keeps the last text versions for three-way merges only — local, pruned, and not
an archive.

---

## Testing code that syncs

`MemoryAdapter` needs no filesystem and no browser, so sync tests run in milliseconds.

```ts
import { MemoryAdapter, VFSNode, sync } from '@cloudauthn/vfs-sync';

async function peer(id: string) {
  const fs = new MemoryAdapter(id);
  return { fs, node: await VFSNode.open(fs, { id }) };
}

// `updated` is a hybrid logical clock stamped when a node *records* a change, so
// ordering two edits means controlling when each one is committed — not the
// adapter's mtime, which only feeds the "did this file change?" fast filter.

it('resolves a conflict in favour of the newer edit', async () => {
  const a = await peer('device-a');
  const b = await peer('device-b');

  await a.node.write('notes.bin', encode('shared'));
  await sync(a.node, b.node);

  await a.node.write('notes.bin', encode('from A'));
  await a.node.commit();                     // A records first, so B's edit is the newer one
  await b.node.write('notes.bin', encode('from B'));

  const { conflicts } = await sync(a.node, b.node);

  expect(conflicts[0].winner).toBe('b');
  expect(a.fs.snapshot()).toEqual(b.fs.snapshot()); // converged
});
```

`snapshot()` returns `{ path: text }` with the control folder excluded, which makes "did both peers
end up the same?" a one-line assertion. `await node.state()` is the same question one level up: two
peers whose live entries agree produce the same digest.

For a real filesystem, `NodeFsAdapter` over a temp directory:

```ts
const dir = await mkdtemp(join(tmpdir(), 'sync-test-'));
const node = await VFSNode.open(await NodeFsAdapter.open(dir, 'disk'));
```

---

## Node CLI

A two-folder sync command:

```ts
#!/usr/bin/env node
import { NodeFsAdapter } from '@cloudauthn/vfs-sync/node';
import { VFSNode, sync } from '@cloudauthn/vfs-sync';

const [, , left, right] = process.argv;
if (!left || !right) {
  console.error('usage: vfs-sync <folder-a> <folder-b>');
  process.exit(1);
}

const a = await VFSNode.open(await NodeFsAdapter.open(left));
const b = await VFSNode.open(await NodeFsAdapter.open(right));
const { changed, conflicts, transferred } = await sync(a, b);

if (!changed) {
  console.log('already in sync');
} else {
  console.log(`synced — ${transferred.toA} in, ${transferred.toB} out`);
  for (const c of conflicts) {
    console.log(`  conflict: ${c.path} (${c.kind}), kept ${c.copy?.path ?? 'nothing'}`);
  }
}
```

Both folders keep their own `.vfs/`, so state survives between runs and the second invocation only
moves what changed.
