import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeftRight, ArrowUpRight, Bell, CalendarClock, ChartNoAxesCombined, ChevronLeft, ChevronRight, Clock3, Download, History, Mail, Play, Search, Trash2 } from 'lucide-react';
import { reportChanges, reportParams, type ReportFilters, type ReportResult, type RunPage, type RunView, type StoppedRunResponse } from '../shared/reports.js';
import { canCompareRun } from '../shared/run-comparison.js';
import { isActiveRun, type NotificationPage, type Result, type Run } from '../shared/types.js';
import { RequestDetails } from './request-profiles.js';
import { api, base, localizedFailure, type AddressView, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { date, Empty, ErrorMessage, ExportLinks, FilterSelect, formatNumber, Loading, Modal, RunStatus, StartRunButton, Status, StopRunButton, type RunAccepted } from './ui.js';
import { reportsMessages } from '../shared/i18n/locales/reports.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createMessages, currentLocale } from './i18n.js';

const useText = createMessages('reports', reportsMessages);

const PAGE = 100;

export function RunList({ projectId, groupId, revision, open, openComparison }: {
  projectId: number; groupId?: number; revision: number; open: (id: number) => void; openComparison: () => void;
}) {
  const t = useText();
  const [cursors, setCursors] = useState<number[]>([]);
  const [exportId, setExportId] = useState<number>();
  const before = cursors.at(-1);
  const path = base(projectId) + (groupId === undefined ? '/runs?view=page' : `/groups/${groupId}/runs?view=page`)
    + (before === undefined ? '' : '&before=' + before);
  const { data, error, refresh } = useQuery<RunPage>(path, 2400);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (revision !== lastRevision.current) refresh();
    lastRevision.current = revision;
  }, [revision, refresh]);
  useEffect(() => {
    if (data?.items.length === 0) setCursors(previous => previous.length ? previous.slice(0, -1) : previous);
  }, [data]);
  const runs = data?.items ?? [];
  const next = data?.nextBefore;
  const groupHistory = groupId !== undefined;
  return <section className={groupHistory ? 'panel group-history' : 'panel'} aria-label={groupHistory ? t('groupRuns') : undefined}>
    <div className="panel-heading comparison-journal-heading"><div><h2>{groupHistory ? t('groupRuns') : t('runHistory')}</h2>
      {!groupHistory && <p>{t('historyDescription')}</p>}</div>
      <button type="button" className="button secondary" id="open-runs-comparison" onClick={() => openComparison()}>
        <ArrowLeftRight size={16} aria-hidden="true" /> {t('compareRuns')}
      </button>
    </div>
    <ErrorMessage text={error} />
    {!data && !error && <Loading />}
    {runs.length > 0 &&
      <div className="table-scroll">
        <table className="data-table run-table">
          <thead><tr><th>{t('run')}</th><th>{t('status')}</th><th>{t('checked')}</th><th>{t('available')}</th><th>{t('failed')}</th><th><span className="sr-only">{t('report')}</span></th></tr></thead>
          <tbody>{runs.map(run => <tr key={run.id}>
            <td><div className="run-name"><span className="run-icon">{run.source === 'schedule' ? <CalendarClock size={16} /> : <Play size={15} />}</span>
              <div><strong>{t('runId', { id: run.id })} · {date(run.createdAt)}</strong>
                <small>{run.group ? run.group.name : run.source === 'schedule' ? t('scheduled') : t('manual')}</small></div></div></td>
            <td><RunStatus run={run} /></td><td>{formatNumber(run.completed)} / {formatNumber(run.total)}</td><td className="text-green">{formatNumber(run.available)}</td>
            <td className={run.failures ? 'text-red' : ''}>{formatNumber(run.failures)}</td>
            <td className="actions-cell"><div className="row-actions">
              <button className="button small secondary" onClick={() => open(run.id)}>{t('openReport')} <ArrowUpRight size={14} /></button>
              <button className="button icon secondary" aria-label={t('exportRunId', { id: run.id })} title={t('exportRun')}
                disabled={!run.completed} onClick={() => setExportId(run.id)}><Download size={15} /></button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
    {data?.items.length === 0 && cursors.length === 0 && <Empty icon={<ChartNoAxesCombined size={26} />} title={t('emptyRuns')}
      text={groupHistory ? t('emptyGroupRunsHint') : t('emptyRunsHint')} />}
    {(!data || runs.length > 0 || cursors.length > 0) &&
      <div className="table-footer">
        <span>{data && t('runsShown', { count: formatNumber(runs.length) })}</span>
        <nav className="pagination" aria-label={t('runPages')}>
          <button type="button" className="button icon secondary" aria-label={t('previousPage')} disabled={!cursors.length}
            onClick={() => setCursors(cursors.slice(0, -1))}><ChevronLeft size={16} /></button>
          <span aria-live="polite">{t('page', { page: formatNumber(cursors.length + 1) })}</span>
          <button type="button" className="button icon secondary" aria-label={t('nextPage')} disabled={next == null}
            onClick={() => { if (next != null) setCursors([...cursors, next]); }}><ChevronRight size={16} /></button>
        </nav>
      </div>}
    {exportId !== undefined && <Modal title={t('exportRunId', { id: exportId })} close={() => setExportId(undefined)}>
      <div className="modal-body"><ExportLinks path={`${base(projectId)}/runs/${exportId}`} /></div>
    </Modal>}
  </section>;
}

function ResultItems({ results, showAddress }: { results: (Result & Partial<Pick<ReportResult, 'change' | 'previousHttpCode' | 'previousFinalUrl'>>)[]; showAddress?: (id: number) => void }) {
  const t = useText();
  return <div className="result-list">{results.map(result => <details key={result.id} className="result">
    <summary>
      <ChevronRight className="result-chevron" size={16} />
      <span className="result-name"><strong>{result.url}</strong><small>{result.label && `${result.label} · `}{result.checkedAt ? date(result.checkedAt) : t('waiting')}
        {result.change && ` · ${t(`change_${result.change}`)}`}</small></span>
      <Status result={result} />
      <span className="mono result-code">{result.httpCode ?? '—'}</span>
      <span className="result-time">{result.durationMs === null ? '—' : t('duration', { value: formatNumber(result.durationMs) })}</span>
    </summary>
    <div className="result-details">
      {result.change && <p className={result.change === 'regression' ? 'text-red' : result.change === 'recovered' ? 'text-green' : 'muted'}>
        {t('resultChange', { change: t(`change_${result.change}`), http: result.previousHttpCode ?? '—' })}
      </p>}
      {result.change && result.previousFinalUrl && result.previousFinalUrl !== result.finalUrl &&
        <p className="report-prior-url">{t('previousFinalUrl', { url: result.previousFinalUrl })}</p>}
      {result.accessHint === 'curator-challenge' && <p className="status waiting">
        {t(result.finalUrl?.startsWith('https:') ? 'curatorWithTls' : 'curator')}
      </p>}
      {result.error && !result.accessHint && <ErrorMessage
        text={translateDiagnostic(result.error, currentLocale()) + (result.tlsCode ? ` (${result.tlsCode})` : '')} />}
      <dl>
        <div><dt>{t('finalUrl')}</dt><dd>{result.finalUrl ?? '—'}</dd></div>
        <div><dt>{t('redirects')}</dt><dd>{result.redirects ?? '—'}</dd></div>
        <div><dt>Content-Type</dt><dd>{result.contentType ?? '—'}</dd></div>
        <div><dt>Content-Length</dt><dd>{result.contentLength ? t('bytes', { value: result.contentLength }) : '—'}</dd></div>
        <RequestDetails result={result} />
      </dl>
      {showAddress && <button className="button small secondary" onClick={() => showAddress(result.urlId)}
        aria-label={t('urlHistoryFor', { url: result.url })}><History size={15} /> {t('urlHistoryAction')}</button>}
    </div>
  </details>)}</div>;
}

const pollReport = (data?: RunView) => data && isActiveRun(data.run) ? 1400 : 0;
const emptyFilters: ReportFilters = {};

function RunFilters({ applied, comparable, apply, searchRef }: {
  applied: ReportFilters; comparable: boolean; apply: (filters: ReportFilters) => void; searchRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useText();
  const [draft, setDraft] = useState(applied);
  useEffect(() => setDraft(applied), [applied]);
  function submit(next: ReportFilters) {
    setDraft(next);
    apply(next);
    searchRef.current?.focus();
  }
  return <form className="report-filters" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const status = form.get('status');
    const change = form.get('change');
    const httpCode = form.get('httpCode');
    submit({ q: String(form.get('q') ?? '').trim() || undefined,
      status: status === 'ok' || status === 'error' ? status : undefined,
      httpCode: httpCode ? Number(httpCode) : undefined,
      change: typeof change === 'string' && Object.hasOwn(reportChanges, change) ? change as ReportFilters['change'] : undefined });
  }}>
    <label className="report-search">{t('urlOrName')}
      <input ref={searchRef} type="search" name="q" maxLength={512} value={draft.q ?? ''} placeholder={t('searchReport')}
        onChange={event => setDraft({ ...draft, q: event.target.value })} />
    </label>
    <label>{t('status')}<FilterSelect name="status" value={draft.status ?? ''}
      onChange={event => setDraft({ ...draft, status: (event.target.value || undefined) as ReportFilters['status'] })}>
      <option value="">{t('allStatuses')}</option><option value="ok">{t('availableFilter')}</option><option value="error">{t('failed')}</option>
    </FilterSelect></label>
    <label>{t('httpCode')}<input name="httpCode" type="number" min={100} max={599} placeholder="503" value={draft.httpCode ?? ''}
      onChange={event => setDraft({ ...draft, httpCode: event.target.value ? Number(event.target.value) : undefined })} /></label>
    {comparable && <label>{t('change')}<FilterSelect name="change" value={draft.change ?? ''}
      onChange={event => setDraft({ ...draft, change: (event.target.value || undefined) as ReportFilters['change'] })}>
      <option value="">{t('allResults')}</option>
      {Object.keys(reportChanges).map(key => <option key={key} value={key}>{t(`change_${key as keyof typeof reportChanges}`)}</option>)}
    </FilterSelect></label>}
    <div className="report-filter-actions">
      <button className="button small primary" type="submit"><Search size={15} /> {t('search')}</button>
      {reportParams(applied).size > 0 && <button type="button" className="button small secondary"
        onClick={() => submit(emptyFilters)}>{t('resetFilters')}</button>}
    </div>
  </form>;
}

export function RunReport({ projectId, runId, close, deleted, stopped, changed, accepted, openReport, openComparison, filters = emptyFilters,
  applyFilters, goToJournal, fallbackFocus }: {
  projectId: number; runId: number; close: () => void; deleted: () => void; stopped: (run: StoppedRunResponse) => void; changed: () => void;
  accepted: RunAccepted; openReport: (id: number) => void; filters?: ReportFilters; applyFilters: (filters: ReportFilters) => void;
  openComparison: (baseline: number | undefined, target: number) => void;
  goToJournal: () => void; fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useText();
  const path = `${base(projectId)}/runs/${runId}`;
  const [cursors, setCursors] = useState<number[]>([]);
  const [historyUrlId, setHistoryUrlId] = useState<number>();
  const searchRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastMeta, setLastMeta] = useState<Pick<RunView, 'run' | 'previousRun' | 'restart'>>();
  const params = reportParams(filters);
  const filterKey = params.toString();
  if (cursors.length) params.set('after', String(cursors.at(-1)));
  const query = useQuery<RunView>(path + '?' + params, pollReport);
  const missing = query.status === 404;
  const data = missing ? undefined : query.data;
  const meta = missing ? undefined : data ?? lastMeta;
  useEffect(() => {
    if (!data) return;
    setLastMeta({ run: data.run, previousRun: data.previousRun, restart: data.restart });
    if (data.run.status === 'cancelled' && !data.results.length) {
      setCursors(previous => previous.length ? [] : previous);
    }
  }, [data]);

  const active = meta && isActiveRun(meta.run);
  return <><Modal title={t('reportId', { id: runId })} caption={meta && date(meta.run.createdAt)} close={close} wide fallbackFocus={fallbackFocus}
    headerAction={active ? <StopRunButton run={meta.run} stopped={run => { query.refresh(); stopped(run); }} />
      : meta?.restart && <StartRunButton projectId={projectId} restart={meta.restart} accepted={accepted} openReport={openReport} />}>
    <div className="modal-body">
      {missing ? <Empty icon={<History size={23} />} title={t('reportMissing')} text={t('reportMissingHint')}
        action={<button className="button secondary" onClick={goToJournal}>{t('goToRunHistory')}</button>} />
        : query.error && <><ErrorMessage text={query.error} />
          <button className="button small secondary query-retry" onClick={query.refresh}>{t('retry')}</button></>}
      {meta && <>
        <div className="report-meta"><RunStatus run={meta.run} />
          {meta.run.group && <span>{t('group')} <strong>{meta.run.group.name}</strong></span>}
          <span>{t('checked')} <strong>{t('countOfTotal', { count: formatNumber(meta.run.completed), total: formatNumber(meta.run.total) })}</strong></span>
          <span className="text-green">{t('availableCount', { count: formatNumber(meta.run.available) })}</span>
          <span className="text-red">{t('failedCount', { count: formatNumber(meta.run.failures) })}</span>
          {meta.run.total > meta.run.completed && <span>{t(meta.run.status === 'cancelled' ? 'notChecked' : 'queued', { count: formatNumber(meta.run.total - meta.run.completed) })}</span>}
        </div>
        {meta.restart && <p className="field-note report-baseline">{meta.restart.canRestart
          ? t('restartHint')
          : t('restartMissing')}</p>}
        {meta.previousRun && <p className="field-note report-baseline">
          {t('previousRun', { id: meta.previousRun.id, date: date(meta.previousRun.createdAt) })}
        </p>}
        <RunFilters applied={filters} comparable={!!meta.previousRun} searchRef={searchRef}
          apply={next => {
            if (query.error && reportParams(next).toString() === filterKey && !cursors.length) query.refresh();
            applyFilters(next);
            setCursors([]);
          }} />
      </>}
      {!data && !query.error && <Loading />}
      {data && (data.results.length ? <ResultItems results={data.results} showAddress={setHistoryUrlId} />
        : data.run.status === 'cancelled' && !data.run.completed ? <p className="muted">{t('stoppedEmpty')}</p>
          : <Empty icon={<Search size={23} />} title={t('noResults')} text={t('noResultsHint')} />)}
      {(cursors.length > 0 || data?.nextAfter) && <div className="report-pages">
        <span>{t('page', { page: formatNumber(cursors.length + 1) })}</span>
        <button className="button small secondary" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>
          <ChevronLeft size={15} /> {t('back')}
        </button>
        <button className="button small secondary" disabled={!data?.nextAfter}
          onClick={() => setCursors([...cursors, data!.nextAfter!])}>{t('next')} <ChevronRight size={15} /></button>
      </div>}
    </div>
    {meta && <div className="modal-footer report-footer">
      {canCompareRun(meta.run) && <button type="button" className="button small secondary" id="open-report-comparison"
        onClick={() => openComparison(meta.previousRun?.id, meta.run.id)}>
        <ArrowLeftRight size={15} aria-hidden="true" /> {t('compareAnother')}
      </button>}
      {!active && <button className="button small ghost danger-ghost" onClick={() => setConfirmDelete(true)}>
        <Trash2 size={15} /> {t('deleteReport')}
      </button>}
      <div className="report-exports"><span>{filterKey ? t('exportFiltered') : t('exportChecked')}</span>
        <ExportLinks path={path} filters={filters} /></div>
    </div>}
  </Modal>
  {confirmDelete && <ConfirmDeletion title={t('deleteReportTitle')} label={t('deleteReport')}
    close={() => setConfirmDelete(false)} confirm={async () => {
      await api(path, { method: 'DELETE' });
      setConfirmDelete(false);
      deleted();
    }}>
    <p>{t('deleteReportDescription')}</p>
  </ConfirmDeletion>}
  {historyUrlId !== undefined && <AddressReport projectId={projectId} urlId={historyUrlId}
    close={() => setHistoryUrlId(undefined)} fallbackFocus={() => searchRef.current} changed={changed} />}
  </>;
}

function browserUrl(value: string) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid saved target. */ }
}

