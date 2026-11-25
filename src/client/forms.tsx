import { useEffect, useId, useState } from 'react';
import { CalendarClock, Check, ChevronLeft, ChevronRight, FileUp, Gauge, Link2, List, LoaderCircle, Mail, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { ADDRESS_PAGE_SIZE, type DeleteAllOutcome, type DeleteAllPreview, type SelectedAddress } from '../shared/addresses.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createTranslator } from '../shared/i18n/index.js';
import { formsMessages } from '../shared/i18n/locales/forms.js';
import type { RequestProfileChoice, RequestProfilesView } from '../shared/request-profiles.js';
import { CHECK_CONCURRENCY, type AddressRow, type ImportResult, type Project, type Settings } from '../shared/types.js';
import { api, ApiResponseError, base, localizedFailure, requestOrigin, requestProfilesPath, useQuery, useTask, write } from './api.js';
import { createMessages, currentLocale, LocalizedError } from './i18n.js';
import { date, ErrorMessage, formatNumber, Loading, Modal } from './ui.js';

const useText = createMessages('forms', formsMessages);
const formError = (key: keyof typeof formsMessages) =>
  new LocalizedError(locale => createTranslator(locale, 'forms', formsMessages)(key));

interface ModalProps { close: () => void }

function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <button className="button primary" type="submit" disabled={busy}>
    {busy && <LoaderCircle size={16} className="spin" />}{children}
  </button>;
}

export function ProjectForm({ close, saved, project }: ModalProps & {
  saved: (project: Project) => void; project?: Project;
}) {
  const t = useText();
  const task = useTask();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={project ? t('editProject') : t('newProject')}
    caption={project ? undefined : t('projectCaption')} close={dismiss} closeDisabled={task.busy}>
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
        <label>{t('projectName')}<input name="name" maxLength={70} defaultValue={project?.name}
          placeholder={t('projectNameExample')} required data-initial-focus readOnly={task.busy} /></label>
        <label>{t('description')} <span className="optional">{t('optional')}</span>
          <textarea name="description" defaultValue={project?.description} maxLength={200} rows={3}
            placeholder={t('projectDescriptionExample')} readOnly={task.busy} />
        </label>
        {task.busy && <p className="field-note" role="status">{t('savingProject')}</p>}
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button className="button secondary" type="button" onClick={dismiss} disabled={task.busy}>{t('cancel')}</button>
        <Submit busy={task.busy}>{project ? t('saveChanges') : t('createProject')}</Submit></div>
    </form>
  </Modal>;
}

const importModes = [
  { id: 'list', label: 'importList', icon: List },
  { id: 'file', label: 'importFile', icon: FileUp },
  { id: 'url', label: 'importUrl', icon: Link2 },
] as const;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(formError('fileReadError'));
    reader.readAsDataURL(file);
  });
}

