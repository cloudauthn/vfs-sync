import { ExplorerModel } from '../explorer/src/model';
import type { BrowseSource, DecidableConflict, ExplorerOptions, Peer } from '../explorer/src/model';
import { MemoryAdapter } from '../src/adapters/memory.js';
import { ScopedAdapter } from '../src/adapters/scoped.js';
import { CURRENT_VERSION } from '../src/vfs-file.js';
import { VFSNode } from '../src/vfs-node.js';
import { sync } from '../src/index.js';
import type { ConflictAction } from '../src/index';
import { counting } from './helpers.js';
import type { Calls } from './helpers.js';

/**
 * The explorer, driven headlessly.
 *
 * The model needs no DOM: it is plain TypeScript over adapters, its `sources`
 * are plain data, and a subscriber standing in for a user is exactly what the
 * components are. What lives here is the setup every explorer test needs — two
 * roots that agree, a way to make them disagree, and a stand-in for the person
 * at the dialog — so that the answering boilerplate is written once. Four
 * copies of a re-entrancy guard is how one of them ends up subtly different and
 * green for the wrong reason.
 */

export const encoder = new TextEncoder();

/**
 * N vFS roots on MemFS, agreeing on one file. Chained left ⇄ right ⇄ …
 *
 * The file is written to the **first** root only and reaches the others by
 * syncing, which is both how a person gets a second device in step and the only
 * way to start from one identity. Writing it into each folder first mints one
 * uuid per root, and three peers reconciling three independently-created files
 * on one path can end up asking which of two identical files keeps the name —
 * see §9 of `SESSIONS/2026-08-14_12h49.explorer-sync-surface.session.md`.
 */
export async function roots(
  names: string[],
  options: ExplorerOptions = {},
): Promise<ExplorerModel> {
  const model = new ExplorerModel({ seed: null, localFolder: false, ...options });
  await model.boot();
  const mem = model.sources.find((source) => source.key === 'mem');
  if (!mem?.adapter) throw new Error('no memory source');
  await mem.adapter.write(`${names[0] as string}/notes.txt`, encoder.encode('shared\n'));
  for (const name of names) await model.openVfsTab(mem, name, true);
  const unexpected = refusingToAnswer(model, 'setup');
  try {
    await model.syncAll();
  } finally {
    unexpected();
  }
  return model;
}

/**
 * Nobody at the dialog, loudly.
 *
 * A pass that opens one with no subscriber to answer does not fail — it waits
 * forever, and a test that hung looks like a test that is slow. Anywhere the
 * expectation is "this cannot need a person", say so and get a message naming
 * what was asked.
 */
export function refusingToAnswer(model: ExplorerModel, what: string): () => void {
  return model.subscribe(() => {
    if (!model.dialog) return;
    const rows = model.dialog.conflicts?.map((row) => asked(row));
    throw new Error(`${what} asked a question: ${model.dialog.kind} ${JSON.stringify(rows ?? [])}`);
  });
}

export interface Browsing {
  model: ExplorerModel;
  source: BrowseSource;
  calls: Calls;
  /** The filesystem under the counted adapter — what actually holds the bytes. */
  base: MemoryAdapter;
}

/**
 * A booted model browsing one counted filesystem that already holds two vFS
 * roots. `sources` is public and its entries are plain data, so a test can hand
 * the model a filesystem of its own without a browser API in sight.
 *
 * `roots` names the folders to lay down; the default two are what the caching
 * tests were written against. Names that share a prefix (`one`, `one-b`) are how
 * the lifecycle tests check that a delete takes the subtree and not the sibling.
 */
export async function browsing(roots = ['one', 'two']): Promise<Browsing> {
  const base = new MemoryAdapter('base');
  for (const root of roots) {
    await base.write(`${root}/notes.md`, encoder.encode(`# ${root}\n`));
    await VFSNode.open(new ScopedAdapter(base, root), { id: root });
  }
  const { adapter, calls } = counting(base);
  const model = new ExplorerModel({ seed: null, localFolder: false });
  await model.boot();
  const source: BrowseSource = {
    key: 'test',
    label: 'Counted',
    icon: '🧪',
    backend: 'memory',
    adapter,
    expanded: new Set(),
  };
  model.sources.push(source);
  model.activeSource = source.key;
  await model.activateNewTab();
  calls.reset();
  return { model, source, calls, base };
}

