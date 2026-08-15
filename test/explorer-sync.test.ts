import { describe, expect, it, vi } from 'vitest';
import { ALL_ROOTS } from '../explorer/src/model';
import type { ExplorerModel, Peer } from '../explorer/src/model';
import { ConflictError, sync } from '../src/index';
import type { Answer } from './explorer-model.js';
import {
  answering,
  disagree,
  live,
  prompting,
  refusingToAnswer,
  roots,
  twoRoots,
  write,
} from './explorer-model.js';

/**
 * What a person presses.
 *
 * `explorer.test.ts` covers the chain-wide pass; this covers the footer — one
 * edge against a chosen target, the plan shown before it runs, the loop that
 * re-asks, and the button that settles a conflict parked weeks ago. They are the
 * last paths in this repo where a wrong answer could reach `sync()` with nobody
 * watching.
 */

const messages = (model: ExplorerModel): string[] => model.logs.map((entry) => entry.message);
const said = (model: ExplorerModel, text: string): boolean =>
  messages(model).some((message) => message.includes(text));

/** The text a root holds at a path, read back through its own adapter. */
async function read(peer: Peer, path: string): Promise<string> {
  return new TextDecoder().decode(await peer.adapter.read(path));
}

describe('the footer syncs one edge', () => {
  it('syncs the pair it was pointed at, and leaves the rest of the chain alone', async () => {
    const model = await roots(['left', 'middle', 'right']);
    const [left, middle, right] = model.peers as [Peer, Peer, Peer];
    await write(left, 'notes.txt', 'only for the middle\n');

    await model.activate(left);
    model.setSyncTarget(middle.key);
    await model.syncTarget();

    expect(await read(middle, 'notes.txt')).toBe('only for the middle\n');
    // The chain is left ⇄ middle ⇄ right: one edge ran, so the far end is
    // untouched. A `syncAll` here would have carried it all the way.
    expect(await read(right, 'notes.txt')).toBe('shared\n');
    expect(said(model, 'left ⇄ middle')).toBe(true);
  });

  it('falls through to the whole chain for "all roots", and for itself', async () => {
    for (const target of ['all', 'self'] as const) {
      const model = await roots(['left', 'middle', 'right']);
      const [left, , right] = model.peers as [Peer, Peer, Peer];
      await write(left, 'notes.txt', `via ${target}\n`);

      await model.activate(left);
      // Pointing the footer at the open root itself is not a no-op and not an
      // error: there is no edge to sync, so it means the chain.
      model.setSyncTarget(target === 'all' ? ALL_ROOTS : left.key);
      const stop = refusingToAnswer(model, 'a chain with nothing in dispute');
      await model.syncTarget();
      stop();

      expect(await read(right, 'notes.txt')).toBe(`via ${target}\n`);
    }
  });

  it('says which of the three things happened', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await model.activate(left);
    model.setSyncTarget(right.key);

    await model.syncTarget();
    expect(said(model, 'left ⇄ right: already in sync')).toBe(true);

    await write(left, 'notes.txt', 'moved\n');
    await model.syncTarget();
    expect(said(model, 'left ⇄ right: merged, 1 blob(s) moved')).toBe(true);
  });

  it('writes nothing when every row is answered "leave it for now"', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);
    await model.activate(left);
    model.setSyncTarget(right.key);

    // Not the same path as closing the dialog: an `abort` decision reaches the
    // engine and comes back as a result, where "Not now" never answers at all.
    const person = answering(model, () => 'abort');
    await model.syncTarget();
    person.stop();

    expect(person.seen).toEqual(['content:notes.txt']);
    expect(said(model, 'left ⇄ right: nothing written')).toBe(true);
    expect(await live(left)).toEqual(['notes.txt']);
    expect(await live(right)).toEqual(['notes.txt']);
    expect(await read(left, 'notes.txt')).toBe('from the left\n');
    expect(await read(right, 'notes.txt')).toBe('from the right\n');
  });

  it('asks on the single edge too, and applies what the answer said', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);
    await model.activate(left);
    model.setSyncTarget(right.key);

    const person = answering(model, () => 'keep-both');
    await model.syncTarget();
    person.stop();

    expect(person.dialogs).toBe(1);
    for (const peer of [left, right]) {
      expect(await live(peer)).toHaveLength(2);
      expect(await peer.node.conflicts()).toHaveLength(1);
    }
  });
});

