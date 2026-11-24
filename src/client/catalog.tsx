import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, FileUp, ListTree, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CATALOG_FILE_LIMIT, type CatalogChange, type CatalogClearPreview, type CatalogFilter, type CatalogJob, type CatalogJobPage, type CatalogPage, type CatalogSource, type CatalogTransfer } from '../shared/catalog.js';
import type { ImportResult } from '../shared/types.js';
import { api, ApiResponseError, base, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { date, ErrorMessage, FilterSelect, formatNumber, Loading, Modal } from './ui.js';

type Overview = { sources: CatalogSource[]; jobs: CatalogJob[]; transfer: CatalogTransfer | null };
type SourceDialog = { type: 'edit'; source: CatalogSource; url: string } | { type: 'delete'; source: CatalogSource };
const states: Record<CatalogJob['state'], string> = {
  upload: 'Загрузка файла', queued: 'В очереди', running: 'Импорт', paused: 'На паузе',
  failed: 'Ошибка импорта', cancelled: 'Отменён', done: 'Готово',
};
const changeNames: Record<CatalogChange, string> = {
  all: 'Все адреса', added: 'Новые', removed: 'Исчезнувшие', changed: 'Изменён lastmod',
};
const activeStates = ['upload', 'queued', 'running', 'paused'];
const moving = (job?: CatalogTransfer | null) => job?.state === 'queued' || job?.state === 'running';
const overviewPoll = (data?: Overview) => moving(data?.transfer) || data?.jobs.some(job => activeStates.includes(job.state)) ? 700 : 3_000;

function query(filter: CatalogFilter) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  return '?' + params.toString();
}

function Jobs({ jobs, sources, control }: { jobs: CatalogJob[]; sources: CatalogSource[]; control: (jobId: number, action: string) => void }) {
  const names = new Map(sources.map(source => [source.id, source.name]));
  return <ul className="catalog-jobs">
      {jobs.map(job => <li key={job.id}>
        <div>
          <strong>№{job.id} · {states[job.state]}</strong>
          <small className="catalog-job-counts">{names.get(job.sourceId)} · {date(job.createdAt)}</small>
          <span className="catalog-job-counts">{formatNumber(job.uniqueUrls)} URL · {job.documentsDone} из {job.documentsTotal} файлов
            {job.duplicates > 0 && <> · {formatNumber(job.duplicates)} повторов</>}
            {job.invalid > 0 && <> · {formatNumber(job.invalid)} пропущено</>}
            {job.bytes > 0 && <> · {Math.round(job.bytes / 1024 / 1024 * 10) / 10} МиБ</>}
          </span>
          {job.warning && <small>Файл превышает стандартные 50 000 URL или 50 МиБ. Импорт использует увеличенный лимит.</small>}
          {job.error && <div className="catalog-job-error"><ErrorMessage text={job.error} />
            {job.problemFile && <small title={job.problemFile}>{job.problemFile}</small>}</div>}
        </div>
        <div className="catalog-buttons">
          {['queued', 'running'].includes(job.state) &&
            <button className="button small secondary" onClick={() => control(job.id, 'pause')}>Пауза</button>}
          {['paused', 'failed'].includes(job.state) &&
            <button className="button small secondary" onClick={() => control(job.id, 'resume')}>Продолжить</button>}
          {(activeStates.includes(job.state) || job.state === 'failed') &&
            <button className="button small secondary" onClick={() => control(job.id, 'cancel')}>Отменить</button>}
        </div>
      </li>)}
    </ul>;
}