/** Two vFS roots on MemFS, already agreeing on one file. */
export function twoRoots(options: ExplorerOptions = {}): Promise<ExplorerModel> {
  return roots(['left', 'right'], options);
}

/** The three ways the pairing guard refuses to merge two folders at all. */
export type PairingRefusal = 'foreign-mesh' | 'peer-collision' | 'version-unreconcilable';

/**
 * Two folders the pairing guard will refuse, opened as tabs.
 *
 * Everything the refusal needs is set up **through the engine, before the tabs
 * exist**. Two reasons: `syncAll` would have to be steered edge by edge to
 * establish two separate groups inside one model, and a fixture that did that
 * would be testing the edge chain rather than the dialog. The model's own wiring
 * is what makes two tabs enough — edges are consecutive pairs, so two peers are
 * exactly one edge and one pass asks exactly one question.
 *
 * A peer's id is its folder's basename, so `one/twin` and `two/twin` open as two
 * peers that both claim `twin` — which is what a copied `.vfs` looks like from
 * here.
 */
export async function strangers(reason: PairingRefusal): Promise<ExplorerModel> {
  const model = new ExplorerModel({ seed: null, localFolder: false });
  await model.boot();
  const mem = model.sources.find((source) => source.key === 'mem');
  if (!mem?.adapter) throw new Error('no memory source');
  const fs = mem.adapter;

  /**
   * A vFS root of its own at `path`, holding `files` files.
   *
   * The names carry the root's path so that two folders never hold one name:
   * whatever the person answers here, the merge that follows it has to be a
   * clean union, or the test would be answering a second question it did not
   * set up.
   */
  const lay = async (path: string, files: number): Promise<VFSNode> => {
    const label = path.slice(path.lastIndexOf('/') + 1);
    const node = await VFSNode.open(new ScopedAdapter(fs, path, label), { id: label });
    for (let i = 0; i < files; i++) {
      await node.write(`${path.replace(/\//g, '-')}-${i}.txt`, encoder.encode(`${path} ${i}\n`));
    }
    await node.commit();
    return node;
  };

  const paths: [string, string] =
    reason === 'peer-collision' ? ['one/twin', 'two/twin'] : ['left', 'right'];

  if (reason === 'foreign-mesh') {
    // Each root joins a group of its own, with a partner that lives in another
    // filesystem and is never opened as a tab: two established groups is what
    // `foreign-mesh` *is*, and one of them has to come from outside.
    for (const [index, path] of paths.entries()) {
      const node = await lay(path, index + 1);
      const mate = await VFSNode.open(new MemoryAdapter(`${path}-mate`), { id: `${path}-mate` });
      await sync(node, mate);
    }
  } else {
    await lay(paths[0], 1);
    await lay(paths[1], 2);
  }

  if (reason === 'version-unreconcilable') {
    // A folder written by a build one format ahead of this one. Bumping the
    // version on a store this engine just wrote keeps every other field honest,
    // which a hand-built file would not.
    const scoped = new ScopedAdapter(fs, paths[1], 'right');
    const raw = JSON.parse(new TextDecoder().decode(await scoped.read('.vfs/vfs.json'))) as {
      version: number;
    };
    raw.version = CURRENT_VERSION + 1;
    await scoped.write('.vfs/vfs.json', encoder.encode(JSON.stringify(raw)));
  }

  for (const path of paths) await model.openVfsTab(mem, path);
  if (model.peers.length !== 2) throw new Error(`expected two tabs, got ${model.peers.length}`);
  return model;
}

/** Both roots edit the same file, so the next pass has to stop. */
export async function disagree(model: ExplorerModel, path = 'notes.txt'): Promise<void> {
  const [left, right] = model.peers;
  if (!left || !right) throw new Error('expected two peers');
  await write(left, path, 'from the left\n');
  await write(right, path, 'from the right\n');
}

/** An edit committed straight through the node, as an outside editor would. */
export async function write(peer: Peer, path: string, text: string): Promise<void> {
  await peer.node.write(path, encoder.encode(text));
  await peer.node.commit();
}

/** The live paths of a root, sorted — what a person would see in the tree. */
export async function live(peer: Peer): Promise<string[]> {
  return (await peer.node.live()).map((entry) => entry.path).sort();
}

