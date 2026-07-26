import type { JSX } from 'preact';
import { CONTROL_DIR } from '../../../src/index';
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
  const history: Array<[string, string]> = Object.entries(snapshot.peers).map(([id, info]) => [
    id,
    `${formatAgo(info.lastSync)} @ ${info.head ? info.head.slice(0, 7) : '—'}`,
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
          title="Commit"
          rows={[
            ['Head', snapshot.head ?? 'no commits yet'],
            ['Tracked files', String(snapshot.tracked.size)],
          ]}
        />
        <Section title="Sync history" rows={history.length ? history : [['—', 'never synced']]} />
        <p class="vfs-hint">Select a file on the left to inspect it.</p>
      </div>
    </div>
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
  objects:
    'Blobs, named after the SHA-256 of their bytes and bucketed by its first two ' +
    'characters. Identical content is one object, however many paths hold it.',
  commits:
    'One JSON file per commit: the tree it snapshots, its parents and the peer ' +
    'that wrote it.',
  'config.json':
    'This root’s id and head commit, plus what it knows of every peer it has ' +
    'synced with.',
  'known-commits.log':
    'Every commit this root has ever seen. It turns common-ancestor negotiation ' +
    'into a set intersection instead of a walk of the graph.',
  'hash-cache.json':
    'mtime+size → hash, so a scan only re-reads what actually changed. Local ' +
    'bookkeeping: it never travels to a peer.',
};

/**
 * What the opened part of the store is for. The `.vfs` view exists to be read,
 * so the pane explains it rather than leaving a folder of hashes to be decoded.
 */
function ControlNote({ path }: { path: string }): JSX.Element | null {
  const inside = path === CONTROL_DIR ? '' : path.slice(CONTROL_DIR.length + 1);
  // Anything under objects/ or commits/ is described by the folder it is in.
  const note = CONTROL_NOTES[inside] ?? CONTROL_NOTES[inside.split('/')[0] ?? ''];
  return note === undefined ? null : <p class="vfs-hint">{note}</p>;
}

/** The same hash means something different per row, so the hint says which. */
function checksumHint(detail: Details): string {
  const { control, entry, hash, path } = detail;
  // A blob's own name is its hash, so on an object row the checksum is a proof:
  // re-hashing the bytes lands back on the path they were read from.
  if (control && hash !== null && path.endsWith(hash)) {
    return (
      'SHA-256 of these bytes — the very hash this object is filed under, ' +
      'which is what content-addressed means.'
    );
  }
  if (control) return 'SHA-256 of these bytes.';
  if (entry?.hash && hash && entry.hash !== hash) {
    return (
      'SHA-256 of the file on disk — it differs from the committed blob, so ' +
      'this edit has not been committed yet.'
    );
  }
  return 'SHA-256 of the file on disk. It is the address the blob is stored under.';
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
                entry ? (entry.hash === detail.hash ? 'committed' : 'modified') : 'untracked',
              ],
              ['Entry id', entry?.id ?? '—'],
              ['Logical mtime', entry ? formatTime(entry.mtime) : '—'],
              ['Last edited by', entry?.peer ?? '—'],
              ['Renamed from', entry?.renamedFrom ?? '—'],
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