export function CatalogView({ projectId, changed, openRun, openWorklist }: {
  projectId: number; changed: () => void; openRun: (runId: number) => void; openWorklist: () => void;
}) {
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
      if (file.size > CATALOG_FILE_LIMIT) throw new Error('Файл sitemap превышает 256 МиБ.');
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
    <section className="panel catalog-panel" aria-label="Источники sitemap">
      <div className="catalog-heading"><div className="section-heading">
        <span className="section-icon violet"><ListTree size={19} /></span>
        <div><h2>Каталог sitemap</h2><p>Импортируйте XML или XML.GZ, чтобы выбрать адреса для проверки.</p></div>
      </div><div className="catalog-buttons">
        {canClear && <button type="button" className="button secondary danger-ghost" onClick={() => setConfirmClear(true)}>
          <Trash2 size={16} /> Очистить каталог</button>}
        {sources.some(source => source.count > 0) && <button type="button" className="button primary"
          disabled={task.busy || moving(transfer)} onClick={() => setConfirmTransfer(true)}><Plus size={16} /> Добавить все в «Адреса»</button>}
        {sources.length > 0 && <button className="button secondary" aria-expanded={newSource} onClick={() => setNewSource(!newSource)}>
          <Plus size={16} /> Источник</button>}
      </div></div>
      <ErrorMessage text={overview.error || (clearedSources === undefined ? task.error : undefined)} />
      {clearedSources !== undefined && <p className="catalog-feedback" role="status">Каталог очищен. Удалено источников: {formatNumber(clearedSources)}.</p>}
      {(!sources.length || newSource) && <form className="catalog-controls" onSubmit={remote}>
        <label className="catalog-field catalog-grow">Ссылка на sitemap
          <input value={link} onChange={event => setLink(event.target.value)} placeholder="https://example.org/sitemap.xml" type="url" required maxLength={2000} />
        </label>
        <button className="button primary" disabled={task.busy || !link}>Импортировать</button>
        {filePicker('Загрузить файл')}
      </form>}
      {source && <div className="catalog-controls">
        <label className="catalog-field catalog-grow">Источник
          <select value={source.id} onChange={event => setSourceId(Number(event.target.value))}>
            {sources.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        {source.url
          ? <button className="button secondary" disabled={task.busy || sourceBusy} onClick={() => update(async () => {
            await write(path + '/imports', 'POST', { sourceId: source.id });
          })}><RefreshCw size={16} /> Обновить</button>
          : !sourceBusy && filePicker('Загрузить новую версию', source.id)}
        {source.url && <button type="button" className="button secondary" disabled={task.busy || sourceBusy}
          onClick={() => { task.clear(); setSourceDialog({ type: 'edit', source, url: source.url! }); }}>Изменить ссылку</button>}
        <button type="button" className="button secondary danger-ghost" disabled={task.busy || sourceBusy}
          onClick={() => { task.clear(); setSourceDialog({ type: 'delete', source }); }}>Удалить источник</button>
      </div>}
    </section>
    {transfer && <section className="panel catalog-panel" aria-label="Перенос адресов">
      {moving(transfer) ? <div className="progress-bar catalog-transfer" role="status">
        <div><strong>{transfer.state === 'queued' ? 'Перенос в очереди' : 'Перенос адресов'}</strong>
          <span>Обработано: {formatNumber(transfer.processed)}{transfer.total === null ? '' : ' из ' + formatNumber(transfer.total)}</span>
          <span>Добавлено: {formatNumber(transfer.added)}</span></div>
        <progress max={transfer.total || 1} value={transfer.total === null ? undefined : transfer.processed} aria-label="Прогресс переноса" />
        <button type="button" className="button small secondary" disabled={task.busy} onClick={() => update(async () => {
          await write(path + '/transfer/' + transfer.id + '/stop', 'POST', {});
        })}>Остановить перенос</button>
      </div> : <div className="catalog-heading">
        <div role="status"><strong>{transfer.state === 'done' ? 'Перенос завершён' : transfer.state === 'cancelled' ? 'Перенос остановлен' : 'Перенос прервался'}</strong>
          <p>Добавлено: {formatNumber(transfer.added)} · Уже в списке: {formatNumber(transfer.existing)}</p>
          {transfer.error && <ErrorMessage text={transfer.error} />}</div>
        <button className="button secondary" onClick={openWorklist}>Открыть «Адреса»</button>
      </div>}
    </section>}
    {source?.currentId && <CatalogTable key={source.id + ':' + source.currentId} projectId={projectId} source={source}
      changed={changed} openRun={openRun} filterChanged={filtered => setFilteredRevision(filtered ? source.currentId ?? undefined : undefined)} />}
    {(!overview.data || waitingForSource) && !overview.error && <Loading />}
    {(recentJobs.length > 0 || historyCursors) && <details className="panel catalog-panel" open>
      <summary>Импорты</summary>
      <div className="catalog-buttons">
        {historyCursors
          ? <button type="button" className="button small secondary" onClick={() => setHistoryCursors(undefined)}>Текущие и недавние импорты</button>
          : <button type="button" className="button small secondary" onClick={() => setHistoryCursors([])}>История импортов</button>}
      </div>
      {historyCursors ? <>
        <ErrorMessage text={history.error} />
        {!history.data && !history.error && <Loading />}
        {history.data?.jobs.length === 0 && <p>На этой странице нет импортов.</p>}
        {history.data && <Jobs jobs={history.data.jobs} sources={sources} control={controlImport} />}
        <div className="table-footer">
          <span>Страница {historyCursors.length + 1}</span>
          <div className="catalog-buttons">
            <button type="button" className="button small secondary" disabled={!historyCursors.length}
              onClick={() => setHistoryCursors(historyCursors.slice(0, -1))}><ChevronLeft size={15} /> Более новые импорты</button>
            <button type="button" className="button small secondary" disabled={!history.data?.next}
              onClick={() => setHistoryCursors([...historyCursors, history.data!.next!])}>Более ранние импорты <ChevronRight size={15} /></button>
          </div>
        </div>
      </> : <Jobs jobs={recentJobs} sources={sources} control={controlImport} />}
    </details>}
    {confirmTransfer && <Modal title="Перенести все адреса из каталога?" close={() => setConfirmTransfer(false)}>
      <div className="modal-body">
        <p>В «Адреса» попадут уникальные URL из опубликованных версий всех источников проекта. Выбранный источник и фильтры не ограничивают перенос.</p>
        <p>Если остановить перенос, уже добавленные адреса останутся в списке.</p>
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={() => setConfirmTransfer(false)}>Отмена</button>
        <button type="button" className="button primary" disabled={task.busy || moving(transfer)} onClick={() => {
          setConfirmTransfer(false);
          update(async () => { await write(path + '/transfer', 'POST', {}); });
        }}>Перенести адреса</button>
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
    {sourceDialog && <Modal title={sourceDialog.type === 'edit' ? 'Изменить ссылку на sitemap' : 'Удалить источник sitemap?'}
      close={() => { if (!task.busy) setSourceDialog(undefined); }}>
      <form onSubmit={saveSource}>
        <div className="modal-body form">
          {sourceDialog.type === 'edit' ? <>
            <label>Ссылка на sitemap
              <input value={sourceDialog.url} onChange={event => setSourceDialog({ ...sourceDialog, url: event.target.value })}
                required type="url" maxLength={2000} autoFocus disabled={task.busy} />
            </label>
            <p className="field-note">После сохранения нажмите «Обновить». Опубликованная версия сохранится до успешного импорта.</p>
          </> : <p>Источник «{sourceDialog.source.name}», его версии и история импорта будут удалены. Уже перенесённые URL останутся в «Адресах».</p>}
          <ErrorMessage text={task.error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" disabled={task.busy} onClick={() => setSourceDialog(undefined)}>Отмена</button>
          <button type="submit" className={sourceDialog.type === 'edit' ? 'button primary' : 'button danger'} disabled={task.busy}>
            {sourceDialog.type === 'edit' ? 'Сохранить ссылку' : 'Удалить источник'}
          </button>
        </div>
      </form>
    </Modal>}
  </div>;
}

function ClearCatalogForm({ path, close, cleared }: { path: string; close: () => void; cleared: (deleted: number) => void }) {
  const { data, error, reset } = useQuery<CatalogClearPreview>(path);
  const hasOperations = data && (data.activeImports > 0 || data.transferActive);
  return <ConfirmDeletion title="Очистить каталог sitemap?" label={hasOperations ? 'Остановить и очистить' : 'Очистить каталог'}
    close={close} ready={!!data?.sources && !error} pendingLabel="Очищаем каталог…" confirm={async () => {
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
    {error && <button type="button" className="button secondary" onClick={reset}>Обновить предпросмотр</button>}
    {!data && !error && <Loading />}
    {data && <>
      <p>Проект <strong>«{data.projectName}»</strong></p>
      <p><strong>Источников: {formatNumber(data.sources)}</strong> · Записей импорта: {formatNumber(data.imports)}.<br />
        URL в опубликованных версиях: {formatNumber(data.publishedUrls)} суммарно по источникам.</p>
      <p>Будут удалены все источники проекта, их версии и история импорта. Операция необратима.</p>
      <p>Импорты и перенос в «Адреса» будут остановлены. Уже перенесённые URL и отчёты сохранятся.</p>
      {hasOperations && <p>Активных импортов: {formatNumber(data.activeImports)}. {data.transferActive && 'Перенос в «Адреса» в работе или в очереди.'}</p>}
    </>}
  </ConfirmDeletion>;
}

function CatalogTable({ projectId, source, changed, openRun, filterChanged }: { projectId: number; source: CatalogSource; changed: () => void;
  openRun: (runId: number) => void; filterChanged: (filtered: boolean) => void }) {
  const path = base(projectId) + '/catalog';
  const unfiltered: CatalogFilter = { sourceId: source.id, revision: source.currentId!, change: 'all' };
  const [domain, setDomain] = useState('');
  const [prefix, setPrefix] = useState('');
  const [filters, setFilters] = useState(unfiltered);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState('100');
  const [feedback, setFeedback] = useState('');
  const [report, setReport] = useState<number>();
  const page = useQuery<CatalogPage>(path + '/page' + query({ ...filters, after: cursors.at(-1) }));
  const rows = page.data?.items ?? [];
  const task = useTask();
  const number = Number(limit);
  const validLimit = Number.isInteger(number) && number >= 1 && number <= 5000;
  const draftChanged = domain.trim() !== (filters.domain ?? '') || prefix.trim() !== (filters.prefix ?? '');
  const canExport = !draftChanged && !task.busy && !!page.data && !page.error;
  const canAct = canExport && (selected.size > 0 || (rows.length > 0 && validLimit));
  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.url));
  const applied = [source.name, filters.domain && `домен ${filters.domain}`, filters.prefix && `путь ${filters.prefix}`,
    changeNames[filters.change ?? 'all'], filters.direction === 'desc' ? 'по убыванию' : 'по возрастанию'].filter(Boolean).join(' · ');

  function apply(updated: CatalogFilter) {
    if (!cursors.length && page.error && query(updated) === query(filters)) page.reset();
    setFilters(updated);
    filterChanged(!!(updated.domain || updated.prefix || updated.change !== 'all'));
    setCursors([]); setSelected(new Set()); setFeedback(''); task.clear();
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
      setFeedback(''); setReport(undefined);
      const selection = selected.size ? { selected: [...selected] } : { limit: number };
      const result = await write<ImportResult | { id: number }>(path + '/actions', 'POST', { ...filters, action, ...selection });
      if ('id' in result) { setFeedback('Проверка поставлена в очередь.'); setReport(result.id); }
      else setFeedback(`В работе добавлено: ${result.added} · Повторы: ${result.duplicates}`);
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
        if (!response.ok) throw new Error((await response.json()).error ?? 'Не удалось выгрузить CSV.');
        const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        const filename = encodedName ? decodeURIComponent(encodedName) : 'pulse-sitemap.csv';
        const link = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a');
        anchor.href = link; anchor.download = filename; anchor.click();
        setTimeout(() => URL.revokeObjectURL(link), 1000);
      }
    });
  }

  return <section className="panel catalog-panel catalog-table-panel" aria-label="Адреса из sitemap">
    <div className="catalog-heading">
      <h2>Адреса из sitemap</h2>
      <div className="catalog-counts">
        <span>{formatNumber(source.count)} URL</span>
        <span>Новые {formatNumber(source.added)}</span><span>Исчезли {formatNumber(source.removed)}</span>
        <span>Изменены {formatNumber(source.changed)}</span>
      </div>
    </div>
    <form className="catalog-controls" onSubmit={event => { event.preventDefault(); apply({ ...filters, domain: domain.trim(), prefix: prefix.trim() }); }}>
      <label className="catalog-field catalog-grow">Домен<input value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.org" maxLength={255} /></label>
      <label className="catalog-field catalog-grow">Начало пути<input value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="/catalog/" maxLength={2000} /></label>
      <button className="button secondary">Найти</button>
      <label className="catalog-field">Изменения
        <FilterSelect value={filters.change} onChange={event => apply({ ...filters, change: event.target.value as CatalogChange })}>
          {Object.entries(changeNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </FilterSelect>
      </label>
      <label className="catalog-field">Сортировка
        <FilterSelect value={filters.direction ?? 'asc'} onChange={event => apply({ ...filters, direction: event.target.value === 'desc' ? 'desc' : undefined })}>
          <option value="asc">По возрастанию</option><option value="desc">По убыванию</option>
        </FilterSelect>
      </label>
      <button type="button" className="button secondary" disabled={!draftChanged && query(filters) === query(unfiltered) && !cursors.length}
        onClick={() => { setDomain(''); setPrefix(''); apply(unfiltered); }}>Сбросить фильтры</button>
    </form>
    <p><strong>Применено</strong> · {applied}</p>
    {draftChanged && <p role="status">Примените изменения кнопкой «Найти».</p>}
    {selected.size > 0 ? <p>Проверка и перенос охватят выбранные URL ({formatNumber(selected.size)}).</p>
      : validLimit && <p>Проверка и перенос охватят до {formatNumber(number)} первых URL по применённым условиям.</p>}
    <div className="catalog-controls catalog-actions">
      {selected.size ? <button className="text-button" onClick={() => setSelected(new Set())}>Снять выбор</button>
        : <label className="catalog-field catalog-limit">Первые URL по фильтру
          <input value={limit} onChange={event => setLimit(event.target.value)} type="number" min="1" max="5000" />
        </label>}
      <button className="button primary" disabled={!canAct} onClick={() => act('check')}><Play size={14} /> Проверить</button>
      <button className="button secondary" disabled={!canAct} onClick={() => act('add')}><Plus size={15} /> В рабочий список</button>
      {!window.pulseDesktop && canExport
        ? <a className="button secondary" href={path + '/export' + query(filters)} download><Download size={15} /> CSV по фильтру</a>
        : <button className="button secondary" disabled={!canExport} onClick={() => save(false)}><Download size={15} /> CSV по фильтру</button>}
      {selected.size > 0 && <button className="button secondary" disabled={!canExport} onClick={() => save(true)}><Download size={15} /> CSV выбранных</button>}
    </div>
    <ErrorMessage text={page.error || task.error} />
    {page.error && <button type="button" className="button small secondary" onClick={page.reset}><RefreshCw size={15} /> Повторить</button>}
    {feedback && <div className="catalog-feedback" role="status">{feedback}
      {report && <button className="text-button" onClick={() => openRun(report)}>Открыть отчёт</button>}</div>}
    {!page.data && !page.error && <Loading />}
    {page.data && (rows.length ? <div className="table-scroll"><table className="data-table catalog-table">
      <thead><tr>
        <th className="check-cell"><input type="checkbox" aria-label="Выбрать страницу" checked={allSelected} onChange={event => toggle(rows.map(row => row.url), event.target.checked)} /></th>
        <th scope="col">URL</th><th scope="col">Lastmod в sitemap</th><th scope="col">Изменение</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.url} className={selected.has(row.url) ? 'highlight' : undefined}>
        <td className="check-cell"><input type="checkbox" aria-label={'Выбрать ' + row.url} checked={selected.has(row.url)}
          disabled={selected.size === 5000 && !selected.has(row.url)} onChange={event => toggle([row.url], event.target.checked)} /></td>
        <td className="catalog-url" title={row.url}>{row.url}</td>
        <td>{row.lastmod ?? '—'}</td><td>{row.change ? changeNames[row.change] : '—'}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><h3>Адресов по этим условиям нет</h3></div>)}
    <div className="table-footer">
      <span>Страница {cursors.length + 1}</span><div className="catalog-buttons">
        <button className="button small secondary" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}><ChevronLeft size={15} /> Назад</button>
        <button className="button small secondary" disabled={!page.data?.next} onClick={() => setCursors([...cursors, page.data!.next!])}>Далее <ChevronRight size={15} /></button>
      </div>
    </div>
  </section>;
}
