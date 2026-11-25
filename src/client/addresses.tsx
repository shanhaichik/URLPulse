import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, FolderMinus, FolderPlus, Link2, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { ADDRESS_PAGE_SIZE, ADDRESS_SELECTION_LIMIT, defaultFilters } from '../shared/addresses.js';
import type { AddressRow, AddressFilters, AddressSort, AddressStatus, WorkGroup } from '../shared/types.js';
import { api, base, localizedFailure, useQuery, useTask, write } from './api.js';
import { DeleteAllForm } from './forms.js';
import { AddToGroup, GroupControls } from './groups.js';
import { RunList } from './reports.js';
import { date, Empty, ErrorMessage, FilterSelect, formatNumber, Loading, Status } from './ui.js';
import { addressesMessages } from '../shared/i18n/locales/addresses.js';
import { createTranslator } from '../shared/i18n/index.js';
import { createMessages, LocalizedError, useLanguage } from './i18n.js';

const useText = createMessages('addresses', addressesMessages);

const columns = ['url', 'status', 'httpCode', 'durationMs', 'checkedAt'] as const satisfies readonly AddressSort[];
const statuses: AddressStatus[] = ['all', 'ok', 'error', 'unchecked'];

type Feedback =
  | { kind: 'added'; name: string; changed: number }
  | { kind: 'removed'; name: string; changed: number }
  | { kind: 'cleared'; deleted: number; stopped: number };

type AddressPage = { items: AddressRow[]; total: number; page: number };