describe('the plan shown before it runs', () => {
  /** A pair with one of everything the preview claims to list. */
  async function readyToSync(): Promise<{ model: ExplorerModel; left: Peer; right: Peer }> {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await write(left, 'gone.txt', 'temporary\n');
    await write(left, 'shared.md', 'first\nsecond\nthird\n');
    await model.syncAll();

    await write(left, 'new.md', 'only on the left\n'); // a create
    await write(left, 'notes.txt', 'rewritten\n'); // an overwrite
    await left.node.delete('gone.txt'); // a delete
    await left.node.commit();
    await write(left, 'shared.md', 'FIRST\nsecond\nthird\n'); // two ends of one
    await write(right, 'shared.md', 'first\nsecond\nTHIRD\n'); // text file: a merge

    await model.activate(left);
    model.setSyncTarget(right.key);
    return { model, left, right };
  }

  it('is a dry run: cancelling writes nothing at all', async () => {
    const { model, left, right } = await readyToSync();
    const before = await Promise.all([left.node.state(), right.node.state()]);

    const person = prompting(model, () => false);
    await model.syncTargetWithConfirm();
    person.stop();

    expect(person.titles).toEqual(['Confirm sync']);
    expect(await Promise.all([left.node.state(), right.node.state()])).toEqual(before);
    expect(await read(right, 'notes.txt')).toBe('shared\n');
    expect(await right.adapter.stat('new.md')).toBeNull();
    expect(await right.adapter.stat('gone.txt')).not.toBeNull();
    expect(said(model, 'sync cancelled')).toBe(true);
  });

  it('says what will happen, in the four ways it can happen', async () => {
    const { model, right } = await readyToSync();
    const person = prompting(model, () => false);
    await model.syncTargetWithConfirm();
    person.stop();

    const sections = new Map(
      (person.last?.sections ?? []).map((section) => [section.title, section.items]),
    );
    expect(sections.get('Files that change')).toContain(`→ ${right.label}: notes.txt`);
    expect(sections.get('Files that are created')).toContain(`→ ${right.label}: new.md`);
    expect(sections.get('Files updated via text merge')).toEqual(['shared.md']);
    expect(sections.get('Files that are deleted')).toContain(`→ ${right.label}: gone.txt`);
    // A settled text merge is still a conflict that *happened*: the engine keeps
    // the report so a caller can see it, and the preview shows it under both
    // headings. Nothing here needs a person — the pass below runs unattended.
    expect(sections.get('Conflicts')).toEqual(['shared.md (content)']);
    expect(person.last?.message).toContain('text merges: 1');
  });

  it('reaches the decide dialog when the approved pass stops anyway', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);
    await model.activate(left);
    model.setSyncTarget(right.key);

    // Two modals in a row is the intended flow: the plan, then the question the
    // plan could not answer. What is pinned is that the second one appears.
    const person = prompting(model, () => true);
    const decider = answering(model, () => 'keep-both');
    await model.syncTargetWithConfirm();
    person.stop();
    decider.stop();

    expect(person.titles).toEqual(['Confirm sync']);
    expect(decider.seen).toEqual(['content:notes.txt']);
    expect(await live(left)).toHaveLength(2);
    expect(await live(right)).toHaveLength(2);
  });
});

