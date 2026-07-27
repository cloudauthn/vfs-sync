import type { JSX } from 'preact';
import { CONTROL_DIR } from '../../../src/index';
import type { PendingConflict } from '../../../src/index';
import { BACKEND_ICON, BLURB, CONTROL_BLURB, EDIT_LIMIT } from '../model';
import type { Details, ExplorerModel, Peer } from '../model';
import { formatAgo, formatBytes, formatSize, formatTime, iconOf } from '../format';
import { AcrossSection, DetailsShell, Section } from './shared';

export function PeerDetails({ model, peer }: { model: ExplorerModel; peer: Peer }): JSX.Element {
  const details = model.details;
  if (model.detailsLoading && !model.dirty) {
    return (
      <DetailsShell>
        <div class="vfs-details-inner">Reading…</div>
      </DetailsShell>
    );
  }
  if (!details || details.peer !== peer.key) {
    return (
      <DetailsShell>
        <RootDetails model={model} peer={peer} />
      </DetailsShell>
    );
  }
  return (
    <DetailsShell>
      <DetailsHead model={model} peer={peer} detail={details} />
      <div class="vfs-details-body">
        {details.kind === 'directory' ? (
          <FolderSections detail={details} />
        ) : (
          <FileSections model={model} peer={peer} detail={details} />
        )}
      </div>
    </DetailsShell>
  );
}

function RootDetails({ model, peer }: { model: ExplorerModel; peer: Peer }): JSX.Element {
  const snapshot = model.snapshotOf(peer.key);
  const history: Array<[string, string]> = Object.entries(snapshot.peers).map(([id, mark]) => [
    id,
    `${formatAgo(mark.lastSync)} @ ${mark.digest ? mark.digest.slice(0, 7) : '—'}`,
  ]);
  return (
    <div class="vfs-details-inner">
      <div class="vfs-details-head">
        <div class="vfs-details-title">
          <span class="vfs-details-icon">{BACKEND_ICON[peer.backend]}</span>
          <span class="vfs-details-name">{peer.label}</span>
        </div>
      </div>
      <div class="vfs-details-body">
        <p class="vfs-blurb">{BLURB[peer.backend]}</p>
        <Section
          title="Root"
          rows={[
            ['Backend', peer.backend],
            ['Adapter name', peer.adapter.name],
            ['Items', String(snapshot.files.length)],
            ['Size', formatSize(snapshot.bytes)],
          ]}
        />
        <Section
          title="Mirror"
          rows={[
            ['State', snapshot.state || 'nothing recorded yet'],
            ['Tracked entries', String(snapshot.tracked.size)],
            // The mirror is what the engine wrote, not what is on disk: as soon
            // as anything writes around it the two drift, and there is no way to
            // know without looking. Saying when it was last checked is the honest
            // version of that (§6).
            ['Verified', snapshot.verifiedAt ? formatAgo(snapshot.verifiedAt) : 'never'],
            ['Pending conflicts', String(snapshot.conflicts.length)],
          ]}
        />
        {snapshot.conflicts.length > 0 && (
          <ConflictSection model={model} peer={peer} conflicts={snapshot.conflicts} />
        )}
        <Section title="Sync history" rows={history.length ? history : [['—', 'never synced']]} />
        <p class="vfs-hint">Select a file on the left to inspect it.</p>
      </div>
    </div>
  );
}

/** What each `reason` actually means, in the words the UI should use. */
const REASON_BLURB: Record<PendingConflict['reason'], string> = {
  binary: 'two edits of content that cannot be merged',
  block: 'text whose edits overlap',
  'delete-edit': 'one side deleted it, the other edited it',
  kind: 'a file and a folder claiming the same path',
};

/**
 * The pending decisions, straight out of `vfs.json`.
 *
 * This is the half of §4 the explorer could not do before: conflicts existed
 * only as the return value of `sync()`, and their copies were spotted by the
 * shape of a filename. Now they are entries with `conflictOf`, so they can be
 * listed without syncing and settled without a sync either.
 */
