import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { RunPage } from '../shared/reports.js';
import {
  comparisonFlags, comparisonParams, type ComparisonFlag, type ComparisonInput, type ComparisonKind,
  type ComparisonPage, type ComparisonRow, type ComparisonSide, type ComparisonSummary,
} from '../shared/run-comparison.js';
import type { Run } from '../shared/types.js';
import { base, useQuery, useTask } from './api.js';
import { RequestDetails } from './request-profiles.js';
import { date, Empty, ErrorMessage, useExportOptions, FilterSelect, formatNumber, Loading, Modal, RunStatus, Status } from './ui.js';
import { createTranslator } from '../shared/i18n/index.js';
import { comparisonMessages } from '../shared/i18n/locales/comparison.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createMessages, currentLocale, LocalizedError, useLanguage } from './i18n.js';

const useText = createMessages('comparison', comparisonMessages);

type Side = 'baseline' | 'target';
const flagKinds = Object.keys(comparisonFlags) as ComparisonFlag[];
const filters: ComparisonKind[] = ['differences', 'all', 'same', ...flagKinds];

function RunChoiceDetails({ run }: { run: Run }) {
  const t = useText();
  return <div className="comparison-run-meta">
    <RunStatus run={run} />
    <span>{run.source === 'schedule' ? t('scheduled') : t('manual')}</span>
    {run.group && <span>{t('group', { name: run.group.name })}</span>}
    <span>{t('checkedCount', { count: formatNumber(run.completed), total: formatNumber(run.total) })}</span>
  </div>;
}

function RunPicker({ projectId, side, opposite, choose, close }: {
  projectId: number; side: Side; opposite?: number; choose: (run: Run) => void; close: () => void;
}) {
  const t = useText();
  const [cursors, setCursors] = useState<number[]>([]);
  const path = base(projectId) + '/runs?view=compare-options';
  const query = useQuery<RunPage>(path + (cursors.length ? '&before=' + cursors.at(-1) : ''));
  const next = query.data?.nextBefore;
  const descriptions = useId();
  return <Modal title={t('pickerTitle', { side: t(side) })} close={close}>
    <div className="modal-body">
      {query.error && <><ErrorMessage text={query.error} />
        <button className="button small secondary" onClick={query.refresh}>{t('retry')}</button></>}
      {!query.data && !query.error && <Loading />}
      {query.data?.items.length === 0 && <p className="muted">{t('emptyRunPage')}</p>}
      {!!query.data?.items.length && <ul className="comparison-picker">
        {query.data.items.map(run => <li key={run.id}>
          <div>
            <strong>{t('runId', { id: run.id })} · {date(run.createdAt)}</strong>
            <div id={`${descriptions}-${run.id}`}><RunChoiceDetails run={run} /></div>
          </div>
          <button type="button" className="button small secondary" disabled={run.id === opposite}
            aria-label={t('selectRunId', { id: run.id })} aria-describedby={`${descriptions}-${run.id}`}
            onClick={() => choose(run)}>{run.id === opposite ? t('selected') : t('select')}</button>
        </li>)}
      </ul>}
      {(cursors.length > 0 || next != null) && <nav className="pagination report-pages" aria-label={t('runPickerPages')}>
        <button type="button" className="button icon secondary" aria-label={t('previousPage')} disabled={!cursors.length}
          onClick={() => setCursors(cursors.slice(0, -1))}><ChevronLeft size={15} aria-hidden="true" /></button>
        <span aria-live="polite">{t('page', { page: formatNumber(cursors.length + 1) })}</span>
        <button type="button" className="button icon secondary" aria-label={t('nextPage')} disabled={next == null}
          onClick={() => { if (next != null) setCursors([...cursors, next]); }}><ChevronRight size={15} aria-hidden="true" /></button>
      </nav>}
    </div>
  </Modal>;
}

function CoverageValue({ side }: { side: ComparisonSide }) {
  const t = useText();
  if (side.state === 'checked') return <>
    <Status result={side.result} />
    <span className="comparison-response">
      {side.result.httpCode != null && <span>HTTP {side.result.httpCode}</span>}
      {side.result.durationMs != null && <span>{t('duration', { value: formatNumber(side.result.durationMs) })}</span>}
    </span>
  </>;
  if (side.state === 'unchecked') return <span className="muted">{t('unchecked')}</span>;
  return <span className="muted">{side.state === 'unknown' ? t('unknownCoverage') : t('absent')}</span>;
}

