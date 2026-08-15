import { describe, expect, it } from 'vitest';
import type { ExplorerModel, Peer } from '../explorer/src/model';
import { legalAnswers } from '../src/index.js';
import { CURRENT_VERSION } from '../src/vfs-file.js';
import { answering, live, strangers, twoRoots, write } from './explorer-model.js';
import type { PairingRefusal } from './explorer-model.js';

/**
 * What the decide dialog *says*.
 *
 * The engine's half of this is `pairing.test.ts`: which pairings are refused,
 * which answers are legal, and that nothing is written while one is outstanding.
 * None of that is retested here. What is tested is the translation between that
 * contract and a person — the sentence under the row, the two folders as they
 * are described, and the words on the button that gives one folder's history
 * away.
 *
 * It is its own suite because a regression here does not fail a sync. It changes
 * what somebody believes they are agreeing to, and the only place that shows is
 * the wording.
 */

/** The one row a pairing refusal produces, with nobody answering it. */
async function refused(reason: PairingRefusal): Promise<{
  model: ExplorerModel;
  row: NonNullable<ReturnType<typeof rowOf>>;
}> {
  const model = await strangers(reason);
  const person = answering(model, () => null);
  await model.syncAll();
  person.stop();
  const row = rowOf(person.rows);
  if (!row) throw new Error(`${reason} put no row to anybody`);
  return { model, row };
}

const rowOf = (rows: Awaited<ReturnType<typeof answering>>['rows']) => rows[0];

/** Every choice a row offers, as the person reads them. */
const labels = (row: { choices: Array<{ label: string }> }): string[] =>
  row.choices.map((choice) => choice.label);

describe('a pairing row is about two folders, not a file', () => {
  it('has no path, and describes each folder by what it holds', async () => {
    const { row } = await refused('foreign-mesh');

    // A file conflict is titled by its path; this one has none, and the dialog
    // falls back to the reason. Asserting the absence is the point: a row that
    // grew a path would be claiming this is about one file.
    expect(row.path).toBeUndefined();
    expect(row.id).toBe('foreign-mesh');
    expect(row.sides.map((side) => side.label)).toEqual(['left', 'right']);
    expect(row.sides.map((side) => side.detail)).toEqual([
      '1 item(s) · has synced before',
      '2 item(s) · has synced before',
    ]);
  });

  it('says which folder has never synced, and which cannot be read', async () => {
    const fresh = await refused('peer-collision');
    // Both are folders nobody has ever synced — the fact the engine itself uses
    // to decide which one is safe to give a new identity.
    expect(fresh.row.sides.every((side) => side.detail.includes('has never synced'))).toBe(true);
    expect(fresh.row.sides.some((side) => side.detail.includes('unreadable format'))).toBe(false);

    const ahead = await refused('version-unreconcilable');
    expect(ahead.row.sides[0].detail).not.toContain('unreadable format');
    expect(ahead.row.sides[1].detail).toContain('· unreadable format');
  });
});

describe('the question a foreign mesh asks', () => {
  it('says what survives and what may come back', async () => {
    const { row } = await refused('foreign-mesh');

    // The whole of what a person is told before giving a group's history away.
    // Both halves are asserted because either one alone is a different sentence:
    // "every file stays" on its own reads as a merge with no cost.
    expect(row.note).toContain('never been part of the same group');
    expect(row.note).toContain('every file stays');
    expect(row.note).toContain('deletions it made may come back');
  });

  it('names both groups, and does not call it a merge', async () => {
    const { row } = await refused('foreign-mesh');

    expect(labels(row)).toEqual([
      "Keep left's group (right rejoins as new)",
      "Keep right's group (left rejoins as new)",
      'Leave it for now',
    ]);
    // The absence is the property. `adopt` discards one folder's log, tombstones
    // and merge bases; a button that said "merge" would describe a destructive
    // action as an additive one, which is the defect this wording was written
    // for in the first place.
    expect(labels(row).some((label) => /merge|combine|join together/i.test(label))).toBe(false);
  });

  it('settles the edge when it is answered, and the loser keeps every file', async () => {
    const model = await strangers('foreign-mesh');
    const [left, right] = model.peers as [Peer, Peer];
    const winner = (await left.node.file()).syncId;
    const loser = (await right.node.file()).syncId;
    expect(winner).not.toBe(loser);

    // The first choice is `adopt` on side a — left's group.
    const person = answering(model, () => 'adopt');
    await model.syncAll();
    person.stop();

    expect(person.dialogs).toBe(1);
    expect((await left.node.file()).syncId).toBe(winner);
    expect((await right.node.file()).syncId).toBe(winner);
    // Every byte survives on both sides: that is what makes the question
    // answerable at all, and it is the half of the note a person is trusting.
    const union = ['left-0.txt', 'right-0.txt', 'right-1.txt'];
    expect(await live(left)).toEqual(union);
    expect(await live(right)).toEqual(union);
  });

  it('writes nothing when the answer is "not now", and does not call that being in sync', async () => {
    const model = await strangers('foreign-mesh');
    const [left, right] = model.peers as [Peer, Peer];

    const person = answering(model, () => null);
    await model.syncAll();
    person.stop();

    expect(await live(left)).toEqual(['left-0.txt']);
    expect(await live(right)).toEqual(['right-0.txt', 'right-1.txt']);
    expect((await left.node.file()).syncId).not.toBe((await right.node.file()).syncId);
    // The footer shows `lastMessage`, so the last line written is the one a
    // person reads. Two folders that cannot merge at all are not "in sync", and
    // saying so under the dialog they just declined is the opposite of what
    // happened.
    expect(model.lastMessage).toBe('left for later, nothing written');
  });

  it('does not call it being in sync when the answer is "leave it for now" either', async () => {
    const model = await strangers('foreign-mesh');
    const [left, right] = model.peers as [Peer, Peer];

    // The other way to decline, and the quieter one: `abort` reaches the engine
    // and comes back as a result, so the pass ends with no error and no dialog
    // left open — which is how it used to end up reporting success.
    const person = answering(model, () => 'abort');
    await model.syncAll();
    person.stop();

    expect(model.lastMessage).toBe('nothing written');
    expect(await live(left)).toEqual(['left-0.txt']);
    expect(await live(right)).toEqual(['right-0.txt', 'right-1.txt']);
  });
});

