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
import { date, Empty, ErrorMessage, exportOptions, FilterSelect, formatNumber, Loading, Modal, RunStatus, Status } from './ui.js';

const sides = { baseline: 'Было', target: 'Стало' } as const;
type Side = keyof typeof sides;
const flagKinds = Object.keys(comparisonFlags) as ComparisonFlag[];
const filterLabels = { ...comparisonFlags, differences: 'Все расхождения', all: 'Все URL', same: 'Совпадения' };
const filters: ComparisonKind[] = ['differences', 'all', 'same', ...flagKinds];

function RunChoiceDetails({ run }: { run: Run }) {
  return <div className="comparison-run-meta">
    <RunStatus run={run} />
    <span>{run.source === 'schedule' ? 'По расписанию' : 'Вручную'}</span>
    {run.group && <span>Группа «{run.group.name}»</span>}
    <span>Проверено {formatNumber(run.completed)} из {formatNumber(run.total)}</span>
  </div>;
}

function RunPicker({ projectId, side, opposite, choose, close }: {
  projectId: number; side: Side; opposite?: number; choose: (run: Run) => void; close: () => void;
}) {
  const [cursors, setCursors] = useState<number[]>([]);
  const path = base(projectId) + '/runs?view=compare-options';
  const query = useQuery<RunPage>(path + (cursors.length ? '&before=' + cursors.at(-1) : ''));
  const next = query.data?.nextBefore;
  const descriptions = useId();
  return <Modal title={`Выберите прогон — ${sides[side]}`} close={close}>
    <div className="modal-body">
      {query.error && <><ErrorMessage text={query.error} />
        <button className="button small secondary" onClick={query.refresh}>Повторить</button></>}
      {!query.data && !query.error && <Loading />}
      {query.data?.items.length === 0 && <p className="muted">Нет прогонов с результатами на этой странице.</p>}
      {!!query.data?.items.length && <ul className="comparison-picker">
        {query.data.items.map(run => <li key={run.id}>
          <div>
            <strong>№{run.id} · {date(run.createdAt)}</strong>
            <div id={`${descriptions}-${run.id}`}><RunChoiceDetails run={run} /></div>
          </div>
          <button type="button" className="button small secondary" disabled={run.id === opposite}
            aria-label={`Выбрать прогон №${run.id}`} aria-describedby={`${descriptions}-${run.id}`}
            onClick={() => choose(run)}>{run.id === opposite ? 'Выбран' : 'Выбрать'}</button>
        </li>)}
      </ul>}
      {(cursors.length > 0 || next != null) && <nav className="pagination report-pages" aria-label="Страницы списка прогонов">
        <button type="button" className="button icon secondary" aria-label="Предыдущая страница" disabled={!cursors.length}
          onClick={() => setCursors(cursors.slice(0, -1))}><ChevronLeft size={15} aria-hidden="true" /></button>
        <span aria-live="polite">Страница {cursors.length + 1}</span>
        <button type="button" className="button icon secondary" aria-label="Следующая страница" disabled={next == null}
          onClick={() => { if (next != null) setCursors([...cursors, next]); }}><ChevronRight size={15} aria-hidden="true" /></button>
      </nav>}
    </div>
  </Modal>;
}

function CoverageValue({ side }: { side: ComparisonSide }) {
  if (side.state === 'checked') return <>
    <Status result={side.result} />
    <span className="comparison-response">
      {side.result.httpCode != null && <span>HTTP {side.result.httpCode}</span>}
      {side.result.durationMs != null && <span>{formatNumber(side.result.durationMs)} мс</span>}
    </span>
  </>;
  if (side.state === 'unchecked') return <span className="muted">Не проверен</span>;
  return <span className="muted">{side.state === 'unknown' ? 'Нет данных о составе' : 'Не входил в прогон'}</span>;
}

function sideAddress(side: ComparisonSide) {
  return side.state === 'checked' ? side.result : side.state === 'unchecked' ? side : null;
}

