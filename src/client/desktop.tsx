import { useEffect, useId, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  BACKUP_RUN_INTEGRITY_PREFIX, BACKUP_RUN_INTEGRITY_PREFIX_EN,
  type BackupPhase, type DesktopPreferences, type SaveDesktopPreferences, type SmtpFields,
} from '../shared/desktop.js';
import { type AppLocale, type MessageParams, createTranslator, defaultLocale, isLocale } from '../shared/i18n/index.js';
import { desktopSettingsMessages } from '../shared/i18n/locales/desktop-settings.js';
import { useTask } from './api.js';
import { createMessages, LocalizedError } from './i18n.js';
import { ErrorMessage, Loading, Modal } from './ui.js';

const useText = createMessages('desktop-settings', desktopSettingsMessages);
const backupError = (key: 'exportFailed' | 'importFailed' | 'backupRunIntegrity', params?: MessageParams) =>
  new LocalizedError(locale => createTranslator(locale, 'desktop-settings', desktopSettingsMessages)(key, params));

type Background = Pick<DesktopPreferences, 'openAtLogin' | 'schedulesEnabled'>;
type SmtpDraft = Omit<SmtpFields, 'port'> & { port: string; password: string };

export function useBackupProgress(phase: BackupPhase | null) {
  const t = useText();
  return phase && t(phase);
}

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
  const t = useText();
  const progress = phase && t(phase);
  const emailLanguageHint = useId();
  const bridge = window.pulseDesktop!;
  const [preferences, setPreferences] = useState<DesktopPreferences>();
  const [backgroundDraft, setBackgroundDraft] = useState<Background>();
  const [mailDraft, setMailDraft] = useState<SmtpDraft>();
  const [emailLocale, setEmailLocale] = useState<AppLocale>(defaultLocale);
  const [backgroundMessage, setBackgroundMessage] = useState<'schedulesEnabled' | 'schedulesPaused'>();
  const [smtpMessage, setSmtpMessage] = useState<'smtpSaved' | 'smtpDeleted'>();
  const [emailLocaleSaved, setEmailLocaleSaved] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);
  const [fileMessage, setFileMessage] = useState<'backupSaved' | 'backupRestored'>();
  const loadTask = useTask();
  const fileTask = useTask();
  const backgroundTask = useTask();
  const smtpTask = useTask();
  const emailLocaleTask = useTask();
  const saving = backgroundTask.busy || smtpTask.busy || emailLocaleTask.busy;
  const backgroundDirty = !!preferences && JSON.stringify(backgroundDraft) !== JSON.stringify(background(preferences));
  const smtpDirty = !!preferences && JSON.stringify(mailDraft) !== JSON.stringify(smtpDraft(preferences));
  const emailLocaleDirty = !!preferences && emailLocale !== (preferences.emailLocale ?? defaultLocale);
  const dirty = smtpDirty || backgroundDirty || emailLocaleDirty;

  const canLeave = () => !saving && (!dirty || window.confirm(t('discardSettings')));
  useEffect(() => {
    registerLeaveGuard?.(canLeave);
    return () => registerLeaveGuard?.(undefined);
  }, [registerLeaveGuard, dirty, saving, t]);

  useEffect(() => {
    void loadTask.run(async () => {
      const current = await bridge.getPreferences();
      setPreferences(current);
      setBackgroundDraft(background(current));
      setMailDraft(smtpDraft(current));
      setEmailLocale(current.emailLocale ?? defaultLocale);
    });
  }, [bridge]);

  function runFileAction(operation: 'export' | 'import') {
    setFileMessage(undefined);
    void fileTask.run(async () => {
      if (operation === 'export') {
        const result = await bridge.exportBackup().catch(() => {
          throw backupError('exportFailed');
        });
        if (result.saved) setFileMessage('backupSaved');
        else if (result.error) throw new Error(result.error);
      } else {
        const restored = await bridge.importBackup().catch((error: unknown) => {
          if (error instanceof Error) {
            for (const prefix of [BACKUP_RUN_INTEGRITY_PREFIX, BACKUP_RUN_INTEGRITY_PREFIX_EN]) {
              const start = error.message.indexOf(prefix);
              const runId = start >= 0 && /^(\d+)\./.exec(error.message.slice(start + prefix.length));
              if (runId) throw backupError('backupRunIntegrity', { runId: runId[1] });
            }
          }
          throw backupError('importFailed');
        });
        if (restored) setFileMessage('backupRestored');
      }
    });
  }

  function editMail(fields: Partial<SmtpDraft>) {
    setMailDraft(current => current && { ...current, ...fields });
    setSmtpMessage(undefined);
    smtpTask.clear();
  }

  function saveMail(smtp: Extract<SaveDesktopPreferences, { section: 'smtp' }>['smtp']) {
    setSmtpMessage(undefined);
    void smtpTask.run(async () => {
      const result = await bridge.savePreferences({ section: 'smtp', smtp });
      setPreferences(result.preferences);
      setMailDraft(smtpDraft(result.preferences));
      setSmtpMessage(smtp ? 'smtpSaved' : 'smtpDeleted');
      changed();
    });
  }

  return <Modal title={t('appSettings')} close={() => { if (canLeave()) close(); }}>
    <div className="modal-body form">
      {saving && <p role="status">{t('saveInProgress')}</p>}
      <section className="form">
        <h3>{t('backup')}</h3>
        <div className="desktop-file-actions">
          <button className="button secondary" type="button" disabled={fileTask.busy || saving} onClick={() => runFileAction('export')}>
            <Download size={16} /> {t('exportDatabase')}
          </button>
          <button className="button secondary" type="button" disabled={fileTask.busy || saving} onClick={() => {
            if (canLeave()) runFileAction('import');
          }}>
            <Upload size={16} /> {t('restoreDatabase')}
          </button>
        </div>
        <ErrorMessage text={fileTask.error} />
        {progress && <p role="status">{progress}</p>}
        {fileMessage && <p className="status ok" role="status">{t(fileMessage)}</p>}
      </section>
      {!preferences && !loadTask.error && <Loading />}
      <ErrorMessage text={loadTask.error} />
      {preferences && backgroundDraft && mailDraft && <>
        <form className="form desktop-preferences-form" onSubmit={event => {
          event.preventDefault();
          if (saving || fileTask.busy) return;
          setBackgroundMessage(undefined);
          setLoginFailed(false);
          void backgroundTask.run(async () => {
            const result = await bridge.savePreferences({
              section: 'background', schedulesEnabled: backgroundDraft.schedulesEnabled,
              openAtLogin: backgroundDraft.openAtLogin === preferences.openAtLogin ? null : backgroundDraft.openAtLogin,
            });
            setPreferences(result.preferences);
            setBackgroundDraft(background(result.preferences));
            setLoginFailed(Boolean(result.loginError));
            setBackgroundMessage(result.preferences.schedulesEnabled ? 'schedulesEnabled' : 'schedulesPaused');
            changed();
          });
        }}>
          <h3>{t('backgroundWork')}</h3>
          <label className="inline-check"><input type="checkbox" checked={backgroundDraft.schedulesEnabled} disabled={backgroundTask.busy}
            onChange={event => {
              setBackgroundDraft({ ...backgroundDraft, schedulesEnabled: event.target.checked });
              setBackgroundMessage(undefined);
            }} /> {t('runSchedules')}</label>
          <label className="inline-check"><input type="checkbox" checked={backgroundDraft.openAtLogin === true}
            disabled={backgroundTask.busy || backgroundDraft.openAtLogin === null} onChange={event => {
              setBackgroundDraft({ ...backgroundDraft, openAtLogin: event.target.checked });
              setLoginFailed(false);
            }} /> {t('openAtLogin')}</label>
          {backgroundDraft.openAtLogin === null && <p className="field-note">{t('loginStateUnavailable')}</p>}
          <div><button className="button primary" disabled={saving || fileTask.busy || !backgroundDirty}>{t('saveBackground')}</button></div>
          {backgroundMessage && <p className="status ok" role="status">{t(backgroundMessage)}</p>}
          <ErrorMessage text={loginFailed ? t('loginItemFailed') : backgroundTask.error} />
        </form>
        <section className="form desktop-preferences-form">
          <h3>SMTP</h3>
          <form className="form" onSubmit={event => {
            event.preventDefault();
            if (!emailLocaleDirty || saving || fileTask.busy) return;
            setEmailLocaleSaved(false);
            void emailLocaleTask.run(async () => {
              const result = await bridge.savePreferences({ section: 'email-language', emailLocale });
              setPreferences(result.preferences);
              setEmailLocale(result.preferences.emailLocale ?? defaultLocale);
              setEmailLocaleSaved(true);
            });
          }}>
            <label>{t('emailLanguage')}<select value={emailLocale} disabled={emailLocaleTask.busy} aria-describedby={emailLanguageHint}
              onChange={event => {
                const selection = event.target.value;
                if (isLocale(selection)) {
                  setEmailLocale(selection);
                  setEmailLocaleSaved(false);
                  emailLocaleTask.clear();
                }
              }}>
              <option value="ru-RU" lang="ru">Русский</option><option value="en-US" lang="en">English</option>
            </select></label>
            <p id={emailLanguageHint} className="field-note">{t('emailLanguageHint')}</p>
            <div><button className="button primary" disabled={saving || fileTask.busy || !emailLocaleDirty}>{t('saveEmailLocale')}</button></div>
            {emailLocaleSaved && <p className="status ok" role="status">{t('emailLocaleSaved')}</p>}
            <ErrorMessage text={emailLocaleTask.error} />
          </form>
          <form className="form" onSubmit={event => {
            event.preventDefault();
            if (!saving && !fileTask.busy && preferences.smtp.state !== 'unavailable') {
              saveMail({ ...mailDraft, port: Number(mailDraft.port) });
            }
          }}>
            {preferences.smtp.state === 'unavailable' ? <ErrorMessage text={t('smtpUnavailable')} /> : <>
              <div className="form two-fields">
                <label>{t('smtpHost')}<input value={mailDraft.host} placeholder="smtp.example.com" required disabled={smtpTask.busy}
                  onChange={event => editMail({ host: event.target.value })} /></label>
                <label>{t('port')}<input type="number" min={1} max={65535} value={mailDraft.port} required disabled={smtpTask.busy}
                  onChange={event => editMail({ port: event.target.value })} /></label>
              </div>
              <label>{t('encryption')}<select value={mailDraft.tlsMode} disabled={smtpTask.busy}
                onChange={event => editMail({ tlsMode: event.target.value === 'tls' ? 'tls' : 'starttls' })}>
                <option value="starttls">STARTTLS</option><option value="tls">TLS</option>
              </select></label>
              <label>{t('senderAddress')}<input type="email" value={mailDraft.from} required disabled={smtpTask.busy}
                onChange={event => editMail({ from: event.target.value })} /></label>
              <label>{t('username')}<input value={mailDraft.user} autoComplete="username" disabled={smtpTask.busy}
                onChange={event => editMail({ user: event.target.value })} /></label>
              <label>{t('smtpPassword')}<input type="password" value={mailDraft.password} autoComplete="new-password" disabled={smtpTask.busy}
                onChange={event => editMail({ password: event.target.value })}
                placeholder={preferences.smtp.hasPassword ? t('changePasswordHint') : undefined} /></label>
            </>}
            <div className="desktop-file-actions">
              {preferences.smtp.state !== 'unavailable' && <button className="button primary" disabled={saving || fileTask.busy || !smtpDirty}>{t('saveSmtp')}</button>}
              {preferences.smtp.state !== 'empty' && <button className="button secondary" type="button" disabled={saving || fileTask.busy}
                onClick={() => { if (window.confirm(t('confirmDeleteSmtp'))) saveMail(null); }}>{t('deleteSmtp')}</button>}
            </div>
            {smtpMessage && <p className="status ok" role="status">{t(smtpMessage)}</p>}
            <ErrorMessage text={smtpTask.error} />
          </form>
        </section>
      </>}
    </div>
  </Modal>;
}