export function ImportForm({ projectId, close, changed, openCatalog }: ModalProps & {
  projectId: number; changed: () => void; openCatalog: () => void;
}) {
  const t = useText();
  const [mode, setMode] = useState<typeof importModes[number]['id']>('list');
  const [input, setInput] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<ImportResult>();
  const task = useTask();
  const multiple = input.trim().split(/\r\n|\r|\n/).filter(line => line.trim()).length > 1;

  return <Modal title={t('addUrl')} caption={t('importCaption')} close={close}>
    <form onSubmit={event => {
      event.preventDefault();
      void task.run(async () => {
        const path = base(projectId) + '/urls';
        let imported: ImportResult;
        if (mode === 'list') {
          imported = await write(path, 'POST', { input, label });
        } else {
          if (mode === 'file' && (!file || file.size > 8 * 1024 * 1024)) {
            throw formError('sitemapFileLimit');
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
            <span className="status ok"><Check size={14} /> {t('importAdded', { count: formatNumber(result.added) })}</span>
            <span className="status neutral">{t('importDuplicates', { count: formatNumber(result.duplicates) })}</span>
            {result.invalid > 0 && <span className="status bad">{t('importErrors', { count: formatNumber(result.invalid) })}</span>}
            {result.skipped > 0 && <span className="status waiting">{t('importSkipped', { count: formatNumber(result.skipped) })}</span>}
            {result.documents !== undefined && <span className="status neutral">{t('importDocuments', { count: formatNumber(result.documents) })}</span>}
          </div>
          {result.issues.length > 0 && <div className="import-issues">
            {result.issues.map(issue => <div key={issue.line}>
              <strong>{t(mode === 'list' ? 'importLine' : 'importEntry', { number: formatNumber(issue.line) })}</strong>
              <span>{issue.input}</span>
              <small>{translateDiagnostic(issue.message, currentLocale())}</small>
            </div>)}
          </div>}
          {result.issues.length < result.invalid + result.duplicates + result.skipped && <p className="muted">
            {t('firstImportIssues', { count: result.issues.length })}
          </p>}
        </> : <>
          <div className="segmented" aria-label={t('importMethod')}>
            {importModes.map(({ id, label, icon: Icon }) => <button key={id} type="button"
              className={mode === id ? 'selected' : ''} aria-pressed={mode === id} disabled={task.busy}
              onClick={() => { setMode(id); task.clear(); }}><Icon size={15} />{t(label)}</button>)}
          </div>
          {mode === 'list' && <>
            <label>{t('urls')}<textarea value={input} onChange={event => setInput(event.target.value)}
              placeholder={'https://example.com/\nhttps://example.com/api/health'} rows={6} required autoFocus /></label>
            <p className="field-note">{t('listHint')}</p>
            {!multiple && <label>{t('urlName')} <span className="optional">{t('optional')}</span>
              <input value={label} onChange={event => setLabel(event.target.value)} maxLength={100} placeholder={t('urlNameExample')} />
            </label>}
          </>}
          {mode === 'url' && <>
            <label>{t('importUrl')}<input type="url" required value={url} onChange={event => setUrl(event.target.value)}
              maxLength={2000} placeholder="https://example.com/sitemap.xml" /></label>
            <p className="field-note">{t('sitemapFormats')}</p>
          </>}
          {mode === 'file' && <label className="upload-field">
            <Upload size={24} /><strong>{t('chooseFile')}</strong><span>{t('sitemapUploadHint')}</span>
            <input aria-label={t('chooseFile')} type="file" accept=".xml,.gz,.gzip,application/xml,text/xml,application/gzip" required
              onChange={event => setFile(event.target.files?.[0])} />
          </label>}
          <ErrorMessage text={task.error} />
        </>}
        {mode !== 'list' && <div className="field-note">
          <p>{t('importCatalogHint')}</p>
          <button type="button" className="text-button" disabled={task.busy} onClick={openCatalog}>{t('openSitemapCatalog')}</button>
        </div>}
      </div>
      <div className="modal-footer">
        {result ? <><button type="button" className="button secondary" onClick={() => { setResult(undefined); setFile(undefined); }}>
          {t('addMore')}</button><button type="button" className="button primary" onClick={close}>{t('done')}</button></>
          : <><button type="button" className="button secondary" onClick={close} disabled={task.busy}>{t('cancel')}</button>
            <Submit busy={task.busy}>{task.busy ? t('importing') : mode === 'list' ? t('addUrls') : t('importSitemap')}</Submit></>}
      </div>
    </form>
  </Modal>;
}

export function EditForm({ projectId, address, close, changed }: ModalProps & {
  projectId: number; address: AddressRow; changed: () => void;
}) {
  const t = useText();
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
  return <Modal title={t('editUrl')} close={dismiss} closeDisabled={task.busy}>
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
        <label>{t('urlName')}<input name="label" defaultValue={address.label} maxLength={100} readOnly={task.busy} /></label>
        <label>{t('requestProfile')}
          <select aria-describedby={routeHint} disabled={!ready || task.busy} value={!ready ? '' : selection === null ? 'direct' : selection} onChange={event => {
            const value = event.target.value;
            setChoice(value === 'inherit' ? value : value === 'direct' ? null : Number(value));
          }}>
            {!ready && <option value="">{profiles.error || assignment.error ? t('profilesUnavailable') : t('profilesLoading')}</option>}
            <option value="inherit">{defaultName ? t('namedProjectRule', { name: defaultName }) : t('projectRule')}</option>
            <option value="direct">{t('noProfile')}</option>
            {matchingProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <p id={routeHint} className="field-note">{t('directHint')}</p>
        {ready && selectedOutsideOrigin && <p className="field-note">{t('profileOriginHint')}</p>}
        <ErrorMessage text={profiles.error || assignment.error} />
        <p className="field-note">{t('historyHint')}</p>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer"><button className="button secondary" type="button" onClick={dismiss} disabled={task.busy}>{t('cancel')}</button>
        <Submit busy={task.busy}>{t('save')}</Submit></div>
    </form>
  </Modal>;
}

export function DeleteForm({ projectId, ids, filters, close, changed }: ModalProps & {
  projectId: number; ids: number[]; filters: string; changed: () => void;
}) {
  const t = useText();
  const path = `${base(projectId)}/urls/delete`;
  const [preview, setPreview] = useState<SelectedAddress[]>();
  const [error, setError] = useState<unknown>();
  const [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    void api<SelectedAddress[]>(path + '/preview?' + filters, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }), signal: controller.signal,
    }).then(setPreview, failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [path, filters, ids]);
  const hidden = preview?.filter(address => !address.matchesFilter).length ?? 0;
  const pages = Math.ceil((preview?.length ?? 0) / ADDRESS_PAGE_SIZE);
  return <ConfirmDeletion title={ids.length === 1 ? t('deleteOne') : t('deleteSelected')}
    label={t('delete')} close={close} ready={!!preview?.length} confirm={async () => {
      if (!preview) return;
      await write(path, 'POST', { ids: preview.map(address => address.id), versions: preview.map(address => address.version) });
      changed();
      close();
    }}>
    <p>{t('deleteHint')}</p>
    <ErrorMessage text={error ? localizedFailure(error, currentLocale()) : undefined} />
    {!preview && !error && <Loading />}
    {preview && <>
      <p>{t('deletionCount', { count: formatNumber(preview.length) })}
        {hidden > 0 && <> · <strong>{t('hiddenCount', { count: formatNumber(hidden) })}</strong></>}
      </p>
      <ul className="deletion-preview" aria-label={t('urlsToDelete')}>
        {preview.slice((page - 1) * ADDRESS_PAGE_SIZE, page * ADDRESS_PAGE_SIZE).map(address =>
          <li key={address.id}><span>{address.url}</span>{!address.matchesFilter && <small>{t('hiddenByFilter')}</small>}</li>)}
      </ul>
      {pages > 1 && <nav className="pagination" aria-label={t('deletionPages')}>
        <button type="button" className="button icon secondary" aria-label={t('previousPage')} disabled={page === 1}
          onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
        <span aria-live="polite">{formatNumber(page)} / {formatNumber(pages)}</span>
        <button type="button" className="button icon secondary" aria-label={t('nextPage')} disabled={page === pages}
          onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
      </nav>}
    </>}
  </ConfirmDeletion>;
}

export function ConfirmDeletion({ title, label, close, confirm, children, ready = true, pendingLabel, fallbackFocus }: ModalProps & {
  title: string; label: string; confirm: () => Promise<void>; children: React.ReactNode; ready?: boolean; pendingLabel?: string;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useText();
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
      <div className="modal-footer"><button className="button secondary" type="button" onClick={close} disabled={task.busy}>{t('cancel')}</button>
        <button className="button danger" type="submit" disabled={!ready || task.busy}><Trash2 size={16} /> {label}</button></div>
    </form>
  </Modal>;
}

export function DeleteAllForm({ projectId, close, deleted, fallbackFocus }: ModalProps & {
  projectId: number; deleted: (outcome: DeleteAllOutcome) => void; fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useText();
  const path = `${base(projectId)}/urls/delete/all`;
  const { data, error, reset } = useQuery<DeleteAllPreview>(path);
  const hasChecks = data && (data.running > 0 || data.queued > 0);
  return <ConfirmDeletion title={t('deleteAllTitle')}
    label={hasChecks ? t('stopAndDelete') : t('deleteAll')} close={close} fallbackFocus={fallbackFocus}
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
    {error && <button type="button" className="button secondary" onClick={reset}>{t('refreshPreview')}</button>}
    {!data && !error && <Loading />}
    {data && <>
      <p>{t('project')} <strong>{t('quotedName', { name: data.projectName })}</strong></p>
      <p><strong>{t('deletionTotal', { count: formatNumber(data.addresses) })}</strong></p>
      <p>{t('deleteAllActiveChecks')}</p>
      {hasChecks && <p>{t('activeCheckCounts', { running: formatNumber(data.running), queued: formatNumber(data.queued) })}</p>}
      <p>{t('deleteAllHistory')}</p>
      {data.transferActive && <ErrorMessage text={t('deleteAllBusy')} />}
    </>}
  </ConfirmDeletion>;
}

const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
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
  const t = useText();
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
    const canLeave = () => !task.busy && (!dirty || window.confirm(t('discardSettings')));
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
  }, [registerLeaveGuard, dirty, persisted, task.busy, t]);

  return <form className="settings-grid" onSubmit={event => {
    event.preventDefault();
    if (task.busy) return;
    const submitted = draft;
    void task.run(async () => {
      if (enabled && !weekdays.length) throw formError('weekdayRequired');
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
      <div className="section-heading"><span className="section-icon violet"><Gauge size={19} /></span><h2>{t('checks')}</h2></div>
      <div className="form">
        <div className="check-limit-controls">
          <label>{t('concurrentChecks')}<input name="checkConcurrency" type="number" required step={1}
            min={CHECK_CONCURRENCY.min} max={CHECK_CONCURRENCY.max} value={checkConcurrency}
            aria-describedby={concurrencyNote} onChange={event => edit({ checkConcurrency: event.target.value })} /></label>
          <button className="button secondary" type="button" disabled={checkConcurrency === defaultConcurrency}
            onClick={() => edit({ checkConcurrency: defaultConcurrency })}>{t('resetConcurrency', { count: defaultConcurrency })}</button>
        </div>
        <p id={concurrencyNote} className="field-note">{t('concurrencyHint', {
          min: CHECK_CONCURRENCY.min, max: CHECK_CONCURRENCY.max, defaultValue: defaultConcurrency,
        })}</p>
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon violet"><CalendarClock size={19} /></span>
        <div><h2>{t('schedule')}</h2><p>{t('scheduleHint')}</p></div></div>
      <div className="form">
        <label className="inline-check"><input type="checkbox" checked={enabled} onChange={event => edit({ enabled: event.target.checked })} /> {t('enableSchedule')}</label>
        <fieldset className="form schedule-fields" hidden={!enabled} disabled={!enabled}>
          <legend>{t('weekdays')}</legend>
          <div className="weekdays">{days.map((name, index) => <label key={name}>
            <input className="sr-only" type="checkbox" checked={weekdays.includes(index + 1)} onChange={event => {
              edit({ weekdays: event.target.checked ? [...weekdays, index + 1].sort() : weekdays.filter(day => day !== index + 1) });
            }} /><span>{t(name)}</span>
          </label>)}</div>
          <div className="form two-fields">
            <label>{t('time')}<input name="time" type="time" required value={draft.time} onChange={event => edit({ time: event.target.value })} /></label>
            <label>{t('timeZone')}<input name="timezone" list="timezones" required value={draft.timezone} onChange={event => edit({ timezone: event.target.value })} />
              <datalist id="timezones">{zones.map(zone => <option value={zone} key={zone} />)}</datalist>
            </label>
          </div>
        </fieldset>
        {project.schedule && schedulesPaused
          ? <p className="field-note">{t('schedulePaused')}</p>
          : project.nextAt && project.schedule && <p className="field-note">{t('nextRun', {
            date: date(project.nextAt, project.schedule.timezone), timezone: project.schedule.timezone,
          })}</p>}
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon blue"><Mail size={19} /></span>
        <div><h2>{t('notifications')}</h2><p>{t('notificationsHint')}</p></div></div>
      <div className="form">
        <label>{t('whenToNotify')}<select name="notify" value={draft.notify} onChange={event => edit({ notify: event.target.value as Settings['notify'] })}>
          <option value="all">{t('notifyAll')}</option><option value="errors">{t('notifyFailures')}</option><option value="off">{t('notifyOff')}</option>
        </select></label>
        <label>{t('recipientEmail')} <span className="optional">{t('optional')}</span>
          <input name="email" type="email" value={draft.email} onChange={event => edit({ email: event.target.value })} maxLength={254} placeholder="name@example.com" />
        </label>
        <p className="field-note">{smtpConfigured ? t('smtpConfigured')
          : window.pulseDesktop ? t('desktopSmtpHint')
            : t('webSmtpHint')}</p>
      </div>
    </section>
    <section className="panel settings-card">
      <div className="section-heading"><span className="section-icon green"><ShieldCheck size={19} /></span>
        <div><h2>HTTPS</h2><p>{t('httpsHint')}</p></div></div>
      <div className="form"><label>{t('httpsProfile')}<select name="tlsProfile" value={draft.tlsProfile}
        onChange={event => edit({ tlsProfile: event.target.value === 'russian-ca' ? 'russian-ca' : 'default' })}>
        <option value="default">{t('standardCertificates')}</option>
        <option value="russian-ca">{t('russianCaCertificates')}</option>
      </select></label></div>
    </section>
    <div className="settings-footer"><Submit busy={task.busy}>{t('saveSettings')}</Submit>
      {task.busy && <span className="field-note" role="status">{t('settingsSaving')}</span>}
      {confirmed && !dirty && <span className="status ok" role="status"><Check size={15} /> {t('settingsSaved')}</span>}
      {confirmed && dirty && <span className="field-note" role="status">{t('submittedSettingsSaved')} <span>{t('unsavedSettings')}</span></span>}
      {!confirmed && dirty && <span className="field-note">{t('unsavedSettings')}</span>}
      <ErrorMessage text={task.error} />
    </div>
  </form>;
}