/** What one row of a decide dialog was asked, in one string. */
export const asked = (row: DecidableConflict): string => `${row.reason}:${row.path ?? row.id}`;

/** How a stand-in person answers one row. `null` closes the dialog with "Not now". */
export type Answer = ConflictAction | null;

export interface Answering {
  /** `reason:path` per row, in the order the rows were put to the person. */
  seen: string[];
  /** Conflict ids, one entry per time a row was shown — duplicates included. */
  ids: string[];
  /**
   * The rows themselves, as the dialog put them — labels, notes and choices.
   *
   * `seen` says a question was asked; this is what it said. The dialog is torn
   * down when it closes, so a test that wants to read the wording has to keep it
   * from here.
   */
  rows: DecidableConflict[];
  /** Decide dialogs opened. */
  dialogs: number;
  stop: () => void;
}

/**
 * A person at the decide dialog.
 *
 * Answering *inside* the emit is the hard case, and the only one worth
 * simulating: a subscriber that replies before the dialog's own promise exists
 * used to wait for it forever. The `busy` flag is for re-entry — picking an
 * answer emits, like any other change.
 */
export function answering(
  model: ExplorerModel,
  pick: (row: DecidableConflict) => Answer | Promise<Answer>,
): Answering {
  const record: Answering = { seen: [], ids: [], rows: [], dialogs: 0, stop: () => undefined };
  let busy = false;
  const stop = model.subscribe(() => {
    const dialog = model.dialog;
    if (dialog?.kind !== 'decide' || busy) return;
    // Held across the whole reply, not just the reading of it: `setDecision`
    // emits like any other change, so a guard released too early re-enters here
    // on the model's own notification.
    busy = true;
    // The answer may take a while — a person reading the rows, and the folders
    // free to move while they do. The pass is suspended on the dialog's promise
    // either way, so replying a few microtasks later is the honest simulation
    // and the only way a test can change the world mid-dialog.
    void (async () => {
      try {
        record.dialogs++;
        let refused = false;
        for (const row of dialog.conflicts ?? []) {
          record.seen.push(asked(row));
          record.ids.push(row.id);
          // A copy, not the row: `setDecision` mutates `picked` in place, so the
          // live object would report the answer as if the dialog had arrived
          // holding it.
          record.rows.push({ ...row, choices: [...row.choices] });
          const answer = await pick(row);
          if (answer === null) {
            refused = true;
            continue;
          }
          const index = row.choices.findIndex((choice) => choice.action === answer);
          if (index < 0) throw new Error(`${asked(row)} cannot be answered ${answer}`);
          model.setDecision(row.id, index);
        }
        if (refused) model.cancelDialog();
        else model.acceptDialog();
      } finally {
        busy = false;
      }
    })();
  });
  record.stop = stop;
  return record;
}

/** A person at a confirm or prompt dialog: what it said, and what they did. */
export interface Prompting {
  /** Titles of the dialogs shown, in order. */
  titles: string[];
  /** The last dialog put to the person, kept after it closed. */
  last: { title: string; message: string; sections?: Array<{ title: string; items: string[] }> } | null;
  stop: () => void;
}

/**
 * Answers `confirm` and `prompt` dialogs. `reply` returns `true`/`false` for a
 * confirm, a string for a prompt, or `null` to cancel either.
 */
export function prompting(
  model: ExplorerModel,
  reply: (dialog: NonNullable<ExplorerModel['dialog']>) => boolean | string | null,
): Prompting {
  const record: Prompting = { titles: [], last: null, stop: () => undefined };
  let busy = false;
  const stop = model.subscribe(() => {
    const dialog = model.dialog;
    if (!dialog || dialog.kind === 'decide' || busy) return;
    busy = true;
    try {
      record.titles.push(dialog.title);
      record.last = {
        title: dialog.title,
        message: dialog.message,
        ...(dialog.sections ? { sections: dialog.sections } : {}),
      };
      const answer = reply(dialog);
      if (answer === null || answer === false) model.cancelDialog();
      else {
        // `setDialogValue` emits; see the note in `answering`.
        if (typeof answer === 'string') model.setDialogValue(answer);
        model.acceptDialog();
      }
    } finally {
      busy = false;
    }
  });
  record.stop = stop;
  return record;
}
