import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, FileUp, ListTree, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CATALOG_FILE_LIMIT, type CatalogChange, type CatalogClearPreview, type CatalogFilter, type CatalogJob, type CatalogJobPage, type CatalogPage, type CatalogSource, type CatalogTransfer } from '../shared/catalog.js';
import type { ImportResult } from '../shared/types.js';
import { api, ApiResponseError, base, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { date, ErrorMessage, FilterSelect, formatNumber, Loading, Modal } from './ui.js';
import { createTranslator } from '../shared/i18n/index.js';
import { catalogMessages } from '../shared/i18n/locales/catalog.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createMessages, LocalizedError, useLanguage } from './i18n.js';

const useText = createMessages('catalog', catalogMessages);

type Overview = { sources: CatalogSource[]; jobs: CatalogJob[]; transfer: CatalogTransfer | null };
type SourceDialog = { type: 'edit'; source: CatalogSource; url: string } | { type: 'delete'; source: CatalogSource };
const changes: CatalogChange[] = ['all', 'added', 'removed', 'changed'];
const activeStates = ['upload', 'queued', 'running', 'paused'];
const moving = (job?: CatalogTransfer | null) => job?.state === 'queued' || job?.state === 'running';
const overviewPoll = (data?: Overview) => moving(data?.transfer) || data?.jobs.some(job => activeStates.includes(job.state)) ? 700 : 3_000;

function query(filter: CatalogFilter) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  return '?' + params.toString();
}

function Jobs({ jobs, sources, control }: { jobs: CatalogJob[]; sources: CatalogSource[]; control: (jobId: number, action: string) => void }) {
  const t = useText();
  const locale = useLanguage();
  const names = new Map(sources.map(source => [source.id, source.name]));
  return <ul className="catalog-jobs">
      {jobs.map(job => <li key={job.id}>
        <div>
          <strong>{t('importId', { id: job.id })} · {t(`state_${job.state}`)}</strong>
          <small className="catalog-job-counts">{names.get(job.sourceId)} · {date(job.createdAt)}</small>
          <span className="catalog-job-counts">{t('importProgress', { urls: formatNumber(job.uniqueUrls), completed: formatNumber(job.documentsDone), total: formatNumber(job.documentsTotal) })}
            {job.duplicates > 0 && <> · {t('duplicateCount', { count: job.duplicates, value: formatNumber(job.duplicates) })}</>}
            {job.invalid > 0 && <> · {t('skippedCount', { count: formatNumber(job.invalid) })}</>}
            {job.bytes > 0 && <> · {t('mebibytes', { count: formatNumber(Math.round(job.bytes / 1024 / 1024 * 10) / 10) })}</>}
          </span>
          {job.warning && <small>{t('largeImportWarning')}</small>}
          {job.error && <div className="catalog-job-error"><ErrorMessage text={translateDiagnostic(job.error, locale)} />
            {job.problemFile && <small title={job.problemFile}>{job.problemFile}</small>}</div>}
        </div>
        <div className="catalog-buttons">
          {['queued', 'running'].includes(job.state) &&
            <button className="button small secondary" onClick={() => control(job.id, 'pause')}>{t('pauseImport')}</button>}
          {['paused', 'failed'].includes(job.state) &&
            <button className="button small secondary" onClick={() => control(job.id, 'resume')}>{t('resumeImport')}</button>}
          {(activeStates.includes(job.state) || job.state === 'failed') &&
            <button className="button small secondary" onClick={() => control(job.id, 'cancel')}>{t('cancelImport')}</button>}
        </div>
      </li>)}
    </ul>;
}

