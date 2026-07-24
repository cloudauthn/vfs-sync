# Conflicts

The rule is one sentence: **when the hash confirms the content really differs, the more recent
`mtime` wins, and the loser is kept as a copy rather than silently overwritten.**

Everything below is detail on when that rule applies and how to tune it.

- [Two dimensions](#two-dimensions)
- [What counts as a conflict](#what-counts-as-a-conflict)
- [Conflict copies](#conflict-copies)
- [Delete versus edit](#delete-versus-edit)
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

Each dimension resolves the same way:

| Situation | Outcome |
| --- | --- |
| Neither side changed it | Keep the ancestor's value |
| One side changed it | Take that side |
| Both changed it, to the same value | No conflict — they agree |
| Both changed it, differently | **Conflict.** Newer `mtime` wins |

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

Three kinds are reported:

| `kind` | Meaning |
| --- | --- |
| `'content'` | Both sides changed the bytes, differently. |
| `'location'` | Both sides moved the file, to different paths. |
| `'delete-edit'` | One side deleted it, the other edited it. |

When content and location both diverge, it is reported as `'content'` — the more serious of the
two.

---

## Conflict copies

The losing version is written alongside the winner instead of being discarded:

```
notes.md  ->  notes (conflict device-a b34883c4).md
```

Two properties matter here.

**It names the author, not the messenger.** In a chain `A ↔ B ↔ C`, a conflict between A's and C's
edits is detected on the `B ↔ C` edge, where B is merely relaying A's work. The copy is still
credited to `device-a`, because authorship travels with the tree entry.

**Its name derives from content, not from the clock.** Re-merging the same pair produces the same
path and the same id, so repeated syncs do not pile up `notes (conflict …) (conflict …).md`.

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
copying the file would just duplicate it.

### Naming

```ts
await sync(a, b, {
  conflictName: ({ path, peer, hash, entry }) => {
    const stamp = new Date(entry.mtime).toISOString().slice(0, 10);
    return `${path}.${peer}.${stamp}`;
  },
});
```

| Field | What it is |
| --- | --- |
| `path` | The winning path — where the file ends up. |
| `peer` | Id of the peer that wrote the losing version. |
| `hash` | Full content hash of the losing version. |
| `entry` | The whole losing tree entry, including `mtime` and `size`. |

Keep the result deterministic. A name built from `Date.now()` produces a new copy on every sync.

---

## Delete versus edit

One peer deletes, another edits, both since the common ancestor. There is no answer that is right
in every case, so the timestamp rule applies and the outcome is reported.

```ts
await a.delete('notes.md');           // at 10:05
await b.write('notes.md', edited);    // at 10:03

const { conflicts } = await sync(a, b);
// the delete is newer, so the file goes
// conflicts[0].kind === 'delete-edit'
```

Under the default `'edits'` policy a winning delete really deletes — otherwise deleting a file
that someone else touched would feel broken. If the data matters more than the gesture:

```ts
await sync(a, b, { conflictCopies: 'always' });
// file is deleted, but its content survives as notes (conflict device-b …).md
```

---

## Reading the report

```ts
const { conflicts } = await sync(a, b);

for (const conflict of conflicts) {
  const winner = conflict.winner === 'a' ? conflict.a : conflict.b;
  const loser = conflict.winner === 'a' ? conflict.b : conflict.a;

  console.log(`${conflict.path} (${conflict.kind})`);
  console.log(`  kept:  ${winner.peer} — ${new Date(winner.mtime).toISOString()}`);
  console.log(`  lost:  ${loser.peer} — ${new Date(loser.mtime).toISOString()}`);
  if (conflict.copy) console.log(`  saved: ${conflict.copy.path}`);
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Identity of the file in conflict. |
| `kind` | `'content' \| 'location' \| 'delete-edit'` | What diverged. |
| `path` | `string` | Where the file ended up. |
| `winner` | `'a' \| 'b'` | Which argument to `sync(a, b)` won. |
| `a`, `b` | `TreeEntry` | Both competing versions, with `peer`, `mtime`, `hash`. |
| `copy` | `TreeEntry \| undefined` | The preserved loser, when one was kept. |

Surface conflicts in the UI. Silent resolution is how users lose trust in a sync tool — even when
the resolution was right.

---

## Clock skew

Resolution compares `mtime` across machines, so a peer with a wrong clock can win with an edit
that is genuinely older. This is inherent to timestamp-based resolution, not an implementation
detail that can be fixed.

Mitigations, in order of usefulness:

1. **Keep conflict copies on** (the default). Skew then costs a rename, not data.
2. **Surface conflicts to the user** so a wrong resolution is visible and reversible.
3. **Take a custom resolution path** for files where losing is unacceptable — see below.

Ties, where both sides report exactly the same `mtime`, break on hash. That is arbitrary, but it
is *deterministic*: every peer reaches the same answer without coordinating.

---

## Custom resolution

`mergeTrees` is pure and takes no I/O, so you can run it yourself, adjust the result, and apply it:

```ts
import { mergeTrees } from '@cloudauthn/vfs-sync';

const base = await commonAncestorTree(a, b); // your own bookkeeping
const merged = mergeTrees(base, await a.headTree(), await b.headTree(), {
  peerA: a.id,
  peerB: b.id,
  conflictCopies: 'always',
});

// example: this peer's edits always win for a particular file
for (const entry of merged.tree.entries) {
  if (entry.path !== 'settings.json') continue;
  const mine = (await a.headTree()).entries.find((e) => e.id === entry.id);
  if (mine) Object.assign(entry, mine);
}

await a.applyTree(merged.tree);
```

For a full three-way merge of text — actually merging both edits rather than picking one — resolve
with `conflictCopies: 'always'`, then merge the winner and its conflict copy with a diff3
implementation and write the result back. The engine deliberately does not do this itself: it has
no idea whether your files are text.
