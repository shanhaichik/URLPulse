import { useEffect, useId, useState } from 'react';
import { CalendarClock, Check, ChevronLeft, ChevronRight, FileUp, Gauge, Link2, List, LoaderCircle, Mail, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { ADDRESS_PAGE_SIZE, type DeleteAllOutcome, type DeleteAllPreview, type SelectedAddress } from '../shared/addresses.js';
import type { RequestProfileChoice, RequestProfilesView } from '../shared/request-profiles.js';
import { CHECK_CONCURRENCY, type AddressRow, type ImportResult, type Project, type Settings } from '../shared/types.js';
import { api, ApiResponseError, base, requestOrigin, requestProfilesPath, useQuery, useTask, write } from './api.js';
import { date, ErrorMessage, formatNumber, Loading, Modal } from './ui.js';

interface ModalProps { close: () => void }

function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <button className="button primary" type="submit" disabled={busy}>
    {busy && <LoaderCircle size={16} className="spin" />}{children}
  </button>;
}

export function ProjectForm({ close, saved, project }: ModalProps & {
  saved: (project: Project) => void; project?: Project;
}) {
  const task = useTask();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={project ? 'Редактировать проект' : 'Новый проект'}
    caption={project ? undefined : 'Объедините адреса, которые хотите проверять вместе.'} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const fields = new FormData(event.currentTarget);
      void task.run(async () => saved(await write<Project>(
        project ? base(project.id) : '/api/projects', project ? 'PATCH' : 'POST',
        { name: fields.get('name'), description: fields.get('description') },
      )));
    }}>
      <div className="modal-body form">
        <label>Название проекта<input name="name" maxLength={70} defaultValue={project?.name}
          placeholder="Например, Публичные сервисы" required data-initial-focus readOnly={task.busy} /></label>
        <label>Описание <span className="optional">необязательно</span>
          <textarea name="description" defaultValue={project?.description} maxLength={200} rows={3}
            placeholder="Коротко о том, что проверяем" readOnly={task.busy} />
        </label>
        {task.busy && <p className="field-note" role="status">Сохраняем проект. Форма закроется после подтверждения.</p>}
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button className="button secondary" type="button" onClick={dismiss} disabled={task.busy}>Отмена</button>
        <Submit busy={task.busy}>{project ? 'Сохранить изменения' : 'Создать проект'}</Submit></div>
    </form>
  </Modal>;
}

const importModes = [
  { id: 'list', label: 'Список URL', icon: List },
  { id: 'file', label: 'Файл sitemap', icon: FileUp },
  { id: 'url', label: 'Ссылка на sitemap', icon: Link2 },
] as const;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

