# Conflicts

Two sentences. **The bytes always converge**: the more recent `updated` wins, ties break on hash so
both peers decide the same way, and the loser is kept as a copy rather than silently overwritten.
**The decision is what stays pending**, as durable state any peer with a person in front of it can
settle later.

- [Two dimensions](#two-dimensions)
- [What counts as a conflict](#what-counts-as-a-conflict)
- [Text: merged, not parked](#text-merged-not-parked)
- [Conflict copies](#conflict-copies)
- [Delete versus edit](#delete-versus-edit)
- [Pending conflicts](#pending-conflicts)
- [Reading the report](#reading-the-report)
- [Clock skew](#clock-skew)
- [Custom resolution](#custom-resolution)

---

## Two dimensions

A file can change in two independent ways: **content** and **location**. They are resolved
separately, which means the most common "conflict" is not one at all.

```ts
// A renames the file. B edits it. Nobody has to lose anything.
await a.rename('notes.md', 'archive/notes.md');
await b.write('notes.md', encoder.encode('new content'));

const { conflicts } = await sync(a, b);
// conflicts: []
// result:    archive/notes.md, containing B's new content
```

Each dimension resolves the same way, and the question in the last two rows is **ancestry**, not
presence: the loser is behind if its version is reachable by following the winner's `prev` chain
backwards.

| Situation | Outcome |
| --- | --- |
| Neither side changed it | Nothing to do |
| One side is an ancestor of the other | Take the descendant — a propagation, not a conflict |
| Both changed it, to the same value | No conflict — they agree |
| Both changed it, divergently | **Conflict.** Newer `updated` wins |

Two edits of the same parent both "appear" in the log, one before the other. That is the canonical
conflict, not a propagation: neither is an ancestor of the other.

---

## What counts as a conflict

Both sides having *touched* a file is not enough. The engine compares hashes, so saving a file
without changing its bytes, or both peers making the identical edit, produces no conflict:

```ts
await a.write('notes.md', encoder.encode('same edit'));
await b.write('notes.md', encoder.encode('same edit'));

const { conflicts } = await sync(a, b);
// conflicts: []  — the hashes match, so there is nothing to resolve
```

Five kinds are reported:

| `kind` | Meaning |
| --- | --- |
| `'content'` | Both sides changed the bytes, divergently. |
| `'location'` | Both sides moved the file, to different paths. |
| `'delete-edit'` | One side deleted it, the other edited it. |
| `'path-collision'` | Two *different* files ended up wanting the same name. |
| `'kind'` | The same collision with a directory on one side. |

When content and location both diverge, it is reported as `'content'` — the more serious of the two.

**`content` and `path-collision` are not the same question**, which is why they are not the same
word. `content` is two versions of one file, and one is about to overwrite the other. A path
collision is two files — two uuids, two histories — that want one name; nothing is overwritten,
because the loser is renamed aside, so the only question is who keeps the name. The payload's two
`uuid`s are the tell: shared for the first, different for the second.

Two files created independently at the same path are *not* a collision — the merge pairs them by
path as one file discovered twice, and reports `content`.

A `'kind'` conflict is the one v2 introduces, by recording directories. Parking the loser stops
being a local edit: if a directory loses, it is renamed **with every descendant**, in one batch, or
the tree is inconsistent halfway through — which is why its payload carries `subtree`, the number of
entries that would move with it.

---

## Text: merged, not parked

The workload this engine is for splits cleanly: the heavy content is binary and immutable (a ROM, a
`.flac`), and what actually gets edited is small text (`gamelist.xml`, `.nfo`, `.cue`, `.m3u`). So
content conflicts get two policies:

- **binary** — last-writer-wins plus a copy, as above. This includes ID3/Vorbis tags: they are the
  most-edited metadata there is, but they live inside the `.flac`/`.mp3` and are binary.
- **text** — a **three-way merge** is attempted before anything is parked.

```ts
// A edits the first line, B edits the third
const { merged, conflicts } = await sync(a, b);
// merged: 1, conflicts[0].text === true, and neither edit was lost
```

**The classification comes from the `text` list in the header, never from the content.** Both sides
have to classify the same way without talking, and sniffing breaks that: each side inspects *its*
version, which is precisely the one that differs, so the same file can read as text on one peer and
binary on the other. Sniffing is fine for proposing the list when a store is created; in the merge,
an extension off the list is binary. Failing towards binary is failing towards LWW plus a copy —
nothing is lost.

The list converges by union when two peers sync, and starts as:

```
cue  json  log  m3u  md  nfo  srt  txt  xml
```

**Union in one direction only.** Nothing removes an extension once it is on the list, and a peer
arriving with an older list adopts the wider one. One peer adding `json` therefore means every
`.json` in the mesh attempts a merge from then on, on every peer, permanently. That is why there is
no one-line call to widen it.

### Selecting by path

The list can only speak in extensions. To claim paths it cannot name, a node takes a predicate:

```ts
const node = await VFSNode.open(adapter, { text: (path) => path.startsWith('catalog/') });
```

Local, like `materialize`: nothing about it travels and nothing is stored about it. Two properties
it has to have to be worth anything:

- **It is consulted at commit, not only at merge.** A merge needs a base, and the base only exists
  because the version was recorded as text when it was written. This is why the predicate is a node
  option and not a `sync()` one — a predicate that arrived at merge time would classify conflicts it
  could never settle, on exactly the paths it was added for.
- **It adds; it cannot subtract.** `sync()` unions both nodes' answers, so a refusal here is
  overruled by the other side's list. To turn the merge off, that is `autoMerge: false` on the sync
  call: total, and per call.

Because it is a union, only one of the two peers needs to have claimed a path: whichever kept the
base carries the merge for both.

### The base is local and does not travel

A three-way merge needs base + A + B. A and B are free — the working file *is* the content — and the
base comes from `.vfs/base/<hash>`, where a copy of every recorded text version is kept. It never
travels and no peer reads it; retention is bounded and pruned as syncing progresses. If the base is
not there — never written, pruned, or the conflict was detected by a third peer — the merge degrades
to LWW plus a copy, at zero protocol cost.

### Guards

- **1 MB maximum** to even attempt a merge. Above it, LWW, whatever the extension says.
- **Mixed CRLF and LF** between sides degrades to LWW: normalising would change the content, and
  with it the hash.
- **Line-based.** A one-line document merges nothing — two edits to a minified `.json` are two edits
  to the same line, which is a collision by construction. `json` shipping in the default list does
  not change that. Whoever wants a field-level merge serialises one field per line; that is a
  condition of the technique, not a limitation to be lifted later.
- **Never merge markers.** There is no mode that writes `<<<<<<<` into a working file — an emulator
  frontend reads `gamelist.xml` without asking questions, and a marker propagated through the mesh
  is a broken catalogue on every peer. Either the merge comes out clean and is written whole, or it
  is not written.

### Why one did not merge

`text: true` says a merge was worth attempting, not that it happened. When it did not, `textReason`
says why:

```ts
const { merged, conflicts } = await sync(a, b);
for (const report of conflicts) {
  if (report.text && report.textReason) console.log(report.path, report.textReason);
}
```

| `textReason` | Meaning | Does it change on its own? |
| --- | --- | --- |
| `block` | the two sides edited the same lines | yes — it is about these two versions |
| `size` | over 1 MB | no, while the file stays that size |
| `eol` | one side CRLF, the other LF | **no** — it will not merge tomorrow either |
| `no-base` | no ancestor copy was retained here or on the peer | yes, once a version is recorded as text |
| `unreadable` | this peer holds the entry and not the bytes | yes, once the content is fetched |

`eol` is the one worth acting on: a folder written from Windows and from macOS collects a conflict
copy on every single edit and merges nothing, forever. The library will not normalise terminators —
that would change the content, and with it the hash and the identity of the version. Settling on one
terminator is the consumer's to do.

`textReason` is absent when the merge succeeded, when a `resolveText` hook settled it, and when no
attempt was made at all (`autoMerge: false` with no hook).

The merge is computed by **one side only**, the LWW winner. If both ran diff3 independently they
would have to produce the same byte — same algorithm, same line endings, same treatment of a missing
final newline — in two implementations, forever. `sync(a, b)` has both nodes in front of it, so it
is computed once, and the result travels as an ordinary write whose row carries `prev` **and**
`prev2`: the two parents, which is what stops a third peer from reclassifying the merge as a fresh
conflict on every pass.

---

## Conflict copies

The losing version is written alongside the winner instead of being discarded:

```
notes.md  ->  notes (conflict device-a b34883c4).md
```

Three properties matter here.

**It names the author, not the messenger.** In a chain `A ↔ B ↔ C`, a conflict between A's and C's
edits is detected on the `B ↔ C` edge, where B is merely relaying A's work. The copy is still
credited to `device-a`, because authorship travels with the entry.

**Its name derives from content, not from the clock.** Re-merging the same pair produces the same
path and the same uuid, so repeated syncs do not pile up `notes (conflict …) (conflict …).md`.

**Big copies do not travel.** Above a threshold (`heldAt`, 64 MB by default) the copy stays on the
peer that made it: the entry travels with `held: "device-a"` and the bytes do not. Otherwise a
re-dumped 700 MB ROM would be 700 MB on every peer until somebody resolved it.

### Policy

```ts
await sync(a, b, { conflictCopies: 'edits' });
```

| Value | Behaviour |
| --- | --- |
| `'edits'` *(default)* | Keep a copy when both sides had real content. A winning delete really deletes. |
| `'always'` | Also keep the content when a delete beats an edit. Nothing is ever lost. |
| `false` | No copies. The loser is discarded. |

A `'location'` conflict never produces a copy under any policy: only the path was in dispute, so
copying the file would just duplicate it. It is also never a *pending* conflict — the file lands on
one of the two paths and that is that, so asking would be noise.

### Naming

```ts
await sync(a, b, {
  conflictName: ({ path, peer, hash, entry }) => {
    const stamp = new Date(entry.updated).toISOString().slice(0, 10);
    return `${path}.${peer}.${stamp}`;
  },
});
```

| Field | What it is |
| --- | --- |
| `path` | The winning path — where the file ends up. |
| `peer` | Id of the peer that wrote the losing version. |
| `hash` | Full content hash of the losing version. |
| `entry` | The whole losing entry, including `updated` and `size`. |

Keep the result deterministic. A name built from `Date.now()` produces a new copy on every sync.

---

## Delete versus edit

One peer deletes, another edits, neither descending from the other. There is no answer that is right
in every case, so the timestamp rule applies and the outcome is reported.

```ts
await a.delete('notes.md');           // recorded later
await b.write('notes.md', edited);    // recorded earlier

const { conflicts } = await sync(a, b);
// the delete is newer, so the file goes
// conflicts[0].kind === 'delete-edit'
```

Under the default `'edits'` policy a winning delete really deletes — otherwise deleting a file that
someone else touched would feel broken. If the data matters more than the gesture:

```ts
await sync(a, b, { conflictCopies: 'always' });
// file is deleted, but its content survives as notes (conflict device-b …).md
```

---

## Deciding, before anything is written

**A pass writes nothing while a conflict is waiting for a person.** Not the disputed file, and not
the nine hundred files travelling alongside it that have nothing to do with the dispute. The plan is
complete before the first byte, so stopping costs two scans and leaves both folders exactly as they
were.

There are two ways to answer, and they exist for two different UIs.

**In the moment**, one pass, for a UI that is in front of the user:

```ts
await sync(laptop, phone, {
  decide: async (conflict) => await askTheUser(conflict),  // or null to abort the pass
});
```

**After a round trip**, for a UI that goes away and comes back — and this is also what happens when
you supply no way to answer at all: the pass throws with everything it stopped for.

```ts
try {
  await sync(laptop, phone);
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  const answers = await askTheUser(error.conflicts);
  await sync(laptop, phone, { decisions: answers });
}
```

It throws rather than returning quietly because a list in a returned result can be ignored by
accident, and a pass that stopped for a conflict then looks exactly like a pass that had nothing to
do. Being asked and answering `{ action: 'abort' }` is different: that returns, with
`applied: false`. A person cancelling a dialog is an outcome, not a failure.

An answer names the conflict by `id` and says what happens:

```ts
{ id, action: 'keep', side: 'a' }              // that version survives
{ id, action: 'keep-both' }                    // winner in place, loser parked beside it
{ id, action: 'replace', content: bytes }      // neither; content the caller composed
```

- **`side`** names the side that **stays as it is**; the other yields. `'a'` and `'b'` mean the
  payload's own `ctxA`/`ctxB` — not the arguments of `sync(a, b)`, which a path collision has nothing
  to do with.
- **`keep-both`** is the answer for "these are two different files" and equally for "not now": what
  it leaves behind is a [pending conflict](#pending-conflicts) to resolve later.
- A decision may carry the two hashes it was made about (`a`, `b`). Worth the two lines: an answer to
  a dispute that **moved on** while the user was looking at it is then ignored and asked again,
  rather than applied to a version they never saw.

An incomplete set is ordinary — the user answers two of five and gets on with their day. What is left
still stops the pass, because half a decision is not a decision.

The full catalogue — every case the engine can stop for, the data each one carries, and the answers
that are legal for it — is [`conflicts.yaml`](./conflicts.yaml), and it is the contract this is built
against.

### What counts as needing a person

`conflicts` is everything that diverged. `pending` is the subset nobody but a person can settle:

| | In `pending`? |
| --- | --- |
| a text conflict the three-way merge settled | no — it is resolved; the report survives so you can see it happened |
| `location`, the same file renamed differently on each side | no — one path wins deterministically and no content is at risk |
| `content`, two different versions | **yes** |
| `delete-edit`, one deleted and one edited | **yes** |
| `kind`, a file against a directory | **yes** |

### The consequence, stated plainly

An edge with nobody on it does not get past a conflict. A phone syncing at 4am reports the same
pending decision every night, and the unrelated files wait with it, until something answers. That is
the deliberate trade: the folder a person is looking at never changes under them without an answer.

---

## Pending conflicts

A conflict answered with `'both'` leaves a durable record. That record is not a new kind of thing —
**it is the conflict copy**, a real entry with a real path that converges through the mesh on its
own. Three fields formalise it:

```jsonc
{
  "uuid": "c0n1…",
  "path": "gamelist (conflict device-b 1f4a9c2e).xml",
  "conflictOf": "b7c1…",   // the entry in dispute
  "reason": "block",       // why it did not settle itself
  "base": "0a11b2…"        // ancestor hash, when whoever detected it had one
}
```

So "are there pending conflicts?" is "any entry with `conflictOf`?", asked of the file that is read
anyway:

```ts
const pending = await node.conflicts();   // reads vfs.json; no network, no sync

for (const item of pending) {
  console.log(`${item.path} — ${item.reason}, ${item.peerId}'s version is at ${item.copyPath}`);
}
```

| `reason` | What happened | What a UI should offer |
| --- | --- | --- |
| `binary` | Two edits of unmergeable content | keep mine / keep theirs |
| `block` | Text whose edits overlap | a merge view, manual editing |
| `delete-edit` | One deleted, the other edited | recover / confirm the delete |
| `kind` | A file against a directory on one path | choose who keeps the path |

**Resolving is writing the winner and deleting the copy** — two operations the engine already knows
how to do, in one batch:

```ts
await node.resolve(item.uuid, 'mine');    // keep what is at item.path
await node.resolve(item.uuid, 'theirs');  // promote the copy
await node.resolve(item.uuid, bytes);     // or write something else entirely
```

So a resolution propagates like any write, and two people resolving on different peers at once is an
ordinary write conflict decided by the ordinary rules. There is no state machine.

`node.resolve()` is the *after the fact* path, for a copy that already exists on disk — deciding
before anything is written is [`decisions`](#deciding-before-anything-is-written), and it is the one
to reach for first: nothing is parked, nothing is named `(conflict …)`, and the user never sees a
file appear that they did not ask for.

An interactive path exists for the moment the merge happens, too:

```ts
await sync(a, b, {
  resolveText: async ({ path, base, a: mine, b: theirs }) => {
    return await askTheUser(path, base, mine, theirs); // or null for the headless path
  },
});
```

If the hook is absent or returns `null`, the usual thing happens: LWW, a copy, and a pending
decision.

---

## Reading the report

`ConflictReport` is the immediate result of a `sync()`; the durable state is behind it.

```ts
const { conflicts, merged } = await sync(a, b);

for (const conflict of conflicts) {
  const winner = conflict.winner === 'a' ? conflict.a : conflict.b;
  const loser = conflict.winner === 'a' ? conflict.b : conflict.a;

  console.log(`${conflict.path} (${conflict.kind})`);
  console.log(`  kept:  ${winner?.peerId} — ${new Date(winner!.updated).toISOString()}`);
  console.log(`  lost:  ${loser?.peerId} — ${new Date(loser!.updated).toISOString()}`);
  if (conflict.copy) console.log(`  saved: ${conflict.copy.path}`);
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `uuid` | `string` | Identity of the file in conflict. |
| `kind` | `'content' \| 'location' \| 'delete-edit' \| 'kind'` | What diverged. |
| `path` | `string` | Where the file ended up. |
| `winner` | `'a' \| 'b'` | Which argument to `sync(a, b)` won. |
| `a`, `b` | `VFSEntry \| undefined` | Both competing versions, with `peer`, `updated`, `hash`. |
| `copy` | `VFSEntry \| undefined` | The preserved loser, when one was kept. |
| `base` | `Hash \| undefined` | The ancestor, when the chain turned one up. |
| `text` | `true \| undefined` | Both sides were text, so a three-way merge was worth trying. |
| `textReason` | `TextMergeReason \| undefined` | Why the attempt did not settle it. See [why one did not merge](#why-one-did-not-merge). |

Surface conflicts in the UI. Silent resolution is how users lose trust in a sync tool — even when
the resolution was right.

---

## Clock skew

Resolution compares `updated` across machines. The hybrid logical clock —
`updated = max(now, highest seen + 1)` — removes most of the exposure: once two peers have met, their
logical dates are ordered against each other and a lagging clock cannot "lose against the past".

What is left is one gap: writes made offline with a clock running fast, before the sync that would
have corrected it. There, an invented `updated: 150` still beats a real delete at t=100 and the file
comes back. It fails towards keeping data rather than losing it.

Mitigations, in order of usefulness:

1. **Keep conflict copies on** (the default). Skew then costs a rename, not data.
2. **Surface conflicts to the user** so a wrong resolution is visible and reversible.
3. **Take a custom resolution path** for files where losing is unacceptable — see below.

Ties, where both sides report exactly the same `updated`, break on hash and then on peer. That is
arbitrary, but it is *deterministic*: every peer reaches the same answer without coordinating.

---

## Custom resolution

`mergeEntries` is pure and does no I/O, so you can run it yourself, adjust the result, and apply it:

```ts
import { History, mergeEntries } from '@cloudauthn/vfs-sync';

const history = await a.history();       // entries + active log segment + snapshot
const result = mergeEntries(
  { peer: a.id, entries: await a.entries() },
  { peer: b.id, entries: await b.entries() },
  { history, conflictCopies: 'always' },
);

// example: this peer's edits always win for a particular file
const mine = await a.entries();
for (const entry of result.entries) {
  if (entry.path !== 'settings.json') continue;
  const held = mine.find((item) => item.uuid === entry.uuid);
  if (held) Object.assign(entry, held);
}

await a.apply(result.entries, source);   // `source` supplies content A does not have
await a.store.write(await a.adopt(result.entries));
```

`diff3` is exported too, if you want to run the text merge somewhere else:

```ts
import { diff3 } from '@cloudauthn/vfs-sync';

const result = diff3(baseText, mineText, theirsText);
if (result.ok) await node.write('gamelist.xml', encoder.encode(result.text));
// result.reason is 'block' | 'size' | 'eol' when it declines
```