function SideDetails({ side, title }: { side: ComparisonSide; title: string }) {
  const address = sideAddress(side);
  return <div className="comparison-side-details">
    <strong>{title}</strong>
    {address && <dl>
      <div><dt>Проверяемый URL</dt><dd>{address.url}</dd></div>
      <div><dt>Версия адреса</dt><dd>{address.version}</dd></div>
      {side.state === 'checked' && <>
        <div><dt>Проверено</dt><dd>{date(side.result.checkedAt)}</dd></div>
        <div><dt>Конечный URL</dt><dd>{side.result.finalUrl ?? '—'}</dd></div>
        {side.result.error && <div><dt>Причина ошибки</dt><dd>{side.result.error}</dd></div>}
        {side.result.tlsCode && <div><dt>Код TLS</dt><dd>{side.result.tlsCode}</dd></div>}
        <RequestDetails result={side.result} />
      </>}
    </dl>}
    {side.state !== 'checked' && <CoverageValue side={side} />}
  </div>;
}

function ComparisonRows({ rows }: { rows: ComparisonRow[] }) {
  const [expanded, setExpanded] = useState<number>();
  const details = useId();
  return <table className="data-table comparison-table" aria-label="Результаты сравнения">
    <thead><tr><th scope="col">Адрес и изменения</th><th scope="col">Было</th><th scope="col">Стало</th></tr></thead>
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
              {row.flags.map(flag => <span key={flag}>{comparisonFlags[flag]}</span>)}
              {delta != null && <span>Δ {delta > 0 ? '+' : ''}{formatNumber(delta)} мс</span>}
            </div>
            <button type="button" className="text-button comparison-details-toggle" aria-expanded={open}
              aria-controls={open ? `${details}-${row.urlId}` : undefined}
              onClick={() => setExpanded(open ? undefined : row.urlId)}>Подробности</button>
          </td>
          <td><CoverageValue side={row.baseline} /></td>
          <td><CoverageValue side={row.target} /></td>
        </tr>
        {open && <tr className="comparison-details"><td colSpan={3} id={`${details}-${row.urlId}`}>
          <div className="comparison-details-grid">
            <SideDetails side={row.baseline} title="Было" />
            <SideDetails side={row.target} title="Стало" />
          </div>
        </td></tr>}
      </Fragment>;
    })}</tbody>
  </table>;
}