describe('the loop that re-asks', () => {
  it('asks a second time when an answer is overtaken by a fresh edit, and settles', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await write(left, 'second.txt', 'shared\n');
    await model.syncAll();
    await disagree(model); // notes.txt: the conflict that opens the dialog

    // The person is slow, and the folders are free to move while they read —
    // which is the reason `syncAnswering` loops instead of trying exactly twice.
    let interrupted = false;
    const person = answering(model, async (): Promise<Answer> => {
      if (!interrupted) {
        interrupted = true;
        await write(left, 'second.txt', 'left too\n');
        await write(right, 'second.txt', 'right too\n');
      }
      return 'keep-both';
    });
    await model.activate(left);
    model.setSyncTarget(right.key);
    await model.syncTarget();
    person.stop();

    // Every conflict is answered exactly once. Asking again for something the
    // person already settled is how a two-round pass walks to the 8-round cap.
    expect(new Set(person.ids).size).toBe(person.ids.length);
    expect(person.seen.sort()).toEqual(['content:notes.txt', 'content:second.txt']);
    expect(said(model, 'still unsettled after 8 rounds')).toBe(false);
    for (const peer of [left, right]) {
      expect(await peer.node.conflicts()).toHaveLength(2);
      expect(await live(peer)).toHaveLength(4); // two files, two parked copies
    }
  });

  it('gives up out loud rather than reopening a dialog forever', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);

    // A folder that manufactures a *new* dispute every time the person answers
    // the last one. Answering settles what was asked, so this is the only way to
    // reach the cap — and it is what the cap is for: a modal that can reopen
    // forever is worse than one that gives up and says so.
    const manufactured = new Set<number>();
    const person = answering(model, async (): Promise<Answer> => {
      if (!manufactured.has(person.dialogs)) {
        manufactured.add(person.dialogs);
        const name = `round-${person.dialogs}.txt`;
        await write(left, name, 'from the left\n');
        await write(right, name, 'from the right\n');
      }
      return 'keep-both';
    });
    await model.activate(left);
    model.setSyncTarget(right.key);
    await model.syncTarget();
    person.stop();

    expect(person.dialogs).toBe(8); // the cap, reached in bounded time
    expect(said(model, 'still unsettled after 8 rounds')).toBe(true);
    // Eight dialogs and not one byte moved: every file each root holds is the
    // one it wrote itself, and nothing was parked as a copy.
    expect(await read(left, 'notes.txt')).toBe('from the left\n');
    expect(await read(right, 'notes.txt')).toBe('from the right\n');
    expect(await read(right, 'round-1.txt')).toBe('from the right\n');
    expect(await left.node.conflicts()).toEqual([]);
    expect(await right.node.conflicts()).toEqual([]);
  });
});