function ConflictSection({
  model,
  peer,
  conflicts,
}: {
  model: ExplorerModel;
  peer: Peer;
  conflicts: PendingConflict[];
}): JSX.Element {
  return (
    <section class="vfs-section">
      <h3>Pending conflicts</h3>
      {conflicts.map((conflict) => (
        <div key={conflict.uuid} class="vfs-pending">
          <div class="vfs-pending-head" title={conflict.copyPath}>
            <span class="vfs-pending-path">{conflict.path}</span>
            <span class="vfs-pending-why">{REASON_BLURB[conflict.reason]}</span>
          </div>
          <div class="vfs-details-actions">
            <button
              class="vfs-ghost"
              title={`Keep what is at ${conflict.path}`}
              onClick={() => void model.resolveConflict(peer, conflict.uuid, 'mine')}
            >
              Keep mine
            </button>
            <button
              class="vfs-ghost"
              title={
                conflict.held
                  ? `${conflict.peer} kept the bytes — sync with it first`
                  : `Promote ${conflict.copyPath}`
              }
              onClick={() => void model.resolveConflict(peer, conflict.uuid, 'theirs')}
            >
              {conflict.held ? `Keep ${conflict.peer}’s (remote)` : `Keep ${conflict.peer}’s`}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function DetailsHead({
  model,
  peer,
  detail,
}: {
  model: ExplorerModel;
  peer: Peer;
  detail: Details;
}): JSX.Element {
  const name = detail.path.slice(detail.path.lastIndexOf('/') + 1);
  return (
    <div class="vfs-details-head">
      <div class="vfs-details-title" title={`${peer.label} / ${detail.path}`}>
        <span class="vfs-details-icon">
          {detail.kind === 'directory' ? '📂' : iconOf(detail.mime)}
        </span>
        <span class="vfs-details-name">{name}</span>
      </div>
      {detail.control ? (
        <div class="vfs-details-actions">
          <span class="vfs-chip vfs-chip-muted" title="The engine writes the store, not the user">
            read-only
          </span>
        </div>
      ) : (
        detail.kind === 'file' && (
          <div class="vfs-details-actions">
            <button class="vfs-ghost" onClick={() => void model.renameFile(peer, detail.path)}>
              Rename
            </button>
            <button
              class="vfs-ghost vfs-danger"
              onClick={() => void model.deleteFile(peer, detail.path)}
            >
              Delete
            </button>
          </div>
        )
      )}
    </div>
  );
}

function FolderSections({ detail }: { detail: Details }): JSX.Element {
  return (
    <>
      {detail.control && <p class="vfs-blurb">{CONTROL_BLURB}</p>}
      <Section
        title={detail.control ? 'Store folder' : 'Folder'}
        rows={[
          ['Path', detail.path],
          ['Items', String(detail.count)],
          ['Size', formatSize(detail.bytes)],
        ]}
      />
      {detail.control ? (
        <ControlNote path={detail.path} />
      ) : (
        <AcrossSection across={detail.across} />
      )}
    </>
  );
}

/** One line per part of the store, keyed by its path inside `.vfs`. */
const CONTROL_NOTES: Record<string, string> = {
  'vfs.json':
    'The mirror of this folder. A header first — store id, the state digest, ' +
    'what each peer was last seen at — then one row per path, so a peer can read ' +
    'the header with a range read and never touch the entries.',
  commits:
    'The append-only log: one JSON object per line, one line per operation. Rows ' +
    'are identified and immutable, so merging two logs is set union.',
  base:
    'Previous versions of text files, kept for a three-way merge. Local ' +
    'bookkeeping: it never travels to a peer, and losing it only costs a ' +
    'conflict copy that need not have happened.',
};

/** Prefix matches, for the files that carry a rotation timestamp in their name. */
const CONTROL_PREFIXES: Array<[string, string]> = [
  [
    'commits-',
    'A closed log segment, frozen when the active one outgrew its budget. ' +
      'Immutable, read only in the cold path, and safe to delete.',
  ],
  [
    'vfs-',
    'The cumulative snapshot taken when that segment closed: the last known ' +
      'state of every entry that has ever existed, tombstones included. It is ' +
      'what makes pruning a tombstone from vfs.json safe.',
  ],
];

/**
 * What the opened part of the store is for. The `.vfs` view exists to be read,
 * so the pane explains it rather than leaving a folder of hashes to be decoded.
 */
function ControlNote({ path }: { path: string }): JSX.Element | null {
  const inside = path === CONTROL_DIR ? '' : path.slice(CONTROL_DIR.length + 1);
  // Anything under base/ is described by the folder it is in.
  const note =
    CONTROL_NOTES[inside] ??
    CONTROL_NOTES[inside.split('/')[0] ?? ''] ??
    CONTROL_PREFIXES.find(([prefix]) => inside.startsWith(prefix))?.[1];
  return note === undefined ? null : <p class="vfs-hint">{note}</p>;
}

/** The same hash means something different per row, so the hint says which. */
function checksumHint(detail: Details): string {
  const { control, entry, hash, path } = detail;
  // A base copy is named after the hash of what it holds, so the checksum on
  // that row is a proof: re-hashing the bytes lands on the name they are under.
  if (control && hash !== null && path.endsWith(hash)) {
    return 'SHA-256 of these bytes — the very hash this copy is filed under.';
  }
  if (control) return 'SHA-256 of these bytes.';
  if (entry?.hash && hash && entry.hash !== hash) {
    return (
      'SHA-256 of the file on disk — it differs from what vfs.json records, so ' +
      'this edit has not been reconciled yet.'
    );
  }
  return 'SHA-256 of the file on disk — what a peer checks against on arrival.';
}

function FileSections({
  model,
  peer,
  detail,
}: {
  model: ExplorerModel;
  peer: Peer;
  detail: Details;
}): JSX.Element {
  const { stat, entry } = detail;
  return (
    <>
      {detail.control && <p class="vfs-blurb">{CONTROL_BLURB}</p>}
      <Section
        title={detail.control ? 'Store file' : 'File'}
        rows={[
          ['Path', detail.path],
          ['Kind', detail.mime],
          ['Size', stat ? formatSize(stat.size) : '—'],
          ['Modified', stat ? `${formatTime(stat.mtime)} (${formatAgo(stat.mtime)})` : '—'],
        ]}
      />
      <section class="vfs-section">
        <h3>Checksum</h3>
        <code class="vfs-hash" title={detail.hash ?? ''}>
          {detail.hash ?? 'computing…'}
        </code>
        <p class="vfs-hint">{checksumHint(detail)}</p>
      </section>
      {detail.control ? (
        <ControlNote path={detail.path} />
      ) : (
        <>
          <Section
            title="Tracking"
            rows={[
              [
                'State',
                entry ? (entry.hash === detail.hash ? 'recorded' : 'modified') : 'untracked',
              ],
              ['Entry uuid', entry?.uuid ?? '—'],
              ['Updated', entry ? formatTime(entry.updated) : '—'],
              ['Last edited by', entry?.peer ?? '—'],
              ['Previous version', entry?.prev ? entry.prev.slice(0, 12) : '—'],
              ['Moved from', entry?.prevPath ?? '—'],
              ['Backend id', entry?.native ?? '—'],
            ]}
          />
          <AcrossSection across={detail.across} />
        </>
      )}
      {detail.text !== null ? (
        <Editor model={model} peer={peer} detail={detail} />
      ) : stat && stat.size > EDIT_LIMIT ? (
        <section class="vfs-section">
          <p class="vfs-hint">{`Too large to open here (${formatBytes(stat.size)}).`}</p>
        </section>
      ) : (
        <section class="vfs-section">
          <p class="vfs-hint">{`No text preview for ${detail.mime}.`}</p>
        </section>
      )}
    </>
  );
}

function Editor({
  model,
  peer,
  detail,
}: {
  model: ExplorerModel;
  peer: Peer;
  detail: Details;
}): JSX.Element {
  if (detail.control) {
    return (
      <section class="vfs-section vfs-editor vfs-editor-ro">
        <div class="vfs-editor-head">
          <h3>Contents</h3>
          <span class="vfs-chip vfs-chip-muted">read-only</span>
        </div>
        <textarea
          key={`${peer.key}:${detail.path}`}
          readOnly
          spellcheck={false}
          value={detail.text ?? ''}
        />
      </section>
    );
  }
  return (
    <section class="vfs-section vfs-editor">
      <div class="vfs-editor-head">
        <h3>Contents</h3>
        <button
          class="vfs-primary"
          disabled={!model.dirty}
          onClick={() => void model.write(peer, detail.path, detail.text ?? '')}
        >
          Save
        </button>
      </div>
      <textarea
        key={`${peer.key}:${detail.path}`}
        spellcheck={false}
        value={detail.text ?? ''}
        onInput={(event) => model.markDirty((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 's') {
            event.preventDefault();
            void model.write(peer, detail.path, (event.currentTarget as HTMLTextAreaElement).value);
          }
        }}
      />
    </section>
  );
}
