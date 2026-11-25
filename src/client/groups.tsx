import { useState } from 'react';
import { Folder, History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { WorkGroup } from '../shared/types.js';
import { api, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { ErrorMessage, ExportMenu, FilterSelect, formatNumber, Modal } from './ui.js';
import { groupsMessages } from '../shared/i18n/locales/groups.js';
import { createMessages } from './i18n.js';

const useText = createMessages('groups', groupsMessages);

export function GroupControls({ path, groups, active, choose, changed, start, busy, showRuns, toggleRuns }: {
  path: string; groups?: WorkGroup[]; active?: WorkGroup; choose: (id?: number) => void; changed: () => void;
  start: (id: number) => void; busy: boolean; showRuns: boolean; toggleRuns: () => void;
}) {
  const t = useText();
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'rename' | 'delete'; group: WorkGroup }>();
  const close = () => setDialog(undefined);
  return <section className="panel work-groups" aria-label={t('heading')}>
    <h2>{t('heading')}</h2>
    <div className="work-groups-row">
      <label className="work-group-select"><Folder size={17} aria-hidden="true" />
        <FilterSelect aria-label={t('selector')} value={active?.id ?? ''} disabled={!groups}
          onChange={event => choose(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">{t('allUrls')}</option>
          {groups?.map(group => <option key={group.id} value={group.id}>{group.name} ({formatNumber(group.count)})</option>)}
        </FilterSelect>
      </label>
      <button type="button" className="button small secondary" onClick={() => setDialog({ kind: 'create' })}>
        <Plus size={15} /> {t('newGroup')}
      </button>
      {active && <>
        <button type="button" className="button icon ghost" aria-label={t('renameGroup')} title={t('renameGroup')}
          onClick={() => setDialog({ kind: 'rename', group: active })}><Pencil size={16} /></button>
        <button type="button" className="button icon ghost danger-ghost" aria-label={t('deleteGroup')} title={t('deleteGroup')}
          onClick={() => setDialog({ kind: 'delete', group: active })}><Trash2 size={16} /></button>
      </>}
    </div>
    {active && <div className="work-groups-row work-group-actions">
      <button type="button" className="button small primary" disabled={!active.count || busy}
        onClick={() => start(active.id)}><Play size={15} /> {t('checkGroup', { count: formatNumber(active.count) })}</button>
      <button type="button" className="button small secondary" aria-expanded={showRuns} onClick={toggleRuns}>
        <History size={15} /> {t('groupRuns')}
      </button>
      <ExportMenu path={`${path}/${active.id}`} label={t('exportGroup')} />
    </div>}
    {dialog && (dialog.kind === 'delete'
      ? <ConfirmDeletion title={t('deleteTitle')} label={t('deleteGroup')} close={close} confirm={async () => {
        await api(`${path}/${dialog.group.id}`, { method: 'DELETE' });
        choose();
        changed();
        close();
      }}><p>{t('deleteDescription', { name: dialog.group.name })}</p></ConfirmDeletion>
      : <GroupForm key={dialog.kind} path={path} group={dialog.kind === 'rename' ? dialog.group : undefined} close={close} saved={group => {
        choose(group.id);
        changed();
        close();
      }} />)}
  </section>;
}

function GroupForm({ path, group, close, saved }: {
  path: string; group?: WorkGroup; close: () => void; saved: (group: WorkGroup) => void;
}) {
  const t = useText();
  const task = useTask();
  return <Modal title={group ? t('renameTitle') : t('createTitle')} close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name');
      void task.run(async () => saved(await write<WorkGroup>(group ? `${path}/${group.id}` : path, group ? 'PATCH' : 'POST', { name })));
    }}>
      <div className="modal-body form">
        <label>{t('name')}<input name="name" required maxLength={70} defaultValue={group?.name} autoFocus /></label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={task.busy}>{group ? t('save') : t('create')}</button>
      </div>
    </form>
  </Modal>;
}

export function AddToGroup({ path, groups, ids, close, saved }: {
  path: string; groups: WorkGroup[]; ids: number[]; close: () => void; saved: (result: { name: string; changed: number }) => void;
}) {
  const t = useText();
  const task = useTask();
  return <Modal title={t('addToGroup')} close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      const groupId = Number(new FormData(event.currentTarget).get('group'));
      const group = groups.find(entry => entry.id === groupId);
      if (!group) return;
      void task.run(async () => {
        const { changed } = await write<{ changed: number }>(`${path}/${groupId}/members`, 'PATCH', { operation: 'add', ids });
        saved({ name: group.name, changed });
      });
    }}>
      <div className="modal-body form">
        <p className="field-note">{t('selectionCount', { count: formatNumber(ids.length) })}</p>
        <label>{t('destination')}<select name="group" defaultValue="" required autoFocus>
          <option value="" disabled>{t('chooseGroup')}</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select></label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={task.busy}>{t('add')}</button>
      </div>
    </form>
  </Modal>;
}