describe('the pass nobody started', () => {
  /** A model whose timer ticks fast enough to test, and always stopped after. */
  async function ticking(): Promise<{ model: ExplorerModel; left: Peer; right: Peer }> {
    const model = await twoRoots({ autoSyncMs: 5 });
    const [left, right] = model.peers as [Peer, Peer];
    return { model, left, right };
  }

  const passes = (model: ExplorerModel): number =>
    model.logs.filter((entry) => entry.message.includes('in sync') || entry.message.includes('converged'))
      .length;

  it('carries a change on its own, without opening anything', async () => {
    const { model, left, right } = await ticking();
    const nobody = refusingToAnswer(model, 'the timer');
    await write(left, 'notes.txt', 'while nobody watched\n');

    model.setAutoSync(true);
    expect(model.autoSyncOn).toBe(true);
    await vi.waitFor(async () => expect(await read(right, 'notes.txt')).toBe('while nobody watched\n'));

    model.setAutoSync(false);
    nobody();
    expect(model.autoSyncOn).toBe(false);
  });

  it('reports what stopped it once, and again only when the dispute changes', async () => {
    const { model, left, right } = await ticking();
    const nobody = refusingToAnswer(model, 'the timer');
    await disagree(model);

    // Counted off the model, not off the log. A pass that stops on a conflict
    // writes no summary line at all — that is the point of `reportStopped`, and
    // it is the property this test is about — so the log cannot be the
    // heartbeat here. `syncing` is raised by every pass whatever it ends up
    // saying.
    let ticks = 0;
    let running = false;
    const counting = model.subscribe(() => {
      if (model.syncing && !running) ticks++;
      running = model.syncing;
    });

    model.setAutoSync(true);
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(3));
    const reported = model.logs.filter((entry) => entry.kind === 'conflict');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('needs a decision');

    // A second file falls out, so the set is not the one already reported.
    await write(left, 'second.txt', 'left\n');
    await model.syncAll(false);
    await write(left, 'second.txt', 'left again\n');
    await write(right, 'second.txt', 'right instead\n');
    await vi.waitFor(() =>
      expect(model.logs.filter((entry) => entry.kind === 'conflict').length).toBeGreaterThan(1),
    );

    model.setAutoSync(false);
    counting();
    nobody();
    // Nothing was written the whole time: both roots are as their owner left them.
    expect(await read(left, 'notes.txt')).toBe('from the left\n');
    expect(await read(right, 'notes.txt')).toBe('from the right\n');
  });

  it('stops the clock when the page is done with it', async () => {
    const { model, left } = await ticking();
    model.setAutoSync(true);
    await vi.waitFor(() => expect(passes(model)).toBeGreaterThanOrEqual(2));

    let woken = 0;
    model.subscribe(() => woken++);
    model.destroy();
    // A pass already in flight when the page went away runs to the end — a plan
    // abandoned half-applied is worse than one that finishes — so the property
    // is that no *new* pass starts, measured once the last one has landed.
    // Teardown also notifies once on its way out, turning the auto-sync box off
    // like any other change, and then drops every listener.
    await vi.waitFor(() => expect(model.syncing).toBe(false));
    const [after, wokenAtDestroy] = [passes(model), woken];

    await write(left, 'notes.txt', 'after the page is gone\n');
    await new Promise((resolve) => setTimeout(resolve, 40)); // eight intervals
    expect(passes(model)).toBe(after);
    expect(model.autoSyncOn).toBe(false);
    expect(woken).toBe(wokenAtDestroy);
  });
});

describe('settling a conflict parked earlier', () => {
  /** Two roots, one disputed file, answered `keep-both` — the state a person comes back to. */
  async function parked(): Promise<{ model: ExplorerModel; left: Peer; right: Peer }> {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);
    const person = answering(model, () => 'keep-both');
    await model.syncAll();
    person.stop();
    return { model, left, right };
  }

  it('keeps this side, and drops the copy', async () => {
    const { model, left } = await parked();
    const [conflict] = await left.node.conflicts();
    if (!conflict) throw new Error('nothing parked');
    const winner = await read(left, conflict.path);

    await model.resolveConflict(left, conflict.uuid, 'mine');

    expect(await left.node.conflicts()).toEqual([]);
    expect(await live(left)).toEqual([conflict.path]);
    expect(await read(left, conflict.path)).toBe(winner);
    expect(said(model, `resolved ${conflict.path}`)).toBe(true);
  });

  it('takes the parked version, and the answer travels on the next sync', async () => {
    const { model, left, right } = await parked();
    const [conflict] = await left.node.conflicts();
    if (!conflict) throw new Error('nothing parked');
    const loser = await read(left, conflict.copyPath);

    await model.resolveConflict(left, conflict.uuid, 'theirs');

    expect(await left.node.conflicts()).toEqual([]);
    expect(await read(left, conflict.path)).toBe(loser);

    // An ordinary edit from here: no state machine, so it propagates like any
    // write and settles the other root's copy too.
    await model.syncAll();
    expect(await read(right, conflict.path)).toBe(loser);
    expect(await right.node.conflicts()).toEqual([]);
    expect(await live(right)).toEqual([conflict.path]);
  });

  it('refuses the version whose bytes stayed on the peer that made it', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await disagree(model);

    // A conflict copy above `HELD_AT` does not travel: the entry does, the bytes
    // stay put. 64 MiB is not a fixture, so the same state is reached through
    // the option the engine exposes for exactly this, driven straight at the
    // nodes — the model has no way to ask for it, which is why the branch was
    // never taken.
    try {
      await sync(left.node, right.node, { heldAt: 1 });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const decisions = error.conflicts.map((conflict) => ({
        id: conflict.id,
        action: 'keep-both' as const,
      }));
      await sync(left.node, right.node, { heldAt: 1, decisions });
    }
    await model.render();

    const holder = (
      await Promise.all(
        [left, right].map(async (peer) => ({ peer, pending: await peer.node.conflicts() })),
      )
    ).find(({ peer, pending }) => pending[0]?.held && pending[0].held !== peer.node.peerId);
    if (!holder) throw new Error('no copy was left behind');
    const conflict = holder.pending[0] as NonNullable<(typeof holder.pending)[0]>;

    const before = await read(holder.peer, conflict.path);
    await model.resolveConflict(holder.peer, conflict.uuid, 'theirs');

    // Said, not thrown: the engine would refuse a read of bytes that were never
    // going to be here, and a click is not the place to find that out.
    expect(said(model, `stayed on ${conflict.held as string}`)).toBe(true);
    expect(await holder.peer.node.conflicts()).toHaveLength(1); // still pending
    expect(await read(holder.peer, conflict.path)).toBe(before); // and untouched
  });

  it('does nothing to a conflict that is not there', async () => {
    const { model, left } = await parked();
    const before = await live(left);

    await model.resolveConflict(left, 'conflict:nobody', 'mine');

    expect(await live(left)).toEqual(before);
    expect(await left.node.conflicts()).toHaveLength(1);
  });
});