function sideAddress(side: ComparisonSide) {
  return side.state === 'checked' ? side.result : side.state === 'unchecked' ? side : null;
}

function SideDetails({ side, title }: { side: ComparisonSide; title: string }) {
  const t = useText();
  const address = sideAddress(side);
  return <div className="comparison-side-details">
    <strong>{title}</strong>
    {address && <dl>
      <div><dt>{t('checkedUrl')}</dt><dd>{address.url}</dd></div>
      <div><dt>{t('urlVersion')}</dt><dd>{address.version}</dd></div>
      {side.state === 'checked' && <>
        <div><dt>{t('checkedAt')}</dt><dd>{date(side.result.checkedAt)}</dd></div>
        <div><dt>{t('finalUrl')}</dt><dd>{side.result.finalUrl ?? '—'}</dd></div>
        {side.result.error && <div><dt>{t('errorReason')}</dt><dd>{translateDiagnostic(side.result.error, currentLocale())}</dd></div>}
        {side.result.tlsCode && <div><dt>{t('tlsCode')}</dt><dd>{side.result.tlsCode}</dd></div>}
        <RequestDetails result={side.result} />
      </>}
    </dl>}
    {side.state !== 'checked' && <CoverageValue side={side} />}
  </div>;
}

function ComparisonRows({ rows }: { rows: ComparisonRow[] }) {
  const t = useText();
  const [expanded, setExpanded] = useState<number>();
  const details = useId();
  return <table className="data-table comparison-table" aria-label={t('resultTable')}>
    <thead><tr><th scope="col">{t('urlAndChanges')}</th><th scope="col">{t('baseline')}</th><th scope="col">{t('target')}</th></tr></thead>
    <tbody>{rows.map(row => {
      const before = sideAddress(row.baseline);
      const after = sideAddress(row.target);
      const primary = after ?? before;
      const differentAddress = before && after && before.url !== after.url;
      const open = expanded === row.urlId;
      const delta = row.durationDeltaMs;
      return <Fragment key={row.urlId}>
        <tr className="comparison-row">
          <td>
            <strong>{differentAddress ? before.url : primary?.url}</strong>
            {differentAddress && <strong>→ {after.url}</strong>}
            {primary?.label && <span className="muted">{primary.label}</span>}
            <div className="comparison-tags">
              {row.flags.map(flag => <span key={flag}>{t(`filter_${flag}`)}</span>)}
              {delta != null && <span>{t('durationDelta', { value: (delta > 0 ? '+' : '') + formatNumber(delta) })}</span>}
            </div>
            <button type="button" className="text-button comparison-details-toggle" aria-expanded={open}
              aria-controls={open ? `${details}-${row.urlId}` : undefined}
              onClick={() => setExpanded(open ? undefined : row.urlId)}>{t('details')}</button>
          </td>
          <td><CoverageValue side={row.baseline} /></td>
          <td><CoverageValue side={row.target} /></td>
        </tr>
        {open && <tr className="comparison-details"><td colSpan={3} id={`${details}-${row.urlId}`}>
          <div className="comparison-details-grid">
            <SideDetails side={row.baseline} title={t('baseline')} />
            <SideDetails side={row.target} title={t('target')} />
          </div>
        </td></tr>}
      </Fragment>;
    })}</tbody>
  </table>;
}