export function ImportForm({ projectId, close, changed, openCatalog }: ModalProps & {
  projectId: number; changed: () => void; openCatalog: () => void;
}) {
  const [mode, setMode] = useState<typeof importModes[number]['id']>('list');
  const [input, setInput] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<ImportResult>();
  const task = useTask();
  const multiple = input.trim().split(/\r\n|\r|\n/).filter(line => line.trim()).length > 1;

  return <Modal title="Добавить URL" caption="Импортируйте один адрес, список или sitemap." close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      void task.run(async () => {
        const path = base(projectId) + '/urls';
        let imported: ImportResult;
        if (mode === 'list') {
          imported = await write(path, 'POST', { input, label });
        } else {
          if (mode === 'file' && (!file || file.size > 8 * 1024 * 1024)) {
            throw new Error('Выберите файл sitemap размером до 8 МиБ.');
          }
          imported = await write(path + '/sitemap', 'POST', mode === 'url' ? { url } : { file: await readBase64(file!) });
        }
        setResult(imported);
        changed();
      });
    }}>
      <div className="modal-body form">
        {result ? <>
          <div className="import-result">
            <span className="status ok"><Check size={14} /> Добавлено: {result.added}</span>
            <span className="status neutral">Дубликаты: {result.duplicates}</span>
            {result.invalid > 0 && <span className="status bad">Ошибки: {result.invalid}</span>}
            {result.skipped > 0 && <span className="status waiting">Сверх лимита: {result.skipped}</span>}
            {result.documents !== undefined && <span className="status neutral">Файлов sitemap: {result.documents}</span>}
          </div>
          {result.issues.length > 0 && <div className="import-issues">
            {result.issues.map(issue => <div key={issue.line}>
              <strong>{mode === 'list' ? 'Строка' : 'Запись'} {issue.line}</strong>
              <span>{issue.input}</span>
              <small>{issue.message}</small>
            </div>)}
          </div>}
          {result.issues.length < result.invalid + result.duplicates + result.skipped && <p className="muted">Показаны первые {result.issues.length} записей с замечаниями.</p>}
        </> : <>
          <div className="segmented" aria-label="Способ добавления">
            {importModes.map(({ id, label: title, icon: Icon }) => <button key={id} type="button"
              className={mode === id ? 'selected' : ''} aria-pressed={mode === id} disabled={task.busy}
              onClick={() => { setMode(id); task.clear(); }}><Icon size={15} />{title}</button>)}
          </div>
          {mode === 'list' && <>
            <label>Адреса<textarea value={input} onChange={event => setInput(event.target.value)}
              placeholder={'https://example.com/\nhttps://example.com/api/health'} rows={6} required autoFocus /></label>
            <p className="field-note">По одному адресу в строке, до 1 000 за раз.</p>
            {!multiple && <label>Название адреса <span className="optional">необязательно</span>
              <input value={label} onChange={event => setLabel(event.target.value)} maxLength={100} placeholder="Например, Главная страница" />
            </label>}
          </>}
          {mode === 'url' && <>
            <label>Ссылка на sitemap<input type="url" required value={url} onChange={event => setUrl(event.target.value)}
              maxLength={2000} placeholder="https://example.com/sitemap.xml" /></label>
            <p className="field-note">Поддерживаются XML, gzip и индексы sitemap.</p>
          </>}
          {mode === 'file' && <label className="upload-field">
            <Upload size={24} /><strong>Выберите файл</strong><span>XML или GZ, до 8 МиБ</span>
            <input aria-label="Выберите файл" type="file" accept=".xml,.gz,.gzip,application/xml,text/xml,application/gzip" required
              onChange={event => setFile(event.target.files?.[0])} />
          </label>}
          <ErrorMessage text={task.error} />
        </>}
        {mode !== 'list' && <div className="field-note">
          <p>Быстрый импорт добавляет URL сразу в «Адреса». Большие sitemap можно загрузить в каталог и выбрать, какие URL перенести в «Адреса».</p>
          <button type="button" className="text-button" disabled={task.busy} onClick={openCatalog}>Перейти в каталог sitemap</button>
        </div>}
      </div>
      <div className="modal-footer">
        {result ? <><button type="button" className="button secondary" onClick={() => { setResult(undefined); setFile(undefined); }}>
          Добавить ещё</button><button type="button" className="button primary" onClick={close}>Готово</button></>
          : <><button type="button" className="button secondary" onClick={close} disabled={task.busy}>Отмена</button>
            <Submit busy={task.busy}>{task.busy ? 'Импортируем…' : mode === 'list' ? 'Добавить адреса' : 'Импортировать sitemap'}</Submit></>}
      </div>
    </form>
  </Modal>;
}

export function EditForm({ projectId, address, close, changed }: ModalProps & {
  projectId: number; address: AddressRow; changed: () => void;
}) {
  const task = useTask();
  const path = `${base(projectId)}/urls/${address.id}`;
  const profiles = useQuery<RequestProfilesView>(requestProfilesPath(projectId));
  const assignment = useQuery<{ profileId: RequestProfileChoice }>(`${path}/request-profile`);
  const [url, setUrl] = useState(address.url);
  const [choice, setChoice] = useState<RequestProfileChoice>();
  const routeHint = useId();
  const origin = requestOrigin(url);
  const matchingProfiles = profiles.data?.profiles.filter(profile => profile.origin === origin) ?? [];
  const selected = choice === undefined ? assignment.data?.profileId : choice;
  const selectedOutsideOrigin = typeof selected === 'number' && !matchingProfiles.some(profile => profile.id === selected);
  const ready = !!(profiles.data && assignment.data);
  const selection = selectedOutsideOrigin ? 'inherit' : selected ?? null;
  const defaultName = matchingProfiles.find(profile => profile.isDefault)?.name;
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title="Редактировать URL" close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const fields = new FormData(event.currentTarget);
      void task.run(async () => {
        await write(path, 'PATCH', {
          url, label: fields.get('label'),
          ...(ready && selection !== assignment.data?.profileId && { profileId: selection }),
        });
        changed();
        close();
      });
    }}>
      <div className="modal-body form">
        <label>URL<input name="url" value={url} onChange={event => setUrl(event.target.value)} maxLength={2000} required data-initial-focus readOnly={task.busy} /></label>
        <label>Название адреса<input name="label" defaultValue={address.label} maxLength={100} readOnly={task.busy} /></label>
        <label>Профиль HTTP-запроса
          <select aria-describedby={routeHint} disabled={!ready || task.busy} value={!ready ? '' : selection === null ? 'direct' : selection} onChange={event => {
            const value = event.target.value;
            setChoice(value === 'inherit' ? value : value === 'direct' ? null : Number(value));
          }}>
            {!ready && <option value="">{profiles.error || assignment.error ? 'Профили недоступны' : 'Загрузка профилей…'}</option>}
            <option value="inherit">{defaultName ? `По правилу проекта · ${defaultName}` : 'По правилу проекта'}</option>
            <option value="direct">Без профиля</option>
            {matchingProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <p id={routeHint} className="field-note">Режим «Без профиля» использует прямое подключение.</p>
        {ready && selectedOutsideOrigin && <p className="field-note">Для этого сервера доступно назначение по правилу проекта или выбор совпадающего профиля.</p>}
        <ErrorMessage text={profiles.error || assignment.error} />
        <p className="field-note">Результаты для предыдущих версий сохранятся в истории.</p>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button className="button secondary" type="button" onClick={dismiss} disabled={task.busy}>Отмена</button>
        <Submit busy={task.busy}>Сохранить</Submit></div>
    </form>
  </Modal>;
}