export function CatalogView({ projectId, changed, openRun, openWorklist }: {
  projectId: number; changed: () => void; openRun: (runId: number) => void; openWorklist: () => void;
}) {
  const t = useText();
  const locale = useLanguage();
  const path = base(projectId) + '/catalog';
  const overview = useQuery<Overview>(path, overviewPoll);
  const task = useTask();
  const [sourceId, setSourceId] = useState<number>();
  const [link, setLink] = useState('');
  const [newSource, setNewSource] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearedSources, setClearedSources] = useState<number>();
  const [filteredRevision, setFilteredRevision] = useState<number>();
  const [sourceDialog, setSourceDialog] = useState<SourceDialog>();
  const [historyCursors, setHistoryCursors] = useState<number[]>();
  const historyCursor = historyCursors?.at(-1);
  const history = useQuery<CatalogJobPage>(historyCursors ? path + '/imports/history' + (historyCursor ? '?before=' + historyCursor : '') : null, 3_000);
  const sources = overview.data?.sources ?? [];
  const recentJobs = overview.data?.jobs ?? [];
  const source = sourceId === undefined ? sources[0] : sources.find(source => source.id === sourceId);
  const canClear = sources.length > 0 && (filteredRevision === undefined || filteredRevision !== source?.currentId);
  const waitingForSource = sourceId !== undefined && !source;
  const transfer = overview.data?.transfer;
  const transferStatus = transfer && transfer.id + ':' + transfer.state;
  const lastTransfer = useRef(transferStatus);
  useEffect(() => {
    if (transferStatus && lastTransfer.current !== transferStatus) changed();
    lastTransfer.current = transferStatus;
  }, [transferStatus, changed]);
  const sourceBusy = overview.data?.jobs.some(job => job.sourceId === source?.id && activeStates.includes(job.state));

  function update(operation: () => Promise<void>) {
    setClearedSources(undefined);
    void task.run(async () => { try { await operation(); } finally { overview.refresh(); } });
  }

  function remote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update(async () => {
      const job = await write<CatalogJob>(path + '/imports', 'POST', { url: link.trim() });
      setSourceId(job.sourceId); setLink(''); setNewSource(false);
    });
  }

  function upload(file?: File, previous?: number) {
    update(async () => {
      if (window.pulseDesktop) {
        const picked = await window.pulseDesktop.pickCatalogFile(projectId, previous);
        if (picked) { setSourceId(picked.sourceId); setNewSource(false); }
        return;
      }
      if (!file) return;
      if (file.size > CATALOG_FILE_LIMIT) {
        throw new LocalizedError(locale => createTranslator(locale, 'catalog', catalogMessages)('fileTooBig'));
      }
      const job = await write<CatalogJob>(path + '/imports', 'POST', { fileName: file.name, sourceId: previous });
      setSourceId(job.sourceId);
      setNewSource(false);
      overview.refresh();
      await api(path + '/imports/' + job.id + '/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
    });
  }

  function filePicker(label: string, previous?: number) {
    return window.pulseDesktop
      ? <button className="button secondary" type="button" disabled={task.busy} onClick={() => upload(undefined, previous)}>
        <FileUp size={16} /> {label}</button>
      : <label className="catalog-file"><FileUp size={16} /><span>{label}</span>
        <input type="file" accept=".xml,.gz" aria-label={label} disabled={task.busy}
          onChange={event => { upload(event.target.files?.[0], previous); event.target.value = ''; }} />
      </label>;
  }

  function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceDialog) return;
    update(async () => {
      const sourcePath = path + '/sources/' + sourceDialog.source.id;
      if (sourceDialog.type === 'edit') await write(sourcePath, 'PATCH', { url: sourceDialog.url.trim() });
      else {
        await api(sourcePath, { method: 'DELETE' });
        setSourceId(sources.find(entry => entry.id !== sourceDialog.source.id)?.id);
      }
      setSourceDialog(undefined);
    });
  }

  function controlImport(id: number, action: string) {
    update(async () => {
      try { await write(path + '/imports/' + id + '/control', 'POST', { action }); }
      finally { if (historyCursors) history.refresh(); }
    });
  }

  return <div className="catalog-view">
    <section className="panel catalog-panel" aria-label={t('sources')}>
      <div className="catalog-heading"><div className="section-heading">
        <span className="section-icon violet"><ListTree size={19} /></span>
        <div><h2>{t('heading')}</h2><p>{t('description')}</p></div>
      </div><div className="catalog-buttons">
        {canClear && <button type="button" className="button secondary danger-ghost" onClick={() => setConfirmClear(true)}>
          <Trash2 size={16} /> {t('clearCatalog')}</button>}
        {sources.some(source => source.count > 0) && <button type="button" className="button primary"
          disabled={task.busy || moving(transfer)} onClick={() => setConfirmTransfer(true)}><Plus size={16} /> {t('transferAll')}</button>}
        {sources.length > 0 && <button className="button secondary" aria-expanded={newSource} onClick={() => setNewSource(!newSource)}>
          <Plus size={16} /> {t('source')}</button>}
      </div></div>
      <ErrorMessage text={overview.error || (clearedSources === undefined ? task.error : undefined)} />
      {clearedSources !== undefined && <p className="catalog-feedback" role="status">{t('catalogCleared', { count: formatNumber(clearedSources) })}</p>}
      {(!sources.length || newSource) && <form className="catalog-controls" onSubmit={remote}>
        <label className="catalog-field catalog-grow">{t('sitemapLink')}
          <input value={link} onChange={event => setLink(event.target.value)} placeholder="https://example.org/sitemap.xml" type="url" required maxLength={2000} />
        </label>
        <button className="button primary" disabled={task.busy || !link}>{t('import')}</button>
        {filePicker(t('uploadFile'))}
      </form>}
      {source && <div className="catalog-controls">
        <label className="catalog-field catalog-grow">{t('source')}
          <select value={source.id} onChange={event => setSourceId(Number(event.target.value))}>
            {sources.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        {source.url
          ? <button className="button secondary" disabled={task.busy || sourceBusy} onClick={() => update(async () => {
            await write(path + '/imports', 'POST', { sourceId: source.id });
          })}><RefreshCw size={16} /> {t('refreshSource')}</button>
          : !sourceBusy && filePicker(t('uploadVersion'), source.id)}
        {source.url && <button type="button" className="button secondary" disabled={task.busy || sourceBusy}
          onClick={() => { task.clear(); setSourceDialog({ type: 'edit', source, url: source.url! }); }}>{t('editSource')}</button>}
        <button type="button" className="button secondary danger-ghost" disabled={task.busy || sourceBusy}
          onClick={() => { task.clear(); setSourceDialog({ type: 'delete', source }); }}>{t('deleteSource')}</button>
      </div>}
    </section>
    {transfer && <section className="panel catalog-panel" aria-label={t('transfer')}>
      {moving(transfer) ? <div className="progress-bar catalog-transfer" role="status">
        <div><strong>{transfer.state === 'queued' ? t('queuedTransfer') : t('transfer')}</strong>
          <span>{transfer.total === null
            ? t('processedCount', { count: formatNumber(transfer.processed) })
            : t('processedTotal', { count: formatNumber(transfer.processed), total: formatNumber(transfer.total) })}</span>
          <span>{t('addedCount', { count: formatNumber(transfer.added) })}</span></div>
        <progress max={transfer.total || 1} value={transfer.total === null ? undefined : transfer.processed} aria-label={t('transferProgress')} />
        <button type="button" className="button small secondary" disabled={task.busy} onClick={() => update(async () => {
          await write(path + '/transfer/' + transfer.id + '/stop', 'POST', {});
        })}>{t('stopTransfer')}</button>
      </div> : <div className="catalog-heading">
        <div role="status"><strong>{transfer.state === 'done' ? t('transferDone') : transfer.state === 'cancelled' ? t('transferStopped') : t('transferFailed')}</strong>
          <p>{t('transferResult', { added: formatNumber(transfer.added), existing: formatNumber(transfer.existing) })}</p>
          {transfer.error && <ErrorMessage text={translateDiagnostic(transfer.error, locale)} />}</div>
        <button className="button secondary" onClick={openWorklist}>{t('openUrls')}</button>
      </div>}
    </section>}
    {source?.currentId && <CatalogTable key={source.id + ':' + source.currentId} projectId={projectId} source={source}
      changed={changed} openRun={openRun} filterChanged={filtered => setFilteredRevision(filtered ? source.currentId ?? undefined : undefined)} />}
    {(!overview.data || waitingForSource) && !overview.error && <Loading />}
    {(recentJobs.length > 0 || historyCursors) && <details className="panel catalog-panel" open>
      <summary>{t('imports')}</summary>
      <div className="catalog-buttons">
        {historyCursors
          ? <button type="button" className="button small secondary" onClick={() => setHistoryCursors(undefined)}>{t('recentImports')}</button>
          : <button type="button" className="button small secondary" onClick={() => setHistoryCursors([])}>{t('importHistory')}</button>}
      </div>
      {historyCursors ? <>
        <ErrorMessage text={history.error} />
        {!history.data && !history.error && <Loading />}
        {history.data?.jobs.length === 0 && <p>{t('noImports')}</p>}
        {history.data && <Jobs jobs={history.data.jobs} sources={sources} control={controlImport} />}
        <div className="table-footer">
          <span>{t('page', { page: formatNumber(historyCursors.length + 1) })}</span>
          <div className="catalog-buttons">
            <button type="button" className="button small secondary" disabled={!historyCursors.length}
              onClick={() => setHistoryCursors(historyCursors.slice(0, -1))}><ChevronLeft size={15} /> {t('newerImports')}</button>
            <button type="button" className="button small secondary" disabled={!history.data?.next}
              onClick={() => setHistoryCursors([...historyCursors, history.data!.next!])}>{t('olderImports')} <ChevronRight size={15} /></button>
          </div>
        </div>
      </> : <Jobs jobs={recentJobs} sources={sources} control={controlImport} />}
    </details>}
    {confirmTransfer && <Modal title={t('transferConfirmTitle')} close={() => setConfirmTransfer(false)}>
      <div className="modal-body">
        <p>{t('transferConfirmDescription')}</p>
        <p>{t('transferStopHint')}</p>
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={() => setConfirmTransfer(false)}>{t('cancel')}</button>
        <button type="button" className="button primary" disabled={task.busy || moving(transfer)} onClick={() => {
          setConfirmTransfer(false);
          update(async () => { await write(path + '/transfer', 'POST', {}); });
        }}>{t('confirmTransfer')}</button>
      </div>
    </Modal>}
    {confirmClear && <ClearCatalogForm path={path + '/clear'} close={() => setConfirmClear(false)} cleared={deleted => {
      setSourceId(undefined);
      setNewSource(false);
      setLink('');
      setHistoryCursors(undefined);
      setFilteredRevision(undefined);
      setClearedSources(deleted);
      setConfirmClear(false);
      overview.reset();
      changed();
    }} />}
    {sourceDialog && <Modal title={sourceDialog.type === 'edit' ? t('editSourceTitle') : t('deleteSourceTitle')}
      close={() => { if (!task.busy) setSourceDialog(undefined); }}>
      <form onSubmit={saveSource}>
        <div className="modal-body form">
          {sourceDialog.type === 'edit' ? <>
            <label>{t('sitemapLink')}
              <input value={sourceDialog.url} onChange={event => setSourceDialog({ ...sourceDialog, url: event.target.value })}
                required type="url" maxLength={2000} autoFocus disabled={task.busy} />
            </label>
            <p className="field-note">{t('editSourceHint')}</p>
          </> : <p>{t('deleteSourceDescription', { name: sourceDialog.source.name })}</p>}
          <ErrorMessage text={task.error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" disabled={task.busy} onClick={() => setSourceDialog(undefined)}>{t('cancel')}</button>
          <button type="submit" className={sourceDialog.type === 'edit' ? 'button primary' : 'button danger'} disabled={task.busy}>
            {sourceDialog.type === 'edit' ? t('saveSource') : t('deleteSource')}
          </button>
        </div>
      </form>
    </Modal>}
  </div>;
}

function ClearCatalogForm({ path, close, cleared }: { path: string; close: () => void; cleared: (deleted: number) => void }) {
  const t = useText();
  const { data, error, reset } = useQuery<CatalogClearPreview>(path);
  const hasOperations = data && (data.activeImports > 0 || data.transferActive);
  return <ConfirmDeletion title={t('clearCatalogConfirm')} label={hasOperations ? t('stopAndClear') : t('clearCatalog')}
    close={close} ready={!!data?.sources && !error} pendingLabel={t('clearingCatalog')} confirm={async () => {
      if (!data) return;
      try {
        const { deleted } = await write<{ deleted: number }>(path, 'POST', { confirmation: data.confirmation });
        cleared(deleted);
      } catch (failure) {
        if (failure instanceof ApiResponseError && failure.status === 409) reset();
        throw failure;
      }
    }}>
    <ErrorMessage text={error} />
    {error && <button type="button" className="button secondary" onClick={reset}>{t('refreshPreview')}</button>}
    {!data && !error && <Loading />}
    {data && <>
      <p>{t('project')} <strong>{t('quotedName', { name: data.projectName })}</strong></p>
      <p><strong>{t('sourceCount', { count: formatNumber(data.sources) })}</strong> · {t('importRecordCount', { count: formatNumber(data.imports) })}<br />
        {t('publishedUrlCount', { count: formatNumber(data.publishedUrls) })}</p>
      <p>{t('clearCatalogDescription')}</p>
      <p>{t('clearCatalogStopsOperations')}</p>
      {hasOperations && <p>{t('activeImportCount', { count: formatNumber(data.activeImports) })} {data.transferActive && t('activeTransfer')}</p>}
    </>}
  </ConfirmDeletion>;
}

function CatalogTable({ projectId, source, changed, openRun, filterChanged }: { projectId: number; source: CatalogSource; changed: () => void;
  openRun: (runId: number) => void; filterChanged: (filtered: boolean) => void }) {
  const t = useText();
  const path = base(projectId) + '/catalog';
  const unfiltered: CatalogFilter = { sourceId: source.id, revision: source.currentId!, change: 'all' };
  const [domain, setDomain] = useState('');
  const [prefix, setPrefix] = useState('');
  const [filters, setFilters] = useState(unfiltered);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState('100');
  const [feedback, setFeedback] = useState<{ runId: number } | ImportResult>();
  const page = useQuery<CatalogPage>(path + '/page' + query({ ...filters, after: cursors.at(-1) }));
  const rows = page.data?.items ?? [];
  const task = useTask();
  const number = Number(limit);
  const validLimit = Number.isInteger(number) && number >= 1 && number <= 5000;
  const draftChanged = domain.trim() !== (filters.domain ?? '') || prefix.trim() !== (filters.prefix ?? '');
  const canExport = !draftChanged && !task.busy && !!page.data && !page.error;
  const canAct = canExport && (selected.size > 0 || (rows.length > 0 && validLimit));
  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.url));
  const applied = [source.name, filters.domain && t('domainSummary', { domain: filters.domain }), filters.prefix && t('pathSummary', { path: filters.prefix }),
    t(`change_${filters.change ?? 'all'}`), filters.direction === 'desc' ? t('descendingSummary') : t('ascendingSummary')].filter(Boolean).join(' · ');

  function apply(updated: CatalogFilter) {
    if (!cursors.length && page.error && query(updated) === query(filters)) page.reset();
    setFilters(updated);
    filterChanged(!!(updated.domain || updated.prefix || updated.change !== 'all'));
    setCursors([]); setSelected(new Set()); setFeedback(undefined); task.clear();
  }

  function toggle(urls: string[], checked: boolean) {
    setSelected(old => {
      const next = new Set(old);
      for (const url of urls) {
        if (!checked) next.delete(url);
        else if (next.size < 5000) next.add(url);
      }
      return next;
    });
  }

  function act(action: 'check' | 'add') {
    void task.run(async () => {
      setFeedback(undefined);
      const selection = selected.size ? { selected: [...selected] } : { limit: number };
      const result = await write<ImportResult | { id: number }>(path + '/actions', 'POST', { ...filters, action, ...selection });
      setFeedback('id' in result ? { runId: result.id } : result);
      changed();
    });
  }

  function save(onlySelected: boolean) {
    const chosen = onlySelected ? [...selected] : undefined;
    void task.run(async () => {
      if (window.pulseDesktop) {
        const result = await window.pulseDesktop.exportCatalog(projectId, filters, chosen);
        if (!result.saved && result.error) throw new Error(result.error);
      } else if (chosen) {
        const response = await fetch(path + '/export', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...filters, selected: chosen }) });
        if (!response.ok) throw new Error((await response.json()).error ?? t('exportFailed'));
        const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        const filename = encodedName ? decodeURIComponent(encodedName) : 'pulse-sitemap.csv';
        const link = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a');
        anchor.href = link; anchor.download = filename; anchor.click();
        setTimeout(() => URL.revokeObjectURL(link), 1000);
      }
    });
  }

  return <section className="panel catalog-panel catalog-table-panel" aria-label={t('sitemapUrls')}>
    <div className="catalog-heading">
      <h2>{t('sitemapUrls')}</h2>
      <div className="catalog-counts">
        <span>{t('urlCount', { count: formatNumber(source.count) })}</span>
        <span>{t('newCount', { count: formatNumber(source.added) })}</span><span>{t('removedCount', { count: formatNumber(source.removed) })}</span>
        <span>{t('changedCount', { count: formatNumber(source.changed) })}</span>
      </div>
    </div>
    <form className="catalog-controls" onSubmit={event => { event.preventDefault(); apply({ ...filters, domain: domain.trim(), prefix: prefix.trim() }); }}>
      <label className="catalog-field catalog-grow">{t('domain')}<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.org" maxLength={255} /></label>
      <label className="catalog-field catalog-grow">{t('pathPrefix')}<input value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="/catalog/" maxLength={2000} /></label>
      <button className="button secondary">{t('search')}</button>
      <label className="catalog-field">{t('changes')}
        <FilterSelect value={filters.change} onChange={event => apply({ ...filters, change: event.target.value as CatalogChange })}>
          {changes.map(change => <option value={change} key={change}>{t(`change_${change}`)}</option>)}
        </FilterSelect>
      </label>
      <label className="catalog-field">{t('sort')}
        <FilterSelect value={filters.direction ?? 'asc'} onChange={event => apply({ ...filters, direction: event.target.value === 'desc' ? 'desc' : undefined })}>
          <option value="asc">{t('ascending')}</option><option value="desc">{t('descending')}</option>
        </FilterSelect>
      </label>
      <button type="button" className="button secondary" disabled={!draftChanged && query(filters) === query(unfiltered) && !cursors.length}
        onClick={() => { setDomain(''); setPrefix(''); apply(unfiltered); }}>{t('resetFilters')}</button>
    </form>
    <p><strong>{t('applied')}</strong> · {applied}</p>
    {draftChanged && <p role="status">{t('applyDraft')}</p>}
    {selected.size > 0 ? <p>{t('selectionScope', { count: formatNumber(selected.size) })}</p>
      : validLimit && <p>{t('filterScope', { count: formatNumber(number) })}</p>}
    <div className="catalog-controls catalog-actions">
      {selected.size ? <button className="text-button" onClick={() => setSelected(new Set())}>{t('clearSelection')}</button>
        : <label className="catalog-field catalog-limit">{t('limit')}
          <input value={limit} onChange={event => setLimit(event.target.value)} type="number" min="1" max="5000" />
        </label>}
      <button className="button primary" disabled={!canAct} onClick={() => act('check')}><Play size={14} /> {t('check')}</button>
      <button className="button secondary" disabled={!canAct} onClick={() => act('add')}><Plus size={15} /> {t('addToUrls')}</button>
      {!window.pulseDesktop && canExport
        ? <a className="button secondary" href={path + '/export' + query(filters)} download><Download size={15} /> {t('filteredCsv')}</a>
        : <button className="button secondary" disabled={!canExport} onClick={() => save(false)}><Download size={15} /> {t('filteredCsv')}</button>}
      {selected.size > 0 && <button className="button secondary" disabled={!canExport} onClick={() => save(true)}><Download size={15} /> {t('selectedCsv')}</button>}
    </div>
    <ErrorMessage text={page.error || task.error} />
    {page.error && <button type="button" className="button small secondary" onClick={page.reset}><RefreshCw size={15} /> {t('retry')}</button>}
    {feedback && <div className="catalog-feedback" role="status">{'runId' in feedback
      ? <>{t('queuedRun')} <button className="text-button" onClick={() => openRun(feedback.runId)}>{t('openReport')}</button></>
      : t('worklistAddition', { added: formatNumber(feedback.added), duplicates: formatNumber(feedback.duplicates) })}</div>}
    {!page.data && !page.error && <Loading />}
    {page.data && (rows.length ? <div className="table-scroll"><table className="data-table catalog-table">
      <thead><tr>
        <th className="check-cell"><input type="checkbox" aria-label={t('selectPage')} checked={allSelected} onChange={event => toggle(rows.map(row => row.url), event.target.checked)} /></th>
        <th scope="col">URL</th><th scope="col">{t('lastmod')}</th><th scope="col">{t('change')}</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.url} className={selected.has(row.url) ? 'highlight' : undefined}>
        <td className="check-cell"><input type="checkbox" aria-label={t('selectUrl', { url: row.url })} checked={selected.has(row.url)}
          disabled={selected.size === 5000 && !selected.has(row.url)} onChange={event => toggle([row.url], event.target.checked)} /></td>
        <td className="catalog-url" title={row.url}>{row.url}</td>
        <td>{row.lastmod ?? '—'}</td><td>{row.change ? t(`change_${row.change}`) : '—'}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><h3>{t('noMatches')}</h3></div>)}
    <div className="table-footer">
      <span>{t('page', { page: formatNumber(cursors.length + 1) })}</span><div className="catalog-buttons">
        <button className="button small secondary" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}><ChevronLeft size={15} /> {t('back')}</button>
        <button className="button small secondary" disabled={!page.data?.next} onClick={() => setCursors([...cursors, page.data!.next!])}>{t('next')} <ChevronRight size={15} /></button>
      </div>
    </div>
  </section>;
}