export function AddressList({ projectId, revision, total, deletedIds, importUrls, start, startGroup, edit, remove, inspect, busy,
  addressesCleared, journalRevision, openRun, openComparison, groupId, showRuns, changeGroup }: {
  projectId: number; revision: string; total: number; deletedIds?: number[];
  importUrls: () => void; start: (ids?: number[]) => void; startGroup: (id: number) => void; edit: (address: AddressRow) => void;
  remove: (ids: number[], filters: string) => void; inspect: (id: number) => void; busy: boolean;
  addressesCleared: () => void; journalRevision: number; openRun: (id: number) => void; openComparison: () => void;
  groupId?: number; showRuns: boolean; changeGroup: (groupId?: number, showRuns?: boolean) => void;
}) {
  const t = useText();
  const locale = useLanguage();
  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState(filters.q);
  const [selected, setSelected] = useState<number[]>([]);
  const [filterSelection, setFilterSelection] = useState<{ key: string; ids: number[] }>();
  const [page, setPage] = useState(1);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionError, setSelectionError] = useState<unknown>();
  const selectionIntent = useRef(0);
  const [addToGroup, setAddToGroup] = useState<number[]>();
  const [feedback, setFeedback] = useState<Feedback>();
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
    setFeedback(undefined);
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
    setSelectionError(undefined);
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
      setFeedback({ kind: 'added', name: group.name, changed });
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
      setFeedback({ kind: 'removed', name: activeGroup.name, changed });
      changeGroups();
    });
  }

  async function toggleAll() {
    const intent = ++selectionIntent.current;
    const isCurrent = () => selectionIntent.current === intent && currentKey.current === snapshotKey;
    setSelectionBusy(true);
    setSelectionError(undefined);
    try {
      let ids = rows.map(row => row.id);
      if (!selectPageOnly) {
        const selection = await api<{ ids: number[]; exceeded: boolean }>(path + '/selection?' + key);
        if (!isCurrent()) return;
        if (selection.exceeded) throw new LocalizedError(language => createTranslator(language, 'addresses', addressesMessages)('selectionLimitFilter'));
        ids = selection.ids;
        setFilterSelection({ key: snapshotKey, ids });
      }
      const items = new Set(ids);
      const next = checked ? selected.filter(id => !items.has(id)) : [...new Set([...selected, ...ids])];
      if (next.length > ADDRESS_SELECTION_LIMIT) throw new LocalizedError(language => createTranslator(language, 'addresses', addressesMessages)('selectionLimit'));
      setSelected(next);
    } catch (error) {
      if (isCurrent()) setSelectionError(() => error);
    } finally {
      if (selectionIntent.current === intent) setSelectionBusy(false);
    }
  }

  const message = feedback?.kind === 'added' ? (feedback.changed
    ? t('groupAdded', { name: feedback.name, count: formatNumber(feedback.changed) })
    : t('alreadyInGroup', { name: feedback.name }))
    : feedback?.kind === 'removed' ? t('groupRemoved', { name: feedback.name, count: formatNumber(feedback.changed) })
    : feedback?.kind === 'cleared' ? (feedback.stopped
      ? t('deletedAndStopped', { deleted: formatNumber(feedback.deleted), stopped: formatNumber(feedback.stopped) })
      : t('deletedCount', { count: formatNumber(feedback.deleted) })) : undefined;

  return <>
    <GroupControls path={groupsPath} groups={groups.data} active={activeGroup} choose={chooseGroup} changed={changeGroups}
      start={startGroup} busy={busy} showRuns={showRuns} toggleRuns={() => changeGroup(groupId, !showRuns)} />
    <ErrorMessage text={groups.error || groupTask.error} />
    {message && <p className="address-feedback" role="status">{message}</p>}
    {activeGroup && showRuns && <RunList key={activeGroup.id} projectId={projectId} groupId={activeGroup.id} revision={journalRevision}
      open={openRun} openComparison={openComparison} />}
    <section className="panel address-panel">
    <div className="panel-heading">
      <div className="panel-title"><h2>{activeGroup?.name ?? t('heading')}</h2><span className="count">{t('total', { count: formatNumber(scopeTotal) })}</span></div>
      <div className="address-actions">
        {total > 0 && <button ref={addButton} className="button primary" onClick={importUrls}><Plus size={17} />
          {activeGroup ? t('addToProject') : t('addUrl')}</button>}
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
            }}>{t('actions')} <ChevronDown size={14} aria-hidden="true" /></button>
          <div className={actionsAbove ? 'menu-items above' : 'menu-items'} ref={actionsItems} id={actionsId} hidden={!actionsOpen}>
            <button type="button" disabled={!canDeleteAll} onClick={() => {
              closeActions();
              setDeleteAll(true);
            }}><Trash2 size={15} aria-hidden="true" /> {t('deleteProjectUrls')}</button>
            {!canDeleteAll && <p>{groupId === undefined
              ? t('resetSearchAndStatus')
              : t('resetFromAllUrls')}</p>}
          </div>
        </div>}
      </div>
    </div>
    {total ? <>
      <div className="address-filters">
        <div className="table-toolbar">
          <label className="search">
            <Search size={17} /><input ref={searchInput} type="search" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')}
              maxLength={2000} value={filters.q} onChange={event => update({ q: event.target.value })} />
          </label>
          <FilterSelect aria-label={t('statusFilter')} value={filters.status}
            onChange={event => update({ status: event.target.value as AddressStatus })}>
            {statuses.map(status => <option key={status} value={status}>{t(`status_${status}`)}</option>)}
          </FilterSelect>
        </div>
        {filtered && <div className="address-filter-summary">
          <span role="status">{query === filters.q && result.data
            ? t('found', { count: formatNumber(filteredCount), total: formatNumber(scopeTotal) }) : ''}</span>
          <button type="button" className="button small ghost" onClick={resetFilters}>{t('resetFilters')}</button>
        </div>}
      </div>
      {(selected.length > 0 || selectionBusy) && <div className="bulk-bar">
        {selectionBusy ? <strong role="status">{t('selecting')}</strong> : <strong>{t('selected', { count: formatNumber(selected.length) })}</strong>}
        {selected.length > 0 && <>
        {result.data && selected.length > checks && <span>{t('offPage', { count: formatNumber(selected.length - checks) })}</span>}
        <button className="button small primary" disabled={busy || selectionUpdating} onClick={() => start(selected)}><Play size={14} /> {t('checkSelected')}</button>
        {activeGroup && <button className="button small secondary" disabled={selectionBusy || groupTask.busy}
          onClick={() => addToCurrentGroup(activeGroup)}><FolderPlus size={14} /> {t('addToNamedGroup', { name: activeGroup.name })}</button>}
        {!!groups.data?.length && <button className="button small secondary" disabled={selectionUpdating || groupTask.busy}
          onClick={() => setAddToGroup(selected)}><FolderPlus size={14} /> {t('addToGroup')}</button>}
        {activeGroup ? <button className="button small secondary" disabled={selectionUpdating || groupTask.busy}
          onClick={() => removeFromGroup(selected)}><FolderMinus size={14} /> {t('removeFromGroup')}</button>
          : <button className="button small secondary" disabled={selectionUpdating} onClick={() => remove(selected, key)}><Trash2 size={14} /> {t('deleteSelected')}</button>}
        </>}
        <button className="button icon ghost" aria-label={t('deselect')} onClick={() => {
          invalidateSelection(); setSelected([]); setFilterSelection(undefined);
        }}><X size={17} /></button>
      </div>}
      <ErrorMessage text={result.error || (selectionError ? localizedFailure(selectionError, locale) : undefined)} />
      {!result.data ? !result.error && <Loading /> : rows.length ? <>
        <div className="table-scroll">
          <table className="data-table address-table">
            <thead><tr>
              <th className="check-cell"><input type="checkbox" ref={checkAll} checked={checked}
                disabled={selectionBusy || query !== filters.q}
                aria-label={selectPageOnly ? t('selectPage') : t('selectFiltered')} onChange={toggleAll} /></th>
              {columns.map(column => <th key={column} aria-sort={filters.sort === column
                ? filters.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                <button className="sort" onClick={() => update({
                  sort: column, direction: filters.sort === column && filters.direction === 'asc' ? 'desc' : 'asc',
                })}>{t(`column_${column}`)}{filters.sort === column
                    ? filters.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
                    : <ArrowDownUp size={13} className="sort-muted" />}</button>
              </th>)}
              <th><span className="sr-only">{t('actions')}</span></th>
            </tr></thead>
            <tbody>{rows.map(address => <tr key={address.id} className={selectedIds.has(address.id) ? 'highlight' : ''}>
              <td className="check-cell"><input type="checkbox" aria-label={t('selectUrl', { url: address.url })}
                checked={selectedIds.has(address.id)} disabled={selected.length === ADDRESS_SELECTION_LIMIT && !selectedIds.has(address.id)} onChange={event => {
                  invalidateSelection();
                  const checked = event.target.checked;
                  setSelected(current => checked ? [...current, address.id] : current.filter(id => id !== address.id));
                }} /></td>
              <td className="url-cell"><button className="url-link" onClick={() => inspect(address.id)} title={address.url}><bdi>{address.url}</bdi></button>
                {address.label && <small>{address.label}</small>}</td>
              <td><Status result={address.latest} /></td>
              <td><span className={address.latest?.httpCode ? 'mono' : 'muted'}>{address.latest?.httpCode ?? '—'}</span></td>
              <td>{address.latest?.durationMs != null ? t('duration', { value: formatNumber(address.latest.durationMs) }) : <span className="muted">—</span>}</td>
              <td><span className="date-cell">{date(address.latest?.checkedAt)}</span></td>
              <td className="actions-cell"><div className="row-actions">
                <button className="button icon ghost" disabled={busy} aria-label={t('checkUrl', { url: address.url })} title={t('checkUrlTitle')} onClick={() => start([address.id])}><Play size={15} /></button>
                <button className="button icon ghost" aria-label={t('editUrl', { url: address.url })} title={t('editUrlTitle')} onClick={() => edit(address)}><Pencil size={15} /></button>
                {activeGroup ? <button className="button icon ghost" disabled={groupTask.busy} aria-label={t('removeUrlFromGroup', { url: address.url })}
                  title={t('removeFromGroup')} onClick={() => removeFromGroup([address.id])}><FolderMinus size={15} /></button>
                  : <button className="button icon ghost danger-ghost" aria-label={t('deleteUrl', { url: address.url })} title={t('deleteUrlTitle')} onClick={() => remove([address.id], key)}><Trash2 size={15} /></button>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>{t('range', { start: formatNumber(startAt + 1), end: formatNumber(startAt + rows.length), total: formatNumber(filteredCount) })}</span>
          <div className="pagination"><button className="button icon secondary" aria-label={t('previousPage')} disabled={activePage === 1} onClick={() => setPage(activePage - 1)}><ChevronLeft size={16} /></button>
            <span>{formatNumber(activePage)} / {formatNumber(pages)}</span>
            <button className="button icon secondary" aria-label={t('nextPage')} disabled={activePage === pages} onClick={() => setPage(activePage + 1)}><ChevronRight size={16} /></button>
          </div>
        </div>
      </> : activeGroup?.count === 0 ? <Empty icon={<FolderPlus size={24} />} title={t('groupEmpty')}
        text={t('groupEmptyHint')}
        action={<button className="button small secondary" onClick={() => chooseGroup()}>{t('showAllUrls')}</button>} />
      : <Empty icon={<Search size={24} />} title={t('noMatches')} text={t('noMatchesHint')} />}
    </> : <Empty icon={<Link2 size={26} />} title={t('projectEmpty')}
      text={t('projectEmptyHint')}
      action={<button ref={addButton} className="button primary" onClick={importUrls}><Plus size={17} /> {t('addUrl')}</button>} />}
    </section>
    {addToGroup && groups.data && <AddToGroup path={groupsPath} groups={groups.data} ids={addToGroup} close={() => setAddToGroup(undefined)} saved={addition => {
      setFeedback({ kind: 'added', ...addition });
      setAddToGroup(undefined);
      changeGroups();
    }} />}
    {deleteAll && <DeleteAllForm projectId={projectId} close={() => setDeleteAll(false)} fallbackFocus={() => addButton.current} deleted={({ deleted, stopped }) => {
      invalidateSelection();
      setSelected([]);
      setFilterSelection(undefined);
      setPage(1);
      setFeedback({ kind: 'cleared', deleted, stopped });
      setDeleteAll(false);
      addressesCleared();
    }} />}
  </>;
}