describe('the dialogs the toolbar opens', () => {
  /**
   * What the tree shows, which is a walk of the folder — not `live()`, which is
   * the store's record. A new file is on disk the moment it is created and
   * enters the store on the next commit, so the pane and the record disagree
   * for exactly as long as that, and the pane is what the person is looking at.
   */
  const shown = (model: ExplorerModel, peer: Peer): string[] =>
    model.snapshotOf(peer.key).files.map((file) => file.path);

  it('creates the file the prompt was answered with', async () => {
    const model = await twoRoots();
    const [left] = model.peers as [Peer];
    const person = prompting(model, () => 'draft.md');

    await model.newFile(left);
    person.stop();

    expect(person.titles).toEqual(['New file']);
    expect(shown(model, left)).toContain('draft.md');
    expect(await left.adapter.stat('draft.md')).not.toBeNull();
    expect(said(model, 'created draft.md on left')).toBe(true);
  });

  it('creates nothing when the prompt is cancelled', async () => {
    const model = await twoRoots();
    const [left] = model.peers as [Peer];
    const person = prompting(model, () => null);

    await model.newFile(left);
    person.stop();

    expect(shown(model, left)).toEqual(['notes.txt']);
  });

  it('refuses a name inside the store, which the engine alone writes', async () => {
    const model = await twoRoots();
    const [left] = model.peers as [Peer];
    const person = prompting(model, () => '.vfs/vfs.json');

    await model.newFile(left);
    person.stop();

    expect(await left.adapter.stat('.vfs/vfs.json')).not.toBeNull(); // the real store, untouched
    expect(shown(model, left)).toEqual(['notes.txt']);
    expect(said(model, 'read-only')).toBe(true);
  });

  it('tracks an unsaved edit without touching the folder', async () => {
    const model = await twoRoots();
    const [left] = model.peers as [Peer];
    await model.activate(left);
    await model.select(left, { path: 'notes.txt', kind: 'file' });

    model.markDirty('typed but not saved\n');

    expect(model.dirty).toBe(true);
    expect(model.details?.text).toBe('typed but not saved\n');
    expect(await read(left, 'notes.txt')).toBe('shared\n');
  });
});
