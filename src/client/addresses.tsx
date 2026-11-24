import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, FolderMinus, FolderPlus, Link2, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { ADDRESS_PAGE_SIZE, ADDRESS_SELECTION_LIMIT, defaultFilters } from '../shared/addresses.js';
import type { AddressRow, AddressFilters, AddressSort, AddressStatus, WorkGroup } from '../shared/types.js';
import { api, base, useQuery, useTask, write } from './api.js';
import { DeleteAllForm } from './forms.js';
import { AddToGroup, GroupControls } from './groups.js';
import { RunList } from './reports.js';
import { date, Empty, ErrorMessage, FilterSelect, formatNumber, Loading, Status } from './ui.js';

const columns: { key: AddressSort; label: string }[] = [
  { key: 'url', label: 'URL-адрес' }, { key: 'status', label: 'Статус' },
  { key: 'httpCode', label: 'HTTP' }, { key: 'durationMs', label: 'Ответ' }, { key: 'checkedAt', label: 'Последняя проверка' },
];

type AddressPage = { items: AddressRow[]; total: number; page: number };

export function AddressList({ projectId, revision, total, deletedIds, importUrls, start, startGroup, edit, remove, inspect, busy,
  addressesCleared, journalRevision, openRun, openComparison, groupId, showRuns, changeGroup }: {
  projectId: number; revision: string; total: number; deletedIds?: number[];
  importUrls: () => void; start: (ids?: number[]) => void; startGroup: (id: number) => void; edit: (address: AddressRow) => void;
  remove: (ids: number[], filters: string) => void; inspect: (id: number) => void; busy: boolean;
  addressesCleared: () => void; journalRevision: number; openRun: (id: number) => void; openComparison: () => void;
  groupId?: number; showRuns: boolean; changeGroup: (groupId?: number, showRuns?: boolean) => void;
}) {
  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState(filters.q);
  const [selected, setSelected] = useState<number[]>([]);
  const [filterSelection, setFilterSelection] = useState<{ key: string; ids: number[] }>();
  const [page, setPage] = useState(1);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const selectionIntent = useRef(0);
  const [addToGroup, setAddToGroup] = useState<number[]>();
  const [message, setMessage] = useState('');
  const [deleteAll, setDeleteAll] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsAbove, setActionsAbove] = useState(false);
  const actionsId = useId();
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const actionsItems = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const checkAll = useRef<HTMLInputElement>(null);
  const path = base(projectId) + '/urls';
  const groupsPath = base(projectId) + '/groups';
  const groups = useQuery<WorkGroup[]>(groupsPath);
  const refreshGroups = groups.refresh;
  const activeGroup = groups.data?.find(group => group.id === groupId);
  const params = new URLSearchParams({ status: filters.status, sort: filters.sort, direction: filters.direction, q: query });
  if (activeGroup) params.set('group', String(activeGroup.id));
  const key = params.toString();
  const snapshotKey = key + ':' + revision;
  const currentKey = useRef(snapshotKey);
  currentKey.current = snapshotKey;
  const result = useQuery<AddressPage>(total ? path + '/page?' + key + '&page=' + page : null);
  const { refresh } = result;
  const groupTask = useTask();

  useEffect(() => {
    if (filters.q === query) return;
    const timer = setTimeout(() => { setQuery(filters.q); setPage(1); }, 140);
    return () => clearTimeout(timer);
  }, [filters.q, query]);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (revision !== lastRevision.current) { refresh(); refreshGroups(); }
    lastRevision.current = revision;
  }, [revision, refresh, refreshGroups]);
  useEffect(() => {
    if (!deletedIds?.length) return;
    invalidateSelection();
    const removed = new Set(deletedIds);
    setSelected(current => current.filter(id => !removed.has(id)));
    setFilterSelection(undefined);
  }, [deletedIds]);
  useEffect(() => {
    invalidateSelection();
    setPage(1);
    setFilterSelection(undefined);
    setMessage('');
  }, [groupId]);

  const rows = result.data?.items ?? [];
  const filteredCount = result.data?.total ?? 0;
  const scopeTotal = activeGroup?.count ?? total;
  const filtered = Boolean(filters.q.trim()) || filters.status !== 'all';
  const canDeleteAll = total > 0 && groupId === undefined && !filtered && !query.trim();
  useLayoutEffect(() => {
    const trigger = actionsTrigger.current;
    const menu = actionsItems.current;
    if (!actionsOpen || !trigger || !menu) return;
    const { top, bottom } = trigger.getBoundingClientRect();
    const space = menu.offsetHeight + 7;
    setActionsAbove(window.innerHeight - bottom < space && top >= space);
  }, [actionsOpen, canDeleteAll, groupId]);
  const pages = Math.max(1, Math.ceil(filteredCount / ADDRESS_PAGE_SIZE));
  const activePage = result.data?.page ?? page;
  const startAt = (activePage - 1) * ADDRESS_PAGE_SIZE;
  const selectedIds = new Set(selected);
  const checks = rows.filter(row => selectedIds.has(row.id)).length;
  const selectionUpdating = !result.data || query !== filters.q || selectionBusy;
  const selectPageOnly = filteredCount > ADDRESS_SELECTION_LIMIT;
  const filterIds = filterSelection?.key === snapshotKey && filterSelection.ids.length === filteredCount ? filterSelection.ids : [];
  const checked = selectPageOnly || filteredCount === rows.length ? rows.length > 0 && checks === rows.length
    : filterIds.length > 0 && filterIds.every(id => selectedIds.has(id));
  useEffect(() => {
    if (checkAll.current) checkAll.current.indeterminate = checks > 0 && !checked;
  }, [checks, checked]);

  function invalidateSelection() {
    selectionIntent.current++;
    setSelectionBusy(false);
    setSelectionError('');
  }

  function update(next: Partial<AddressFilters>) {
    invalidateSelection();
    setFilters(current => ({ ...current, ...next }));
    if (!('q' in next)) setPage(1);
  }

  function resetFilters() {
    update({ q: '', status: 'all' });
    setQuery('');
    setPage(1);
    searchInput.current?.focus();
  }

  function closeActions() {
    setActionsOpen(false);
    actionsTrigger.current?.focus();
  }

  function chooseGroup(id?: number) {
    if (id === groupId) return;
    invalidateSelection();
    groupTask.clear();
    changeGroup(id, false);
  }

  function changeGroups() { refreshGroups(); refresh(); }

  function addToCurrentGroup(group: WorkGroup) {
    void groupTask.run(async () => {
      const { changed } = await write<{ changed: number }>(`${groupsPath}/${group.id}/members`, 'PATCH', { operation: 'add', ids: selected });
      setMessage(changed ? `Добавлено в «${group.name}»: ${formatNumber(changed)}.` : `Выбранные URL уже входят в группу «${group.name}».`);
      changeGroups();
    });
  }

  function removeFromGroup(ids: number[]) {
    if (!activeGroup) return;
    void groupTask.run(async () => {
      const { changed } = await write<{ changed: number }>(`${groupsPath}/${activeGroup.id}/members`, 'PATCH', { operation: 'remove', ids });
      const removed = new Set(ids);
      setSelected(current => current.filter(id => !removed.has(id)));
      setFilterSelection(undefined);
      setMessage(`Убрано из «${activeGroup.name}»: ${formatNumber(changed)}.`);
      changeGroups();
    });
  }

  async function toggleAll() {
    const intent = ++selectionIntent.current;
    const isCurrent = () => selectionIntent.current === intent && currentKey.current === snapshotKey;
    setSelectionBusy(true);
    setSelectionError('');
    try {
      let ids = rows.map(row => row.id);
      if (!selectPageOnly) {
        const selection = await api<{ ids: number[]; exceeded: boolean }>(path + '/selection?' + key);
        if (!isCurrent()) return;
        if (selection.exceeded) throw new Error('Выберите до 5 000 адресов или сузьте фильтр.');
        ids = selection.ids;
        setFilterSelection({ key: snapshotKey, ids });
      }
      const items = new Set(ids);
      const next = checked ? selected.filter(id => !items.has(id)) : [...new Set([...selected, ...ids])];
      if (next.length > ADDRESS_SELECTION_LIMIT) throw new Error('В одной операции можно выбрать до 5 000 адресов.');
      setSelected(next);
    } catch (error) {
      if (isCurrent()) setSelectionError((error as Error).message);
    } finally {
      if (selectionIntent.current === intent) setSelectionBusy(false);
    }
  }

  const options: { value: AddressStatus; label: string }[] = [
    { value: 'all', label: 'Все статусы' }, { value: 'ok', label: 'Доступные' },
    { value: 'error', label: 'С ошибками' }, { value: 'unchecked', label: 'Не проверены' },
  ];

  return <>
    <GroupControls path={groupsPath} groups={groups.data} active={activeGroup} choose={chooseGroup} changed={changeGroups}
      start={startGroup} busy={busy} showRuns={showRuns} toggleRuns={() => changeGroup(groupId, !showRuns)} />
    <ErrorMessage text={groups.error || groupTask.error} />
    {message && <p className="address-feedback" role="status">{message}</p>}
    {activeGroup && showRuns && <RunList key={activeGroup.id} projectId={projectId} groupId={activeGroup.id} revision={journalRevision}
      open={openRun} openComparison={openComparison} />}
    <section className="panel address-panel">
    <div className="panel-heading">
      <div className="panel-title"><h2>{activeGroup?.name ?? 'URL-адреса'}</h2><span className="count">Всего {formatNumber(scopeTotal)}</span></div>
      <div className="address-actions">
        {total > 0 && <button ref={addButton} className="button primary" onClick={importUrls}><Plus size={17} />
          {activeGroup ? 'Добавить URL в проект' : 'Добавить URL'}</button>}
        {total > 0 && <div className="address-action-menu"
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false);
          }}
          onKeyDown={event => {
            if (event.key !== 'Escape' || !actionsOpen) return;
            event.preventDefault();
            event.stopPropagation();
            closeActions();
          }}>
          <button type="button" className="button secondary" ref={actionsTrigger} aria-expanded={actionsOpen} aria-controls={actionsId}
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              setActionsOpen(open => !open);
            }}>Действия <ChevronDown size={14} aria-hidden="true" /></button>
          <div className={actionsAbove ? 'menu-items above' : 'menu-items'} ref={actionsItems} id={actionsId} hidden={!actionsOpen}>
            <button type="button" disabled={!canDeleteAll} onClick={() => {
              closeActions();
              setDeleteAll(true);
            }}><Trash2 size={15} aria-hidden="true" /> Удалить все адреса проекта</button>
            {!canDeleteAll && <p>{groupId === undefined
              ? 'Сбросьте поиск и фильтр статуса.'
              : 'Перейдите к общему списку адресов и сбросьте фильтры.'}</p>}
          </div>
        </div>}
      </div>
    </div>
    {total ? <>
      <div className="address-filters">
        <div className="table-toolbar">
          <label className="search">
            <Search size={17} /><input ref={searchInput} type="search" aria-label="Поиск по адресам" placeholder="Поиск по адресу или названию"
              maxLength={2000} value={filters.q} onChange={event => update({ q: event.target.value })} />
          </label>
          <FilterSelect aria-label="Фильтр по статусу" value={filters.status}
            onChange={event => update({ status: event.target.value as AddressStatus })}>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </FilterSelect>
        </div>
        {filtered && <div className="address-filter-summary">
          <span role="status">{query === filters.q && result.data
            ? `Найдено ${formatNumber(filteredCount)} из ${formatNumber(scopeTotal)}` : ''}</span>
          <button type="button" className="button small ghost" onClick={resetFilters}>Сбросить фильтры</button>
        </div>}
      </div>
      {(selected.length > 0 || selectionBusy) && <div className="bulk-bar">
        {selectionBusy ? <strong role="status">Выбираем адреса…</strong> : <strong>Выбрано: {formatNumber(selected.length)}</strong>}
        {selected.length > 0 && <>
        {result.data && selected.length > checks && <span>Вне текущей страницы {formatNumber(selected.length - checks)}</span>}
        <button className="button small primary" disabled={busy || selectionUpdating} onClick={() => start(selected)}><Play size={14} /> Проверить выбранные</button>
        {activeGroup && <button className="button small secondary" disabled={selectionBusy || groupTask.busy}
          onClick={() => addToCurrentGroup(activeGroup)}><FolderPlus size={14} /> Добавить в «{activeGroup.name}»</button>}
        {!!groups.data?.length && <button className="button small secondary" disabled={selectionUpdating || groupTask.busy}
          onClick={() => setAddToGroup(selected)}><FolderPlus size={14} /> Добавить в группу</button>}
        {activeGroup ? <button className="button small secondary" disabled={selectionUpdating || groupTask.busy}
          onClick={() => removeFromGroup(selected)}><FolderMinus size={14} /> Убрать из группы</button>
          : <button className="button small secondary" disabled={selectionUpdating} onClick={() => remove(selected, key)}><Trash2 size={14} /> Удалить выбранные</button>}
        </>}
        <button className="button icon ghost" aria-label="Снять выделение" onClick={() => {
          invalidateSelection(); setSelected([]); setFilterSelection(undefined);
        }}><X size={17} /></button>
      </div>}
      <ErrorMessage text={result.error || selectionError} />
      {!result.data ? !result.error && <Loading /> : rows.length ? <>
        <div className="table-scroll">
          <table className="data-table address-table">
            <thead><tr>
              <th className="check-cell"><input type="checkbox" ref={checkAll} checked={checked}
                disabled={selectionBusy || query !== filters.q}
                aria-label={selectPageOnly ? 'Выбрать страницу' : 'Выбрать все по фильтру'} onChange={toggleAll} /></th>
              {columns.map(column => <th key={column.key} aria-sort={filters.sort === column.key
                ? filters.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                <button className="sort" onClick={() => update({
                  sort: column.key, direction: filters.sort === column.key && filters.direction === 'asc' ? 'desc' : 'asc',
                })}>{column.label}{filters.sort === column.key
                    ? filters.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
                    : <ArrowDownUp size={13} className="sort-muted" />}</button>
              </th>)}
              <th><span className="sr-only">Действия</span></th>
            </tr></thead>
            <tbody>{rows.map(address => <tr key={address.id} className={selectedIds.has(address.id) ? 'highlight' : ''}>
              <td className="check-cell"><input type="checkbox" aria-label={`Выбрать ${address.url}`}
                checked={selectedIds.has(address.id)} disabled={selected.length === ADDRESS_SELECTION_LIMIT && !selectedIds.has(address.id)} onChange={event => {
                  invalidateSelection();
                  const checked = event.target.checked;
                  setSelected(current => checked ? [...current, address.id] : current.filter(id => id !== address.id));
                }} /></td>
              <td className="url-cell"><button className="url-link" onClick={() => inspect(address.id)} title={address.url}><bdi>{address.url}</bdi></button>
                {address.label && <small>{address.label}</small>}</td>
              <td><Status result={address.latest} /></td>
              <td><span className={address.latest?.httpCode ? 'mono' : 'muted'}>{address.latest?.httpCode ?? '—'}</span></td>
              <td>{address.latest?.durationMs != null ? `${address.latest.durationMs} мс` : <span className="muted">—</span>}</td>
              <td><span className="date-cell">{date(address.latest?.checkedAt)}</span></td>
              <td className="actions-cell"><div className="row-actions">
                <button className="button icon ghost" disabled={busy} aria-label={`Проверить ${address.url}`} title="Проверить URL" onClick={() => start([address.id])}><Play size={15} /></button>
                <button className="button icon ghost" aria-label={`Редактировать ${address.url}`} title="Редактировать URL" onClick={() => edit(address)}><Pencil size={15} /></button>
                {activeGroup ? <button className="button icon ghost" disabled={groupTask.busy} aria-label={`Убрать ${address.url} из группы`}
                  title="Убрать из группы" onClick={() => removeFromGroup([address.id])}><FolderMinus size={15} /></button>
                  : <button className="button icon ghost danger-ghost" aria-label={`Удалить ${address.url}`} title="Удалить URL" onClick={() => remove([address.id], key)}><Trash2 size={15} /></button>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>{startAt + 1}–{startAt + rows.length} из {formatNumber(filteredCount)}</span>
          <div className="pagination"><button className="button icon secondary" aria-label="Предыдущая страница" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}><ChevronLeft size={16} /></button>
            <span>{activePage} / {pages}</span>
            <button className="button icon secondary" aria-label="Следующая страница" disabled={activePage === pages} onClick={() => setPage(activePage + 1)}><ChevronRight size={16} /></button>
          </div>
        </div>
      </> : activeGroup?.count === 0 ? <Empty icon={<FolderPlus size={24} />} title="В группе пока нет адресов"
        text="В общем списке отметьте нужные URL и нажмите «Добавить в группу»."
        action={<button className="button small secondary" onClick={() => chooseGroup()}>Показать все адреса</button>} />
      : <Empty icon={<Search size={24} />} title="Адреса не найдены" text="Измените запрос или сбросьте фильтры." />}
    </> : <Empty icon={<Link2 size={26} />} title="В проекте пока нет адресов"
      text="Добавьте один URL, вставьте список или загрузите адреса из sitemap."
      action={<button ref={addButton} className="button primary" onClick={importUrls}><Plus size={17} /> Добавить URL</button>} />}
    </section>
    {addToGroup && groups.data && <AddToGroup path={groupsPath} groups={groups.data} ids={addToGroup} close={() => setAddToGroup(undefined)} saved={message => {
      setMessage(message);
      setAddToGroup(undefined);
      changeGroups();
    }} />}
    {deleteAll && <DeleteAllForm projectId={projectId} close={() => setDeleteAll(false)} fallbackFocus={() => addButton.current} deleted={({ deleted, stopped }) => {
      invalidateSelection();
      setSelected([]);
      setFilterSelection(undefined);
      setPage(1);
      setMessage(`Удалено адресов: ${formatNumber(deleted)}.${stopped ? ` Остановлено проверок: ${formatNumber(stopped)}.` : ''}`);
      setDeleteAll(false);
      addressesCleared();
    }} />}
  </>;
}
