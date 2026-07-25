import type { JSX } from 'preact';
import { BACKEND_ICON, BLURB, EDIT_LIMIT } from '../model';
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
      {detail.kind === 'file' && (
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
      )}
    </div>
  );
}

function FolderSections({ detail }: { detail: Details }): JSX.Element {
  return (
    <>
      <Section
        title="Folder"
        rows={[
          ['Path', detail.path],
          ['Items', String(detail.count)],
          ['Size', formatSize(detail.bytes)],
        ]}
      />
      <AcrossSection across={detail.across} />
    </>
  );
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
  const modified = entry && entry.hash && detail.hash && entry.hash !== detail.hash;
  return (
    <>
      <Section
        title="File"
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
        <p class="vfs-hint">
          {modified
            ? 'SHA-256 of the file on disk — it differs from the committed blob, so this edit has not been committed yet.'
            : 'SHA-256 of the file on disk. It is the address the blob is stored under.'}
        </p>
      </section>
      <Section
        title="Tracking"
        rows={[
          ['State', entry ? (entry.hash === detail.hash ? 'committed' : 'modified') : 'untracked'],
          ['Entry id', entry?.id ?? '—'],
          ['Logical mtime', entry ? formatTime(entry.mtime) : '—'],
          ['Last edited by', entry?.peer ?? '—'],
          ['Renamed from', entry?.renamedFrom ?? '—'],
        ]}
      />
      <AcrossSection across={detail.across} />
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