export function DeleteForm({ projectId, ids, filters, close, changed }: ModalProps & {
  projectId: number; ids: number[]; filters: string; changed: () => void;
}) {
  const path = `${base(projectId)}/urls/delete`;
  const [preview, setPreview] = useState<SelectedAddress[]>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    void api<SelectedAddress[]>(path + '/preview?' + filters, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }), signal: controller.signal,
    }).then(setPreview, error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [path, filters, ids]);
  const hidden = preview?.filter(address => !address.matchesFilter).length ?? 0;
  const pages = Math.ceil((preview?.length ?? 0) / ADDRESS_PAGE_SIZE);
  return <ConfirmDeletion title={ids.length === 1 ? 'Удалить адрес?' : 'Удалить выбранные адреса?'}
    label="Удалить" close={close} ready={!!preview?.length} confirm={async () => {
      if (!preview) return;
      await write(path, 'POST', { ids: preview.map(address => address.id), versions: preview.map(address => address.version) });
      changed();
      close();
    }}>
    <p>Адреса будут удалены из активного списка. Их проверки сохранятся в отчётах проекта.</p>
    <ErrorMessage text={error} />
    {!preview && !error && <Loading />}
    {preview && <>
      <p>К удалению {formatNumber(preview.length)}{hidden > 0 && <> · <strong>Скрыто фильтром {formatNumber(hidden)}</strong></>}</p>
      <ul className="deletion-preview" aria-label="Адреса к удалению">
        {preview.slice((page - 1) * ADDRESS_PAGE_SIZE, page * ADDRESS_PAGE_SIZE).map(address =>
          <li key={address.id}><span>{address.url}</span>{!address.matchesFilter && <small>Скрыт фильтром</small>}</li>)}
      </ul>
      {pages > 1 && <nav className="pagination" aria-label="Страницы адресов к удалению">
        <button type="button" className="button icon secondary" aria-label="Предыдущая страница" disabled={page === 1}
          onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
        <span aria-live="polite">{page} / {pages}</span>
        <button type="button" className="button icon secondary" aria-label="Следующая страница" disabled={page === pages}
          onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
      </nav>}
    </>}
  </ConfirmDeletion>;
}

