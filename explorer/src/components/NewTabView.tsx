import type { JSX } from 'preact';
import { isFSAAvailable } from '../../../src/index';
import { BLURB } from '../model';
import type { BrowseRow, BrowseSource, ExplorerModel } from '../model';
import { formatAgo, formatSize, formatTime, iconOf, mimeOf } from '../format';
import { DetailsShell, Section } from './shared';

export function NewTabView({ model }: { model: ExplorerModel }): JSX.Element {
  const source = model.currentSource();
  return (
    <>
      <div class="vfs-sidebar">
        <SourceBar model={model} />
        {source && (
          <>
            <div class="vfs-sidebar-head">
              <span class="vfs-crumbs-static">
                <span class="vfs-tab-icon">{source.icon}</span>
                <span>{source.label}</span>
              </span>
              <button
                class="vfs-ghost"
                title="Create a folder inside the selected one, or at the root (a / in the name nests)"
                disabled={!source.adapter?.mkdir}
                onClick={() => void model.newBrowseFolder(source)}
              >
                ＋ New folder
              </button>
            </div>
            <BrowseTree model={model} source={source} />
            <div class="vfs-sidebar-foot">
              <span>Tabs only open folders initialised as vFS</span>
              {source.fsa && (
                <button
                  class="vfs-ghost"
                  title="Ask for permission on this folder again"
                  onClick={() => void model.regrantSource(source)}
                >
                  Re-grant
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <DetailsShell>
        <BrowseDetails model={model} source={source} />
      </DetailsShell>
    </>
  );
}

function SourceBar({ model }: { model: ExplorerModel }): JSX.Element {
  const current = model.currentSource();
  return (
    <div class="vfs-fs-bar">
      {model.sources.map((source) => (
        <button
          key={source.key}
          class={`vfs-fs${source.key === current?.key ? ' vfs-active' : ''}`}
          title={BLURB[source.backend]}
          onClick={() => model.selectSource(source)}
        >
          <span class="vfs-tab-icon">{source.icon}</span>
          <span>{source.label}</span>
          {source.removable && (
            <span
              class="vfs-tab-close"
              role="button"
              aria-label={`Forget ${source.label}`}
              title="Forget this folder (nothing on disk is touched)"
              onClick={(event) => {
                event.stopPropagation();
                void model.removeSource(source);
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
      {model.wantsLocalFolder && isFSAAvailable() && (
        <>
          <button
            class="vfs-fs vfs-fs-pick"
            title="Browse a folder from your disk as a plain filesystem"
            onClick={() => void model.pickFsaSource()}
          >
            ＋ Pick FS
          </button>
          <button
            class="vfs-fs vfs-fs-pick"
            title="Open a folder from your disk as a vFS tab (offers to initialise it)"
            onClick={() => void model.pickFsaVfs()}
          >
            ＋ Pick vFS
          </button>
        </>
      )}
      {model.canGDrive && (
        <button
          class="vfs-fs vfs-fs-pick"
          title="Authorise Google Drive in the browser and browse it as a filesystem"
          onClick={() => void model.connectGDrive()}
        >
          ☁ Connect Drive
        </button>
      )}
    </div>
  );
}

function BrowseTree({
  model,
  source,
}: {
  model: ExplorerModel;
  source: BrowseSource;
}): JSX.Element {
  const view = model.newTab;
  const fresh = view && view.sourceKey === source.key;
  const rows = fresh ? view.rows : null;
  const notice = fresh ? view.notice : null;
  // While switching source the tree for the new source is not built yet; show a
  // placeholder rather than the previous source's rows or a blank pane.
  if (model.newTabLoading || !fresh) {
    return (
      <ul class="vfs-tree" role="tree">
        <li class="vfs-empty">Loading…</li>
      </ul>
    );
  }
  return (
    <ul class="vfs-tree" role="tree">
      {rows && rows.length > 0
        ? rows.map((row) => <BrowseRowItem key={row.path} model={model} source={source} row={row} />)
        : notice && <li class="vfs-empty">{notice}</li>}
    </ul>
  );
}

function BrowseRowItem({
  model,
  source,
  row,
}: {
  model: ExplorerModel;
  source: BrowseSource;
  row: BrowseRow;
}): JSX.Element {
  const selected = model.browseSel?.source === source.key && model.browseSel.path === row.path;
  if (row.kind === 'directory') {
    return (
      <li
        class={`vfs-row vfs-dir${selected ? ' vfs-selected' : ''}`}
        role="treeitem"
        aria-expanded={row.expanded}
        aria-selected={selected || undefined}
      >
        <div class="vfs-entry-line">
          <button
            class="vfs-entry"
            style={{ paddingLeft: row.depth * 14 + 6 }}
            title={row.path}
            onClick={() => model.selectBrowse(source, row.path, 'directory')}
            onDblClick={() => model.toggleBrowseDir(source, row.path, row.expanded)}
          >
            <span
              class="vfs-twisty"
              onClick={(event) => {
                event.stopPropagation();
                model.toggleBrowseDir(source, row.path, row.expanded);
              }}
            >
              {row.expanded ? '▾' : '▸'}
            </span>
            <span class="vfs-icon-cell">{row.expanded ? '📂' : '📁'}</span>
            <span class="vfs-name">{row.name}</span>
            <span class="vfs-meta">{`${row.childCount}`}</span>
          </button>
          <button
            class="vfs-rowbtn vfs-danger"
            title={`Delete ${row.path}`}
            aria-label={`Delete ${row.path}`}
            onClick={() => void model.deleteBrowseEntry(source, row.path)}
          >
            ×
          </button>
        </div>
        {row.info && (
          <button
            class="vfs-vfsline"
            style={{ paddingLeft: row.depth * 14 + 24 }}
            title={`Pairing id ${row.info.storeId} — open this vFS in a tab`}
            onClick={() => void model.openVfsTab(source, row.path)}
          >
            <span class="vfs-chip">vFS</span>
            <span class="vfs-vfsid">{row.info.storeId}</span>
          </button>
        )}
      </li>
    );
  }
  return (
    <li class={`vfs-row${selected ? ' vfs-selected' : ''}`} aria-selected={selected || undefined}>
      <button
        class="vfs-entry"
        style={{ paddingLeft: row.depth * 14 + 6 }}
        title={row.path}
        onClick={() => model.selectBrowse(source, row.path, 'file')}
      >
        <span class="vfs-twisty" />
        <span class="vfs-icon-cell">{iconOf(mimeOf(row.path))}</span>
        <span class="vfs-name">{row.name}</span>
      </button>
    </li>
  );
}

function BrowseDetails({
  model,
  source,
}: {
  model: ExplorerModel;
  source: BrowseSource | undefined;
}): JSX.Element {
  const data =
    model.newTab && source && model.newTab.sourceKey === source.key
      ? model.newTab.details
      : { kind: 'intro' as const };

  // The selection paints instantly; its details land a beat later. Show the
  // picked entry's name with a placeholder so the pane never looks stalled.
  if (model.browseDetailsLoading && model.browseSel) {
    const name = model.browseSel.path.split('/').pop() || model.browseSel.path;
    return (
      <div class="vfs-details-inner">
        <div class="vfs-details-head">
          <div class="vfs-details-title" title={name}>
            <span class="vfs-details-icon">{model.browseSel.kind === 'directory' ? '📂' : '📄'}</span>
            <span class="vfs-details-name">{name}</span>
          </div>
        </div>
        <div class="vfs-details-body">
          <p class="vfs-hint">Loading…</p>
        </div>
      </div>
    );
  }

  if (!source || data.kind === 'intro') {
    return (
      <div class="vfs-details-inner">
        <div class="vfs-details-body">
          <h3>{source?.label ?? ''}</h3>
          {source && <p class="vfs-blurb">{BLURB[source.backend]}</p>}
          <p class="vfs-hint">
            Pick a folder or file on the left to inspect it. Folders holding a .vfs store show a vFS
            block underneath — that block opens the store as a tab. A plain folder can be initialised
            from its info pane.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="vfs-details-inner">
      <div class="vfs-details-head">
        <div class="vfs-details-title" title={`${source.label} / ${data.path}`}>
          <span class="vfs-details-icon">
            {data.kind === 'directory' ? '📂' : iconOf(data.mime)}
          </span>
          <span class="vfs-details-name">{data.name}</span>
        </div>
        <div class="vfs-details-actions">
          <button
            class="vfs-ghost vfs-danger"
            onClick={() => void model.deleteBrowseEntry(source, data.path)}
          >
            Delete
          </button>
        </div>
      </div>
      <div class="vfs-details-body">
        {data.kind === 'file' ? (
          <>
            <Section
              title="File"
              rows={[
                ['Path', data.path],
                ['Kind', data.mime],
                ['Size', formatSize(data.stat.size)],
                ['Modified', `${formatTime(data.stat.mtime)} (${formatAgo(data.stat.mtime)})`],
              ]}
            />
            <p class="vfs-hint">
              Loose files can be inspected here; editing happens inside a vFS tab.
            </p>
          </>
        ) : (
          <>
            <Section
              title="Folder"
              rows={[
                ['Path', data.path],
                ['Items', String(data.count)],
              ]}
            />
            {data.info ? (
              <>
                <Section title="vFS" rows={[['Pairing id', data.info.storeId]]} />
                <button class="vfs-primary" onClick={() => void model.openVfsTab(source, data.path)}>
                  Open as tab
                </button>
                <p class="vfs-hint">
                  Replicas of this folder converge on the same pairing id, whichever FS they live on.
                </p>
              </>
            ) : (
              <>
                <button
                  class="vfs-primary"
                  title="Writes a .vfs store into this folder and opens it as a tab"
                  onClick={() => void model.openVfsTab(source, data.path, true)}
                >
                  Initialise as vFS
                </button>
                <p class="vfs-hint">
                  A plain folder. Initialising writes a .vfs store inside so it can sync.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
