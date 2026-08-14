import { describe, expect, it } from 'vitest';
import { disagree, twoRoots } from './explorer-model.js';

/**
 * The consumer, driven headlessly.
 *
 * The engine's behaviour is pinned by the rest of this suite; what is pinned
 * here is the wiring nobody else covers — that a stopped pass reaches a person,
 * that their answer reaches `sync()`, and that the pass which *has* no person
 * does not sit there waiting for one.
 *
 * The fixture is in [`explorer-model.ts`](./explorer-model.ts), shared with the
 * tests of what the footer drives. It needs no DOM: the model is plain
 * TypeScript over adapters, and a subscriber standing in for a user is exactly
 * what the components are.
 */

describe('the explorer answers what stops a pass', () => {
  it('asks, and applies what the answer said', async () => {
    const model = await twoRoots();
    await disagree(model);

    const seen: string[] = [];
    // Answering *inside* the emit is the hard case: a subscriber that replies
    // before the dialog's own promise exists used to wait for it forever. The
    // guard is for re-entry — picking an answer emits, like any other change.
    let answering = false;
    const stop = model.subscribe(() => {
      const dialog = model.dialog;
      if (dialog?.kind !== 'decide' || answering) return;
      answering = true;
      for (const row of dialog.conflicts ?? []) {
        seen.push(`${row.reason}:${row.path}`);
        expect(row.sides.map((side) => side.label).sort()).toEqual(['left', 'right']);
        // Offered exactly what the contract admits, and never `replace` here.
        expect(row.choices.map((choice) => choice.action)).toEqual(['keep', 'keep', 'keep-both', 'abort']);
        expect(model.decisionsComplete).toBe(false);
        model.setDecision(row.id, row.choices.findIndex((choice) => choice.action === 'keep-both'));
      }
      expect(model.decisionsComplete).toBe(true);
      answering = false;
      model.acceptDialog();
    });

    await model.syncAll();
    stop();

    expect(seen).toEqual(['content:notes.txt']);
    for (const peer of model.peers) {
      const live = (await peer.node.live()).map((entry) => entry.path).sort();
      // Both versions landed, on both roots, and the parked one is resolvable.
      expect(live).toHaveLength(2);
      expect(live).toContain('notes.txt');
      expect(await peer.node.conflicts()).toHaveLength(1);
    }
  });

  it('writes nothing when the answer is "not now"', async () => {
    const model = await twoRoots();
    await disagree(model);

    const stop = model.subscribe(() => {
      if (model.dialog?.kind === 'decide') model.cancelDialog();
    });
    await model.syncAll();
    stop();

    const [left] = model.peers;
    const live = (await left?.node.live())?.map((entry) => entry.path);
    expect(live).toEqual(['notes.txt']);
    expect(model.logs.some((entry) => entry.message.includes('nothing written'))).toBe(true);
  });

  /**
   * The auto-sync timer. A modal every few seconds because two devices disagree
   * about one file is not a feature, and neither is a log line every tick.
   */
  it('never opens a dialog on the pass nobody started, and says so once', async () => {
    const model = await twoRoots();
    await disagree(model);

    let dialogs = 0;
    const stop = model.subscribe(() => {
      if (model.dialog?.kind === 'decide') dialogs++;
    });
    await model.syncAll(false);
    await model.syncAll(false);
    await model.syncAll(false);
    stop();

    expect(dialogs).toBe(0);
    const reported = model.logs.filter((entry) => entry.kind === 'conflict');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('needs a decision');
    // Three ticks, and the folder is exactly as the user left it.
    const [left] = model.peers;
    expect((await left?.node.live())?.map((entry) => entry.path)).toEqual(['notes.txt']);
  });
});
