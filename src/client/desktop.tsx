import { useEffect, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { BACKUP_RUN_INTEGRITY_PREFIX, type BackupPhase, type DesktopPreferences, type SaveDesktopPreferences, type SmtpFields } from '../shared/desktop.js';
import { useTask } from './api.js';
import { ErrorMessage, Loading, Modal } from './ui.js';

type Background = Pick<DesktopPreferences, 'openAtLogin' | 'schedulesEnabled'>;
type SmtpDraft = Omit<SmtpFields, 'port'> & { port: string; password: string };

export const backupProgress: Record<BackupPhase, string> = {
  copy: 'Копирование файла…', validate: 'Проверка базы…', prepare: 'Подготовка данных…', replace: 'Замена активной базы…',
};

export function useBackupPhase() {
  const [phase, setPhase] = useState<BackupPhase | null>(null);
  useEffect(() => window.pulseDesktop?.onBackupProgress(setPhase), []);
  return phase;
}

function background({ openAtLogin, schedulesEnabled }: DesktopPreferences): Background {
  return { openAtLogin, schedulesEnabled };
}

function smtpDraft({ smtp }: DesktopPreferences): SmtpDraft {
  return { host: smtp.host, port: String(smtp.port), tlsMode: smtp.tlsMode, from: smtp.from, user: smtp.user, password: '' };
}

export function DesktopSettings({ close, changed, phase, registerLeaveGuard }: {
  close: () => void; changed: () => void; phase: BackupPhase | null;
  registerLeaveGuard?: (guard: (() => boolean) | undefined) => void;
}) {
  const bridge = window.pulseDesktop!;
  const [preferences, setPreferences] = useState<DesktopPreferences>();
  const [backgroundDraft, setBackgroundDraft] = useState<Background>();
  const [mailDraft, setMailDraft] = useState<SmtpDraft>();
  const [backgroundMessage, setBackgroundMessage] = useState('');
  const [smtpMessage, setSmtpMessage] = useState('');
  const [loginError, setLoginError] = useState('');
  const [fileMessage, setFileMessage] = useState('');
  const loadTask = useTask();
  const fileTask = useTask();
  const backgroundTask = useTask();
  const smtpTask = useTask();
  const saving = backgroundTask.busy || smtpTask.busy;
  const backgroundDirty = !!preferences && JSON.stringify(backgroundDraft) !== JSON.stringify(background(preferences));
  const smtpDirty = !!preferences && JSON.stringify(mailDraft) !== JSON.stringify(smtpDraft(preferences));
  const dirty = smtpDirty || backgroundDirty;

  const canLeave = () => !saving && (!dirty || window.confirm('Отбросить несохранённые настройки приложения? Чтобы сохранить изменения, отмените выход и сохраните нужный раздел.'));
  useEffect(() => {
    registerLeaveGuard?.(canLeave);
    return () => registerLeaveGuard?.(undefined);
  }, [registerLeaveGuard, dirty, saving]);

  useEffect(() => {
    void loadTask.run(async () => {
      const current = await bridge.getPreferences();
      setPreferences(current);
      setBackgroundDraft(background(current));
      setMailDraft(smtpDraft(current));
    });
  }, [bridge]);

  function runFileAction(operation: 'export' | 'import') {
    setFileMessage('');
    void fileTask.run(async () => {
      if (operation === 'export') {
        const result = await bridge.exportBackup().catch(() => {
          throw new Error('Не удалось экспортировать резервную копию. Повторите попытку.');
        });
        if (result.saved) setFileMessage('Резервная копия сохранена.');
        else if (result.error) throw new Error(result.error);
      } else {
        const restored = await bridge.importBackup().catch((error: unknown) => {
          if (error instanceof Error) {
            const start = error.message.indexOf(BACKUP_RUN_INTEGRITY_PREFIX);
            const id = start >= 0 && /^\d+\./.exec(error.message.slice(start + BACKUP_RUN_INTEGRITY_PREFIX.length));
            if (id) throw new Error(BACKUP_RUN_INTEGRITY_PREFIX + id[0]);
          }
          throw new Error('Не удалось восстановить резервную копию. Проверьте выбранный файл и повторите попытку.');
        });
        if (restored) setFileMessage('Резервная копия восстановлена.');
      }
    });
  }

  function editMail(fields: Partial<SmtpDraft>) {
    setMailDraft(current => current && { ...current, ...fields });
    setSmtpMessage('');
    smtpTask.clear();
  }

  function saveMail(smtp: Extract<SaveDesktopPreferences, { section: 'smtp' }>['smtp']) {
    setSmtpMessage('');
    void smtpTask.run(async () => {
      const result = await bridge.savePreferences({ section: 'smtp', smtp });
      setPreferences(result.preferences);
      setMailDraft(smtpDraft(result.preferences));
      setSmtpMessage(smtp ? 'Настройки SMTP сохранены.' : 'Настройки SMTP удалены.');
      changed();
    });
  }

  return <Modal title="Настройки приложения" close={() => { if (canLeave()) close(); }}>
    <div className="modal-body form">
      {saving && <p role="status">Дождитесь завершения сохранения настроек.</p>}
      <section className="form">
        <h3>Резервная копия</h3>
        <div className="desktop-file-actions">
          <button className="button secondary" type="button" disabled={fileTask.busy || saving} onClick={() => runFileAction('export')}>
            <Download size={16} /> Экспорт базы
          </button>
          <button className="button secondary" type="button" disabled={fileTask.busy || saving} onClick={() => {
            if (canLeave()) runFileAction('import');
          }}>
            <Upload size={16} /> Восстановить базу
          </button>
        </div>
        <ErrorMessage text={fileTask.error} />
        {phase && <p role="status">{backupProgress[phase]}</p>}
        {fileMessage && <p className="status ok" role="status">{fileMessage}</p>}
      </section>
      {!preferences && !loadTask.error && <Loading />}
      <ErrorMessage text={loadTask.error} />
      {preferences && backgroundDraft && mailDraft && <>
        <form className="form desktop-preferences-form" onSubmit={event => {
          event.preventDefault();
          if (saving || fileTask.busy) return;
          setBackgroundMessage('');
          setLoginError('');
          void backgroundTask.run(async () => {
            const result = await bridge.savePreferences({
              section: 'background', schedulesEnabled: backgroundDraft.schedulesEnabled,
              openAtLogin: backgroundDraft.openAtLogin === preferences.openAtLogin ? null : backgroundDraft.openAtLogin,
            });
            setPreferences(result.preferences);
            setBackgroundDraft(background(result.preferences));
            setLoginError(result.loginError ?? '');
            setBackgroundMessage(result.preferences.schedulesEnabled ? 'Расписания включены.' : 'Расписания приостановлены.');
            changed();
          });
        }}>
          <h3>Фоновая работа</h3>
          <label className="inline-check"><input type="checkbox" checked={backgroundDraft.schedulesEnabled} disabled={backgroundTask.busy}
            onChange={event => {
              setBackgroundDraft({ ...backgroundDraft, schedulesEnabled: event.target.checked });
              setBackgroundMessage('');
            }} /> Выполнять расписания</label>
          <label className="inline-check"><input type="checkbox" checked={backgroundDraft.openAtLogin === true}
            disabled={backgroundTask.busy || backgroundDraft.openAtLogin === null} onChange={event => {
              setBackgroundDraft({ ...backgroundDraft, openAtLogin: event.target.checked });
              setLoginError('');
            }} /> Запускать приложение при входе в систему</label>
          {backgroundDraft.openAtLogin === null && <p className="field-note">Статус автозапуска недоступен.</p>}
          <div><button className="button primary" disabled={saving || fileTask.busy || !backgroundDirty}>Сохранить фоновую работу</button></div>
          {backgroundMessage && <p className="status ok" role="status">{backgroundMessage}</p>}
          <ErrorMessage text={loginError || backgroundTask.error} />
        </form>
        <form className="form desktop-preferences-form" onSubmit={event => {
          event.preventDefault();
          if (!saving && !fileTask.busy && preferences.smtp.state !== 'unavailable') saveMail({ ...mailDraft, port: Number(mailDraft.port) });
        }}>
          <h3>SMTP</h3>
          {preferences.smtp.state === 'unavailable' ? <ErrorMessage text="Сохранённые параметры SMTP недоступны. Запустите приложение заново, чтобы повторить чтение." /> : <>
            <div className="form two-fields">
              <label>SMTP-хост<input value={mailDraft.host} placeholder="smtp.example.com" required disabled={smtpTask.busy}
                onChange={event => editMail({ host: event.target.value })} /></label>
              <label>Порт<input type="number" min={1} max={65535} value={mailDraft.port} required disabled={smtpTask.busy}
                onChange={event => editMail({ port: event.target.value })} /></label>
            </div>
            <label>Шифрование<select value={mailDraft.tlsMode} disabled={smtpTask.busy}
              onChange={event => editMail({ tlsMode: event.target.value === 'tls' ? 'tls' : 'starttls' })}>
              <option value="starttls">STARTTLS</option><option value="tls">TLS</option>
            </select></label>
            <label>Адрес отправителя<input type="email" value={mailDraft.from} required disabled={smtpTask.busy}
              onChange={event => editMail({ from: event.target.value })} /></label>
            <label>Имя пользователя<input value={mailDraft.user} autoComplete="username" disabled={smtpTask.busy}
              onChange={event => editMail({ user: event.target.value })} /></label>
            <label>Пароль SMTP<input type="password" value={mailDraft.password} autoComplete="new-password" disabled={smtpTask.busy}
              onChange={event => editMail({ password: event.target.value })}
              placeholder={preferences.smtp.hasPassword ? 'Сохранён. Введите новый при замене' : undefined} /></label>
          </>}
          <div className="desktop-file-actions">
            {preferences.smtp.state !== 'unavailable' && <button className="button primary" disabled={saving || fileTask.busy || !smtpDirty}>Сохранить SMTP</button>}
            {preferences.smtp.state !== 'empty' && <button className="button secondary" type="button" disabled={saving || fileTask.busy}
              onClick={() => { if (window.confirm('Удалить сохранённые параметры SMTP?')) saveMail(null); }}>Удалить настройки SMTP</button>}
          </div>
          {smtpMessage && <p className="status ok" role="status">{smtpMessage}</p>}
          <ErrorMessage text={smtpTask.error} />
        </form>
      </>}
    </div>
  </Modal>;
}