function ComparisonExport({ projectId, input, invalidate }: { projectId: number; input: ComparisonInput; invalidate: () => void }) {
  const t = useText();
  const bridge = window.pulseDesktop;
  const locale = useLanguage();
  const exportOptions = useExportOptions();
  const task = useTask();
  const [saved, setSaved] = useState(false);
  const pending = useRef<AbortController>(undefined);
  useEffect(() => () => pending.current?.abort(), []);

  async function startDownload(href: string) {
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch(href, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
      if (response.status === 404 || response.status === 409) {
        invalidate();
        return;
      }
      if (!response.ok) throw new LocalizedError(locale => createTranslator(locale, 'comparison', comparisonMessages)('exportFailed'));
      const download = document.createElement('a');
      download.href = href;
      download.download = '';
      download.click();
    } finally { pending.current = undefined; }
  }

  return <div className="comparison-export">
    <span>{t('filteredExport')}</span>
    <div className="export-links" role="group" aria-label={t('exportFormats')}>
      {exportOptions.map(({ format, label }) => {
        const params = comparisonParams(input);
        params.set('format', format);
        if (format === 'excel') params.set('locale', locale);
        const href = `${base(projectId)}/run-comparison/export?${params}`;
        return bridge
          ? <button key={format} type="button" className="button small secondary" disabled={task.busy} onClick={() => {
            setSaved(false);
            void task.run(async () => {
              const result = await bridge.exportComparison(projectId, input, format, format === 'excel' ? locale : undefined);
              if (result.saved) setSaved(true);
              else if (result.error) throw new Error(result.error);
            });
          }}>{label}</button>
          : <a key={format} className="button small secondary" href={href} download="" aria-disabled={task.busy || undefined}
            onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (!pending.current) void task.run(() => startDownload(href));
            }}>{label}</a>;
      })}
    </div>
    {saved && <span role="status">{t('saved')}</span>}
    <ErrorMessage text={task.error} />
  </div>;
}

const swappedKinds: Partial<Record<ComparisonKind, ComparisonKind>> = {
  regression: 'recovered', recovered: 'regression', baselineOnly: 'targetOnly', targetOnly: 'baselineOnly', slower: 'differences',
};