function ComparisonExport({ projectId, input, invalidate }: { projectId: number; input: ComparisonInput; invalidate: () => void }) {
  const bridge = window.pulseDesktop;
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
      if (!response.ok) throw new Error('Не удалось подготовить выгрузку. Повторите попытку.');
      const download = document.createElement('a');
      download.href = href;
      download.download = '';
      download.click();
    } finally { pending.current = undefined; }
  }

  return <div className="comparison-export">
    <span>Экспорт по фильтрам</span>
    <div className="export-links" role="group" aria-label="Форматы экспорта сравнения">
      {exportOptions.map(({ format, label }) => {
        const params = comparisonParams(input);
        params.set('format', format);
        const href = `${base(projectId)}/run-comparison/export?${params}`;
        return bridge
          ? <button key={format} type="button" className="button small secondary" disabled={task.busy} onClick={() => {
            setSaved(false);
            void task.run(async () => {
              const result = await bridge.exportComparison(projectId, input, format);
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
    {saved && <span role="status">Сравнение сохранено.</span>}
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
    <Modal title="Сравнение прогонов" wide close={close} fallbackFocus={fallbackFocus}>
      <div className="modal-body comparison-body">
        <div className="comparison-pair">
          {(['baseline', 'target'] as const).map(side => {
            const id = selection[side];
            const remembered = choices[side];
            const run = summary?.[side] ?? (remembered?.id === id ? remembered : undefined);
            return <section key={side} className={`comparison-run comparison-${side}`} aria-label={sides[side]}>
              <h3>{sides[side]}</h3>
              {id !== undefined && <strong>№{id}{run && ` · ${date(run.createdAt)}`}</strong>}
              {run && <RunChoiceDetails run={run} />}
              <button type="button" className="button small secondary" onClick={() => setPicker(side)}
                data-initial-focus={(baseline === undefined ? side === 'baseline' : target === undefined && side === 'target') || undefined}>
                {id === undefined ? 'Выбрать прогон' : 'Изменить прогон'}
              </button>
            </section>;
          })}
          <button type="button" className="button icon secondary comparison-swap" onClick={() => {
            setChoices({ baseline: choices.target, target: choices.baseline });
            apply({ ...selection, baseline: target, target: baseline,
              kind: swappedKinds[currentKind] ?? kind });
          }} disabled={!input} aria-label="Поменять местами" title="Поменять местами">
            <ArrowLeftRight size={17} aria-hidden="true" />
          </button>
        </div>
        {!input && <p className="field-note">Выберите два разных прогона с результатами проверок.</p>}
        {invalidPair
          ? <ErrorMessage text="Один из прогонов недоступен для сравнения. Выберите другой прогон." />
          : error && <><ErrorMessage text={error} />
            <button className="button small secondary" onClick={() => { overview.refresh(); query.refresh(); }}>Повторить</button></>}
        {input && !invalidPair && <>
          {summary && <section className="comparison-summary" aria-label="Сводка сравнения">
            <h3>Сводка</h3>
            <p className="field-note">Один адрес может учитываться в нескольких категориях.</p>
            <div className="comparison-counts">
              {(['differences', 'all', 'same', ...flagKinds] as const).map(item => {
                const count = item === 'differences' ? summary.differences : item === 'all' ? summary.total
                  : item === 'same' ? summary.total - summary.differences : summary.counts[item];
                return <button key={item} type="button" className="button small secondary"
                  aria-pressed={currentKind === item} onClick={() => apply({ ...selection, kind: item })}>
                  {filterLabels[item]} <strong>{formatNumber(count)}</strong>
                </button>;
              })}
            </div>
          </section>}
          <form className="report-filters comparison-filters" onSubmit={event => {
            event.preventDefault();
            apply({ ...selection, q: draft.trim() || undefined });
            search.current?.focus();
          }}>
            <label className="report-search">URL или название
              <input ref={search} name="q" type="search" maxLength={512} placeholder="Найти в сравнении"
                value={draft} onChange={event => setDraft(event.target.value)} data-initial-focus />
            </label>
            <label>Тип изменения
              <FilterSelect value={currentKind} onChange={event => apply({ ...selection, kind: event.target.value as ComparisonKind })}>
                {filters.map(item => <option key={item} value={item}>{filterLabels[item]}</option>)}
              </FilterSelect>
            </label>
            <button type="submit" className="button small primary"><Search size={15} aria-hidden="true" /> Найти</button>
            {(q || currentKind !== 'differences') && <button type="button" className="button small secondary"
              onClick={() => { setDraft(''); apply({ baseline, target }); search.current?.focus(); }}>
              Сбросить фильтры
            </button>}
          </form>
          <h3 className="comparison-results-title" ref={resultsTitle} tabIndex={-1}>Было и стало</h3>
          {!query.data && !error && <Loading />}
          {query.data && (query.data.items.length ? <ComparisonRows key={key + ':' + currentPage.at(-1)} rows={query.data.items} />
            : <Empty icon={<Search size={21} />} title="Результаты не найдены"
              text={currentKind === 'differences' && !q ? 'Совпадения доступны через фильтр «Все URL».' : 'Измените поиск или тип изменения.'} />)}
          {(currentPage.length > 0 || next != null) && <nav className="report-pages" aria-label="Страницы результатов сравнения">
            <span aria-live="polite">Страница {currentPage.length + 1}</span>
            <button type="button" className="button small secondary" disabled={!currentPage.length}
              onClick={() => paginate(currentPage.slice(0, -1))}><ChevronLeft size={15} aria-hidden="true" /> Назад</button>
            <button type="button" className="button small secondary" disabled={next == null}
              onClick={() => { if (next != null) paginate([...currentPage, next]); }}>
              Далее <ChevronRight size={15} aria-hidden="true" />
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
