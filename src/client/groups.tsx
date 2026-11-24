import { useState } from 'react';
import { Folder, History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { WorkGroup } from '../shared/types.js';
import { api, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { ErrorMessage, ExportMenu, FilterSelect, formatNumber, Modal } from './ui.js';

export function GroupControls({ path, groups, active, choose, changed, start, busy, showRuns, toggleRuns }: {
  path: string; groups?: WorkGroup[]; active?: WorkGroup; choose: (id?: number) => void; changed: () => void;
  start: (id: number) => void; busy: boolean; showRuns: boolean; toggleRuns: () => void;
}) {
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'rename' | 'delete'; group: WorkGroup }>();
  const close = () => setDialog(undefined);
  return <section className="panel work-groups" aria-label="Рабочие группы">
    <h2>Рабочие группы</h2>
    <div className="work-groups-row">
      <label className="work-group-select"><Folder size={17} aria-hidden="true" />
        <FilterSelect aria-label="Рабочая группа" value={active?.id ?? ''} disabled={!groups}
          onChange={event => choose(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">Все адреса</option>
          {groups?.map(group => <option key={group.id} value={group.id}>{group.name} ({formatNumber(group.count)})</option>)}
        </FilterSelect>
      </label>
      <button type="button" className="button small secondary" onClick={() => setDialog({ kind: 'create' })}>
        <Plus size={15} /> Новая группа
      </button>
      {active && <>
        <button type="button" className="button icon ghost" aria-label="Переименовать группу" title="Переименовать группу"
          onClick={() => setDialog({ kind: 'rename', group: active })}><Pencil size={16} /></button>
        <button type="button" className="button icon ghost danger-ghost" aria-label="Удалить группу" title="Удалить группу"
          onClick={() => setDialog({ kind: 'delete', group: active })}><Trash2 size={16} /></button>
      </>}
    </div>
    {active && <div className="work-groups-row work-group-actions">
      <button type="button" className="button small primary" disabled={!active.count || busy}
        onClick={() => start(active.id)}><Play size={15} /> Проверить группу целиком · {formatNumber(active.count)} URL</button>
      <button type="button" className="button small secondary" aria-expanded={showRuns} onClick={toggleRuns}>
        <History size={15} /> Прогоны группы
      </button>
      <ExportMenu path={`${path}/${active.id}`} label="Экспорт группы" />
    </div>}
    {dialog && (dialog.kind === 'delete'
      ? <ConfirmDeletion title="Удалить рабочую группу?" label="Удалить группу" close={close} confirm={async () => {
        await api(`${path}/${dialog.group.id}`, { method: 'DELETE' });
        choose();
        changed();
        close();
      }}><p>Группа «{dialog.group.name}» будет удалена. Её адреса останутся в проекте, а отчёты — в журнале запусков.</p></ConfirmDeletion>
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
  const task = useTask();
  return <Modal title={group ? 'Переименовать рабочую группу' : 'Новая рабочая группа'} close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name');
      void task.run(async () => saved(await write<WorkGroup>(group ? `${path}/${group.id}` : path, group ? 'PATCH' : 'POST', { name })));
    }}>
      <div className="modal-body form">
        <label>Название группы<input name="name" required maxLength={70} defaultValue={group?.name} autoFocus /></label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Отмена</button>
        <button type="submit" className="button primary" disabled={task.busy}>{group ? 'Сохранить' : 'Создать группу'}</button>
      </div>
    </form>
  </Modal>;
}

export function AddToGroup({ path, groups, ids, close, saved }: {
  path: string; groups: WorkGroup[]; ids: number[]; close: () => void; saved: (message: string) => void;
}) {
  const task = useTask();
  return <Modal title="Добавить в группу" close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      const groupId = Number(new FormData(event.currentTarget).get('group'));
      const group = groups.find(entry => entry.id === groupId);
      if (!group) return;
      void task.run(async () => {
        const { changed } = await write<{ changed: number }>(`${path}/${groupId}/members`, 'PATCH', { operation: 'add', ids });
        saved(changed ? `Добавлено в «${group.name}»: ${formatNumber(changed)}.` : `Выбранные URL уже входят в группу «${group.name}».`);
      });
    }}>
      <div className="modal-body form">
        <p className="field-note">Выбрано адресов: {formatNumber(ids.length)}.</p>
        <label>Куда добавить<select name="group" defaultValue="" required autoFocus>
          <option value="" disabled>Выберите группу</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select></label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>Отмена</button>
        <button type="submit" className="button primary" disabled={task.busy}>Добавить</button>
      </div>
    </form>
  </Modal>;
}