export function ConfirmDeletion({ title, label, close, confirm, children, ready = true, pendingLabel, fallbackFocus }: ModalProps & {
  title: string; label: string; confirm: () => Promise<void>; children: React.ReactNode; ready?: boolean; pendingLabel?: string;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const task = useTask();
  return <Modal title={title} close={() => { if (!task.busy) close(); }} fallbackFocus={fallbackFocus}>
    <form onSubmit={event => {
      event.preventDefault();
      if (ready && !task.busy) void task.run(confirm);
    }}>
      <div className="modal-body form">
        {children}
        {task.busy && pendingLabel && <p role="status">{pendingLabel}</p>}
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button className="button secondary" type="button" onClick={close} disabled={task.busy}>Отмена</button>
        <button className="button danger" type="submit" disabled={!ready || task.busy}><Trash2 size={16} /> {label}</button></div>
    </form>
  </Modal>;
}

export function DeleteAllForm({ projectId, close, deleted, fallbackFocus }: ModalProps & {
  projectId: number; deleted: (outcome: DeleteAllOutcome) => void; fallbackFocus?: () => HTMLElement | null;
}) {
  const path = `${base(projectId)}/urls/delete/all`;
  const { data, error, reset } = useQuery<DeleteAllPreview>(path);
  const hasChecks = data && (data.running > 0 || data.queued > 0);
  return <ConfirmDeletion title="Удалить все адреса проекта?"
    label={hasChecks ? 'Остановить и удалить' : 'Удалить все адреса'} close={close} fallbackFocus={fallbackFocus}
    ready={!!data?.addresses && !data.transferActive && !error} confirm={async () => {
      if (!data) return;
      try {
        deleted(await write<DeleteAllOutcome>(path, 'POST', { confirmation: data.confirmation }));
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
      <p><strong>Адресов к удалению: {formatNumber(data.addresses)}</strong></p>
      <p>Текущие проверки этого проекта будут остановлены, а проверки в очереди отменены.</p>
      {hasChecks && <p>Выполняется: {formatNumber(data.running)}. В очереди: {formatNumber(data.queued)}.</p>}
      <p>История проверок сохранится. Чтобы вернуть адрес в список, добавьте тот же URL снова.</p>
      {data.transferActive && <ErrorMessage text="Дождитесь завершения переноса из каталога или остановите его." />}
    </>}
  </ConfirmDeletion>;
}

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const zones = Array.from(new Set(['Europe/Moscow', 'UTC', ...Intl.supportedValuesOf('timeZone')]));

function settingsDraft(project: Project) {
  return {
    enabled: !!project.schedule, weekdays: project.schedule?.weekdays ?? [1, 2, 3, 4, 5],
    time: project.schedule?.time ?? '09:00', timezone: project.schedule?.timezone ?? 'Europe/Moscow',
    checkConcurrency: String(project.checkConcurrency), notify: project.notify, email: project.email ?? '',
    tlsProfile: project.tlsProfile,
  };
}

export function SettingsForm({ project, schedulesPaused, smtpConfigured, saved, registerLeaveGuard }: {
  project: Project; schedulesPaused: boolean; smtpConfigured: boolean; saved: () => void;
  registerLeaveGuard?: (guard: (() => boolean) | undefined) => void;
}) {
  const [persisted, setPersisted] = useState(() => settingsDraft(project));
  const [draft, setDraft] = useState(() => settingsDraft(project));
  const { enabled, weekdays, checkConcurrency } = draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(persisted);
  const defaultConcurrency = String(CHECK_CONCURRENCY.default);
  const concurrencyNote = useId();
  const [confirmed, setConfirmed] = useState(false);
  const task = useTask();

  function edit(change: Partial<typeof draft>) {
    setDraft(current => ({ ...current, ...change }));
    setConfirmed(false);
  }

  useEffect(() => {
    const canLeave = () => !task.busy && (!dirty || window.confirm('Отбросить несохранённые настройки проекта? Чтобы сохранить изменения, отмените переход и сохраните настройки.'));
    registerLeaveGuard?.(canLeave);
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || !dirty || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (!canLeave()) return;
      setDraft(persisted);
      setConfirmed(false);
      task.clear();
    }
    document.addEventListener('keydown', escape);
    return () => {
      registerLeaveGuard?.(undefined);
      document.removeEventListener('keydown', escape);
    };
  }, [registerLeaveGuard, dirty, persisted, task.busy]);

  return <form className="settings-grid" onSubmit={event => {
    event.preventDefault();
    if (task.busy) return;
    const submitted = draft;
    void task.run(async () => {
      if (enabled && !weekdays.length) throw new Error('Выберите хотя бы один день недели.');
      const settings: Settings = {
        schedule: enabled ? { weekdays, time: submitted.time, timezone: submitted.timezone } : null,
        notify: submitted.notify, tlsProfile: submitted.tlsProfile,
        checkConcurrency: Number(submitted.checkConcurrency), email: submitted.email || null,
      };
      await write(base(project.id) + '/settings', 'PATCH', settings);
      setPersisted(submitted);
      saved();
      setConfirmed(true);
    });
  }}>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon violet"><Gauge size={19} /></span><h2>Проверки</h2></div>
      <div className="form">
        <div className="check-limit-controls">
          <label>Одновременных проверок<input name="checkConcurrency" type="number" required step={1}
            min={CHECK_CONCURRENCY.min} max={CHECK_CONCURRENCY.max} value={checkConcurrency}
            aria-describedby={concurrencyNote} onChange={event => edit({ checkConcurrency: event.target.value })} /></label>
          <button className="button secondary" type="button" disabled={checkConcurrency === defaultConcurrency}
            onClick={() => edit({ checkConcurrency: defaultConcurrency })}>Сбросить до {defaultConcurrency}</button>
        </div>
        <p id={concurrencyNote} className="field-note">От {CHECK_CONCURRENCY.min} до {CHECK_CONCURRENCY.max}. По умолчанию {defaultConcurrency}.
          Сохранённый лимит применяется при начале следующего запуска.</p>
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon violet"><CalendarClock size={19} /></span>
        <div><h2>Расписание</h2><p>Запуски по дням недели в выбранном часовом поясе.</p></div></div>
      <div className="form">
        <label className="inline-check"><input type="checkbox" checked={enabled} onChange={event => edit({ enabled: event.target.checked })} /> Включить расписание</label>
        <fieldset className="form schedule-fields" hidden={!enabled} disabled={!enabled}>
          <legend>Дни недели</legend>
          <div className="weekdays">{days.map((name, index) => <label key={name}>
            <input className="sr-only" type="checkbox" checked={weekdays.includes(index + 1)} onChange={event => {
              edit({ weekdays: event.target.checked ? [...weekdays, index + 1].sort() : weekdays.filter(day => day !== index + 1) });
            }} /><span>{name}</span>
          </label>)}</div>
          <div className="form two-fields">
            <label>Время<input name="time" type="time" required value={draft.time} onChange={event => edit({ time: event.target.value })} /></label>
            <label>Часовой пояс<input name="timezone" list="timezones" required value={draft.timezone} onChange={event => edit({ timezone: event.target.value })} />
              <datalist id="timezones">{zones.map(zone => <option value={zone} key={zone} />)}</datalist>
            </label>
          </div>
        </fieldset>
        {project.schedule && schedulesPaused
          ? <p className="field-note">Расписание проекта на паузе. Возобновите расписания в настройках приложения.</p>
          : project.nextAt && <p className="field-note">Следующий запуск — {date(project.nextAt, project.schedule?.timezone)} ({project.schedule?.timezone}).</p>}
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon blue"><Mail size={19} /></span>
        <div><h2>Уведомления</h2><p>Сводка о завершении запуска в ленте и по email.</p></div></div>
      <div className="form">
        <label>Когда уведомлять<select name="notify" value={draft.notify} onChange={event => edit({ notify: event.target.value as Settings['notify'] })}>
          <option value="all">Все результаты</option><option value="errors">Только при ошибках</option><option value="off">Выключено</option>
        </select></label>
        <label>Email получателя <span className="optional">необязательно</span>
          <input name="email" type="email" value={draft.email} onChange={event => edit({ email: event.target.value })} maxLength={254} placeholder="name@example.com" />
        </label>
        <p className="field-note">{smtpConfigured ? 'SMTP настроен. Укажите получателя для отправки писем.'
          : window.pulseDesktop ? 'SMTP можно подключить в настройках приложения.'
            : 'SMTP ещё не настроен. Его можно подключить через файл .env сервера.'}</p>
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon green"><ShieldCheck size={19} /></span>
        <div><h2>HTTPS</h2><p>Доверенные центры сертификации для проверок и sitemap этого проекта.</p></div></div>
      <div className="form"><label>Профиль HTTPS<select name="tlsProfile" value={draft.tlsProfile}
        onChange={event => edit({ tlsProfile: event.target.value === 'russian-ca' ? 'russian-ca' : 'default' })}>
        <option value="default">Штатные сертификаты</option>
        <option value="russian-ca">Штатные сертификаты + Российский CA</option>
      </select></label></div>
    </section>
    <div className="settings-footer"><Submit busy={task.busy}>Сохранить настройки</Submit>
      {task.busy && <span className="field-note" role="status">Сохранение отправленной версии…</span>}
      {confirmed && !dirty && <span className="status ok" role="status"><Check size={15} /> Настройки сохранены</span>}
      {confirmed && dirty && <span className="field-note" role="status">Отправленная версия сохранена. <span>Последние изменения не сохранены.</span></span>}
      {!confirmed && dirty && <span className="field-note">Последние изменения не сохранены.</span>}
      <ErrorMessage text={task.error} />
    </div>
  </form>;
}