type HistoryTail = { cursor: number; pages: number; results: Result[]; complete: boolean; error?: unknown };

export function AddressReport({ projectId, urlId, close, fallbackFocus, changed, check, revision }: {
  projectId: number; urlId: number; close: () => void; fallbackFocus?: () => HTMLElement | null; changed: () => void;
  check?: { accepted: RunAccepted; openReport: (id: number) => void };
  revision?: string;
}) {
  const t = useText();
  const path = `${base(projectId)}/urls/${urlId}`;
  const query = useQuery<AddressView>(path);
  const refresh = query.refresh;
  const lastRevision = useRef(revision);
  const [followRun, setFollowRun] = useState<number>();
  const runQuery = useQuery<RunView>(followRun === undefined ? null : `${base(projectId)}/runs/${followRun}`, pollReport);
  const [pages, setPages] = useState(1);
  const [tail, setTail] = useState<HistoryTail>();
  const tailRef = useRef(tail);
  const [retry, setRetry] = useState(0);
  const task = useTask();
  const data = query.data;
  const url = data && browserUrl(data.address.url);
  const head = data?.history;
  const cursor = head?.length === PAGE ? head.at(-1) : undefined;
  const hasTail = !!cursor && pages > 1;
  const shown = cursor?.id === tail?.cursor ? tail : undefined;
  const shownIds = new Set(head?.map(result => result.id));
  const results = [...(head ?? []), ...((hasTail ? tail?.results : undefined) ?? []).filter(result => !shownIds.has(result.id))];
  const tailLoading = hasTail && !shown?.error && !shown?.complete && (shown?.pages ?? 1) < pages;

  useEffect(() => {
    if (lastRevision.current !== revision) refresh();
    lastRevision.current = revision;
  }, [revision, refresh]);
  useEffect(() => {
    if (runQuery.data && !isActiveRun(runQuery.data.run)) {
      setFollowRun(undefined);
      refresh();
    }
  }, [runQuery.data, refresh]);
  useEffect(() => {
    if (!cursor || pages <= 1) return;
    const abort = new AbortController();
    const previous = tailRef.current?.cursor === cursor.id ? tailRef.current : undefined;
    let snapshot: HistoryTail = previous ?? { cursor: cursor.id, pages: 1, results: [], complete: false };
    function save(next: HistoryTail) {
      if (abort.signal.aborted) return;
      tailRef.current = next;
      setTail(next);
    }
    void (async () => {
      try {
        while (!snapshot.complete && snapshot.pages < pages) {
          const before = snapshot.results.at(-1) ?? cursor;
          const params = new URLSearchParams({ before: String(before.id) });
          if (before.checkedAt) params.set('beforeAt', before.checkedAt);
          const response = await api<AddressView>(path + '?' + params, { signal: abort.signal });
          snapshot = { cursor: cursor.id, pages: snapshot.pages + 1, results: [...snapshot.results, ...response.history],
            complete: response.history.length < PAGE };
        }
        save(snapshot);
      } catch (error) {
        save({ ...snapshot, error });
      }
    })();
    return () => abort.abort();
  }, [path, cursor?.id, pages, retry]);

  return <Modal title={data?.address.label || t('urlHistory')} caption={data?.address.url} close={close} wide fallbackFocus={fallbackFocus}
    headerAction={check && data && !data.address.removedAt &&
      <StartRunButton key={data.address.version} projectId={projectId} addressId={urlId} accepted={(id, run) => {
        setFollowRun(run);
        check.accepted(id, run);
      }} openReport={check.openReport} />}>
    <div className="modal-body">
      {(query.error || runQuery.error || !!shown?.error) && <>
        <ErrorMessage text={query.error || runQuery.error || (shown?.error ? localizedFailure(shown.error, currentLocale()) : undefined)} />
        <button className="button small secondary query-retry" onClick={() => {
          if (query.error) refresh();
          if (runQuery.error) runQuery.refresh();
          if (shown?.error) setRetry(value => value + 1);
        }}>{t('retry')}</button>
      </>}
      {!data && !query.error && <Loading />}
      {data && <>
        <div className="report-meta" role="status" aria-label={t('currentUrlVersion')}>
          <Status result={data.address.latest} />
          {data.address.latest?.httpCode != null && <span>HTTP {data.address.latest.httpCode}</span>}
          {data.address.latest?.checkedAt && <span>{date(data.address.latest.checkedAt)}</span>}
        </div>
        {data.address.removedAt && <div className="removed-address">
          <p className="field-note">{t('removedAt', { date: date(data.address.removedAt) })}</p>
          <button type="button" className="button small secondary" disabled={task.busy} onClick={() => void task.run(async () => {
            await api(path + '/restore', { method: 'POST' });
            query.refresh();
            changed();
          })}>{t('restoreUrl')}</button>
        </div>}
        {data.versions.length > 1 && <details className="versions">
          <summary>{t('versions', { count: formatNumber(data.versions.length) })}</summary>
          <ul>{data.versions.map(version => <li key={version.version}>
            <span>{version.url}</span><small>{date(version.createdAt)}</small>
          </li>)}</ul>
        </details>}
        {results.length ? <ResultItems results={results} />
          : <Empty icon={<Clock3 size={24} />} title={t('urlNeverChecked')} text={t('urlNeverCheckedHint')} />}
        {!!cursor && !shown?.complete && <button type="button" className="button small secondary show-more"
          disabled={tailLoading || !!shown?.error} onClick={() => setPages(value => value + 1)}>
          {tailLoading ? t('loadingHistory') : t('loadMore')}</button>}
        <ErrorMessage text={task.error} />
      </>}
    </div>
    {data && <div className="modal-footer report-footer">
      {url && (window.pulseDesktop ? <button type="button" className="button secondary" disabled={task.busy}
        onClick={() => void task.run(() => window.pulseDesktop!.openAddress(projectId, urlId))}>
        {t('openInBrowser')} <ArrowUpRight size={15} />
      </button> : <a className="button secondary" href={url} target="_blank" rel="noopener noreferrer">
        {t('openInBrowser')} <ArrowUpRight size={15} />
      </a>)}
      <div className="report-exports"><span>{t('exportUrlHistory')}</span><ExportLinks path={path} /></div>
    </div>}
  </Modal>;
}