describe('the question a copied folder asks', () => {
  it('says one is a copy, and offers each side its identity', async () => {
    const { row } = await refused('peer-collision');

    expect(row.note).toContain('Both folders claim the same identity');
    expect(row.choices.map((choice) => choice.action)).toEqual(['reidentify', 'reidentify', 'abort']);
    // Two folders claiming one identity carry one name between them, so a label
    // built from it alone reads the same twice — and the two buttons do
    // different things. They are told apart by their position in the row, which
    // is where the person is reading what each folder holds.
    expect(labels(row)).toEqual([
      'twin (first) keeps its identity',
      'twin (second) keeps its identity',
      'Leave it for now',
    ]);
    expect(row.sides.map((side) => side.label)).toEqual(['twin (first)', 'twin (second)']);
  });

  it('settles when it is answered, and only one side keeps the identity', async () => {
    const model = await strangers('peer-collision');
    const [a, b] = model.peers as [Peer, Peer];

    const person = answering(model, () => 'reidentify');
    await model.syncAll();
    person.stop();

    expect(person.dialogs).toBe(1);
    // Side a keeps `twin`; the folder that yielded is issued a new id, and the
    // two are no longer one peer.
    expect((await a.node.file()).peerId).toBe('twin');
    expect((await b.node.file()).peerId).not.toBe('twin');
    const union = ['one-twin-0.txt', 'two-twin-0.txt', 'two-twin-1.txt'];
    expect(await live(a)).toEqual(union);
    expect(await live(b)).toEqual(union);
  });
});

describe('the dialog offers what the contract admits, and nothing else', () => {
  it('matches legalAnswers for every pairing refusal', async () => {
    for (const reason of ['foreign-mesh', 'peer-collision', 'version-unreconcilable'] as const) {
      const { row } = await refused(reason);

      // Asserted against `legalAnswers` rather than a list written here: a
      // second copy of the catalogue is exactly how the dialog would be free to
      // drift from the engine that has to accept the answer.
      expect([...new Set(row.choices.map((choice) => choice.action))]).toEqual(legalAnswers(reason));
      expect(row.choices.at(-1)?.action).toBe('abort');
      expect(row.choices.filter((choice) => choice.action === 'abort')).toHaveLength(1);
    }
  });

  it('offers a folder from a newer build nothing but "leave it"', async () => {
    const { row } = await refused('version-unreconcilable');

    expect(labels(row)).toEqual(['Leave it for now']);
    expect(row.note).toBe(
      `This build writes format v${CURRENT_VERSION} and cannot migrate what is there.`,
    );
  });
});

describe('the two entry-level sentences', () => {
  it('counts what a folder takes with it when a file wants its name', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await write(left, 'thing/inner.txt', 'inside\n');
    await write(left, 'thing/deeper/leaf.txt', 'further in\n');
    await write(right, 'thing', 'a file by that name\n');

    const person = answering(model, () => null);
    await model.syncAll();
    person.stop();

    const row = person.rows.find((entry) => entry.reason === 'kind');
    // Three: the two files, and the directory between them.
    expect(row?.note).toBe('A file and a folder want this name, and the folder takes 3 item(s) with it.');
    // The sentence for a folder with nothing in it is not asserted because it
    // cannot be reached: a directory is in the store only while it holds
    // something — deleting its last child drops the directory entry with it —
    // so `subtree` is never 0 on the side that is a folder.
  });

  it('says which side deleted and which side changed', async () => {
    const model = await twoRoots();
    const [left, right] = model.peers as [Peer, Peer];
    await left.node.delete('notes.txt');
    await left.node.commit();
    await write(right, 'notes.txt', 'still working on it\n');

    const person = answering(model, () => null);
    await model.syncAll();
    person.stop();

    const row = person.rows.find((entry) => entry.reason === 'delete-edit');
    expect(row?.note).toBe('One side deleted it, the other changed it.');
  });
});