export function RunComparison({ projectId, selection, change, close, fallbackFocus }: {
  projectId: number; selection: Partial<ComparisonInput>; change: (selection: Partial<ComparisonInput>) => void;
  close: () => void; fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useText();
  const { baseline, target, q, kind } = selection;
  const currentKind = kind ?? 'differences';
  const [draft, setDraft] = useState(q ?? '');
  const [cursors, setCursors] = useState<number[]>([]);
  const [picker, setPicker] = useState<Side>();
  const [choices, setChoices] = useState<Partial<Record<Side, Run>>>({});
  const search = useRef<HTMLInputElement>(null);
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  const input = baseline !== undefined && target !== undefined && baseline !== target ? { baseline, target, q, kind } : undefined;
  const key = input ? comparisonParams(input).toString() : '';
  const path = base(projectId) + '/run-comparison';
  const [pageKey, setPageKey] = useState(key);
  const currentPage = pageKey === key ? cursors : [];
  const query = useQuery<ComparisonPage>(input ? `${path}?${key}${currentPage.length ? '&after=' + currentPage.at(-1) : ''}` : null);
  const overview = useQuery<ComparisonSummary>(input ? `${path}?baseline=${baseline}&target=${target}&view=summary` : null);
  const summary = overview.data;
  const next = query.data?.nextAfter;
  const invalidPair = [overview.status, query.status].some(status => status === 404 || status === 409);
  const error = overview.error || query.error;

  useEffect(() => setDraft(q ?? ''), [q]);
  function apply(next: Partial<ComparisonInput>) {
    setCursors([]);
    change(next);
  }
  function paginate(page: number[]) {
    setPageKey(key);
    setCursors(page);
    resultsTitle.current?.focus();
  }
  function choose(run: Run) {
    if (!picker) return;
    setChoices({ ...choices, [picker]: run });
    apply({ ...selection, [picker]: run.id });
    setPicker(undefined);
  }

  return <>
    <Modal title={t('title')} wide close={close} fallbackFocus={fallbackFocus}>
      <div className="modal-body comparison-body">
        <div className="comparison-pair">
          {(['baseline', 'target'] as const).map(side => {
            const id = selection[side];
            const remembered = choices[side];
            const run = summary?.[side] ?? (remembered?.id === id ? remembered : undefined);
            return <section key={side} className={`comparison-run comparison-${side}`} aria-label={t(side)}>
              <h3>{t(side)}</h3>
              {id !== undefined && <strong>{t('runId', { id })}{run && ` · ${date(run.createdAt)}`}</strong>}
              {run && <RunChoiceDetails run={run} />}
              <button type="button" className="button small secondary" onClick={() => setPicker(side)}
                data-initial-focus={(baseline === undefined ? side === 'baseline' : target === undefined && side === 'target') || undefined}>
                {id === undefined ? t('pickRun') : t('changeRun')}
              </button>
            </section>;
          })}
          <button type="button" className="button icon secondary comparison-swap" onClick={() => {
            setChoices({ baseline: choices.target, target: choices.baseline });
            apply({ ...selection, baseline: target, target: baseline,
              kind: swappedKinds[currentKind] ?? kind });
          }} disabled={!input} aria-label={t('swap')} title={t('swap')}>
            <ArrowLeftRight size={17} aria-hidden="true" />
          </button>
        </div>
        {!input && <p className="field-note">{t('choosePair')}</p>}
        {invalidPair
          ? <ErrorMessage text={t('invalidPair')} />
          : error && <><ErrorMessage text={error} />
            <button className="button small secondary" onClick={() => { overview.refresh(); query.refresh(); }}>{t('retry')}</button></>}
        {input && !invalidPair && <>
          {summary && <section className="comparison-summary" aria-label={t('summarySection')}>
            <h3>{t('summary')}</h3>
            <p className="field-note">{t('summaryHint')}</p>
            <div className="comparison-counts">
              {(['differences', 'all', 'same', ...flagKinds] as const).map(item => {
                const count = item === 'differences' ? summary.differences : item === 'all' ? summary.total
                  : item === 'same' ? summary.total - summary.differences : summary.counts[item];
                return <button key={item} type="button" className="button small secondary"
                  aria-pressed={currentKind === item} onClick={() => apply({ ...selection, kind: item })}>
                  {t(`filter_${item}`)} <strong>{formatNumber(count)}</strong>
                </button>;
              })}
            </div>
          </section>}
          <form className="report-filters comparison-filters" onSubmit={event => {
            event.preventDefault();
            apply({ ...selection, q: draft.trim() || undefined });
            search.current?.focus();
          }}>
            <label className="report-search">{t('urlOrName')}
              <input ref={search} name="q" type="search" maxLength={512} placeholder={t('searchComparison')}
                value={draft} onChange={event => setDraft(event.target.value)} data-initial-focus />
            </label>
            <label>{t('changeType')}
              <FilterSelect value={currentKind} onChange={event => apply({ ...selection, kind: event.target.value as ComparisonKind })}>
                {filters.map(item => <option key={item} value={item}>{t(`filter_${item}`)}</option>)}
              </FilterSelect>
            </label>
            <button type="submit" className="button small primary"><Search size={15} aria-hidden="true" /> {t('search')}</button>
            {(q || currentKind !== 'differences') && <button type="button" className="button small secondary"
              onClick={() => { setDraft(''); apply({ baseline, target }); search.current?.focus(); }}>
              {t('resetFilters')}
            </button>}
          </form>
          <h3 className="comparison-results-title" ref={resultsTitle} tabIndex={-1}>{t('sideBySide')}</h3>
          {!query.data && !error && <Loading />}
          {query.data && (query.data.items.length ? <ComparisonRows key={key + ':' + currentPage.at(-1)} rows={query.data.items} />
            : <Empty icon={<Search size={21} />} title={t('noResults')}
              text={currentKind === 'differences' && !q ? t('noDifferencesHint') : t('noResultsHint')} />)}
          {(currentPage.length > 0 || next != null) && <nav className="report-pages" aria-label={t('resultPages')}>
            <span aria-live="polite">{t('page', { page: formatNumber(currentPage.length + 1) })}</span>
            <button type="button" className="button small secondary" disabled={!currentPage.length}
              onClick={() => paginate(currentPage.slice(0, -1))}><ChevronLeft size={15} aria-hidden="true" /> {t('back')}</button>
            <button type="button" className="button small secondary" disabled={next == null}
              onClick={() => { if (next != null) paginate([...currentPage, next]); }}>
              {t('next')} <ChevronRight size={15} aria-hidden="true" />
            </button>
          </nav>}
        </>}
      </div>
      {input && summary && !invalidPair && <div className="modal-footer">
        <ComparisonExport key={key} projectId={projectId} input={input}
          invalidate={() => { overview.refresh(); query.refresh(); }} />
      </div>}
    </Modal>
    {picker && <RunPicker projectId={projectId} side={picker} opposite={picker === 'baseline' ? target : baseline}
      close={() => setPicker(undefined)} choose={choose} />}
  </>;
}