export function Notifications({ smtpConfigured, unread, cursors, updateCursors, changed, open }: {
  smtpConfigured?: boolean; unread: number; cursors: number[]; updateCursors: (cursors: number[], replace?: boolean) => void;
  changed: () => void; open: (projectId: number, runId: number, notificationId: number) => void;
}) {
  const t = useText();
  const path = '/api/notifications';
  const before = cursors.at(-1);
  const query = useQuery<NotificationPage>(path + '?view=page' + (before === undefined ? '' : '&before=' + before), 3000);
  const notifications = query.data?.items ?? [];
  const next = query.data?.nextBefore;
  const [confirmClear, setConfirmClear] = useState(false);
  const task = useTask();
  useEffect(() => {
    if (query.data?.items.length === 0 && cursors.length) updateCursors(cursors.slice(0, -1), true);
  }, [query.data, cursors, updateCursors]);
  return <section className="panel notification-panel">
    <div className="panel-heading"><div><h2>{t('runResults')}</h2><p>{t('notificationsDescription')}</p></div>
      <div className="notification-actions">
      {unread > 0 && <button className="button secondary" disabled={task.busy}
        onClick={() => void task.run(async () => {
          await write(path + '/read', 'POST', {});
          query.refresh();
          changed();
        })}>{t('markAllRead')}</button>}
      {notifications.length > 0 && <button className="button secondary danger-ghost" onClick={() => setConfirmClear(true)} disabled={task.busy}>
        <Trash2 size={15} /> {t('clearNotifications')}
      </button>}
      </div>
    </div>
    {confirmClear && <ConfirmDeletion title={t('clearNotificationsTitle')} label={t('clearNotifications')}
      close={() => setConfirmClear(false)} confirm={async () => {
        await write(path + '/clear', 'POST', {});
        updateCursors([], true);
        query.reset();
        setConfirmClear(false);
        changed();
      }}>
      <p>{t('clearNotificationsDescription')}</p>
    </ConfirmDeletion>}
    <ErrorMessage text={query.error || task.error} />
    {!query.data && !query.error && <Loading />}
    {notifications.length > 0 &&
      <div className="notifications-list">{notifications.map(entry => <article key={entry.id} className={!entry.readAt ? 'unread' : ''}>
        <span className={entry.failures ? 'section-icon orange' : 'section-icon green'}><Bell size={18} /></span>
        <div className="notification-content">
          <strong>{t('notificationTitle', { name: entry.projectName, id: entry.runId })}</strong>
          <small>{date(entry.createdAt)}{!entry.readAt && <span className="unread-dot" title={t('unread')} />}</small>
          <p>{t('notificationResult', { available: formatNumber(entry.available), total: formatNumber(entry.total), failed: formatNumber(entry.failures) })}</p>
          {entry.delivery !== 'disabled' && <span className={'status ' + (entry.delivery === 'failed' ? 'bad' :
            entry.delivery === 'uncertain' ? 'waiting' : entry.delivery === 'sent' ? 'ok' : 'neutral')}>
            <Mail size={13} />
            {entry.delivery === 'pending' && smtpConfigured === false ? t('smtpPending') : t(`delivery_${entry.delivery}`)}
            {entry.deliveryError && ` · ${translateDiagnostic(entry.deliveryError, currentLocale())}`}
          </span>}
          {entry.delivery !== 'disabled' && entry.attempts > 0 && <small>{t('deliveryAttempts', { count: formatNumber(entry.attempts) })}</small>}
        </div>
        <button id={`notification-report-${entry.id}`} className="button small secondary" onClick={() => {
          if (!entry.readAt) void task.run(async () => {
            await write(`${path}/${entry.id}/read`, 'POST', {});
            query.refresh();
            changed();
          });
          open(entry.projectId, entry.runId, entry.id);
        }}>
          {t('openReport')} <ArrowUpRight size={14} />
        </button>
      </article>)}</div>}
    {query.data?.items.length === 0 && cursors.length === 0 &&
      <Empty icon={<Bell size={25} />} title={t('noNotifications')} text={t('noNotificationsHint')} />}
    {(notifications.length > 0 || cursors.length > 0) && <div className="table-footer">
      <span>{query.data && t('notificationsShown', { count: formatNumber(notifications.length) })}</span>
      <nav className="pagination" aria-label={t('notificationPages')}>
        <button type="button" className="button icon secondary" aria-label={t('previousPage')} disabled={!cursors.length}
          onClick={() => updateCursors(cursors.slice(0, -1))}><ChevronLeft size={16} /></button>
        <span aria-live="polite">{t('page', { page: formatNumber(cursors.length + 1) })}</span>
        <button type="button" className="button icon secondary" aria-label={t('nextPage')} disabled={next == null}
          onClick={() => { if (next != null) updateCursors([...cursors, next]); }}><ChevronRight size={16} /></button>
      </nav>
    </div>}
  </section>;
}
