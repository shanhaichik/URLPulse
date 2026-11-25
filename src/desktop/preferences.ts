import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { DesktopPreferences, DesktopPreferencesResult, SaveDesktopPreferences, SmtpFields } from '../shared/desktop.js';
import { defaultLocale, isLocale, parseLocale, type AppLocale } from '../shared/i18n/index.js';
import { nativeTranslator } from '../shared/i18n/locales/native.js';
import { smtpSender, type SendEmail } from '../server/worker.js';
import { atomicFile } from './backup.js';

type Mail = SmtpFields & { password: string };
type PreferencesFile = { schedulesEnabled: boolean; smtp?: string; locale?: AppLocale; emailLocale?: AppLocale };
type Translate = ReturnType<typeof nativeTranslator>;

const defaults: Mail = { host: '', port: 587, tlsMode: 'starttls', from: '', user: '', password: '' };
const configName = 'desktop-preferences.json';

async function readPreferences(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readDesktopLocale(directory: string) {
  try { return parseLocale((await readPreferences(join(directory, configName)))?.locale); }
  catch { return defaultLocale; }
}

function sender(mail: Mail, t: Translate, getEmailLocale: () => AppLocale) {
  if (!mail.host) return undefined;
  if (!/^[a-z\d.:-]+$/i.test(mail.host) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mail.from)) {
    throw new Error(t('invalidSmtpAddress'));
  }
  if (Boolean(mail.user) !== Boolean(mail.password)) throw new Error(t('invalidSmtpConfiguration'));
  return smtpSender({
    SMTP_HOST: mail.host, SMTP_PORT: String(mail.port), SMTP_TLS_MODE: mail.tlsMode,
    SMTP_USER: mail.user, SMTP_PASSWORD: mail.password, SMTP_FROM: mail.from,
  }, 'pulse-url://report', getEmailLocale);
}

export async function desktopPreferences(directory: string) {
  const path = join(directory, configName);
  let mail = defaults;
  let saved: PreferencesFile = { schedulesEnabled: true };
  let send: SendEmail | undefined;
  let writes = Promise.resolve();
  const getLocale = () => parseLocale(saved.locale);
  const getEmailLocale = () => parseLocale(saved.emailLocale);
  const translate = () => nativeTranslator(getLocale());

  try {
    const data = await readPreferences(path);
    saved = {
      schedulesEnabled: data.schedulesEnabled !== false,
      smtp: typeof data.smtp === 'string' ? data.smtp : undefined,
      locale: isLocale(data.locale) ? data.locale : undefined,
      emailLocale: isLocale(data.emailLocale) ? data.emailLocale : undefined,
    };
    if (saved.smtp) {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(saved.smtp, 'base64'));
      const restored = validatedMail(JSON.parse(decrypted.result), translate());
      send = sender(restored, translate(), getEmailLocale);
      mail = restored;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(translate()('readPreferencesFailed'));
  }

  function enqueue<T>(write: () => Promise<T>) {
    const operation = writes.then(write);
    writes = operation.then(() => {}, () => {});
    return operation;
  }

  async function persist(update: Partial<PreferencesFile>) {
    const next = { ...saved, ...update };
    await atomicFile(path, staged =>
      writeFile(staged, JSON.stringify(next), { mode: 0o600, flush: true }));
    saved = next;
  }

  function get(): DesktopPreferences {
    const { password, ...smtp } = mail;
    let openAtLogin: boolean | null = null;
    try { openAtLogin = app.getLoginItemSettings().openAtLogin ?? null; }
    catch { /* Login item settings are unavailable on this system. */ }
    const state = send ? 'configured' : saved.smtp ? 'unavailable' : 'empty';
    return { smtp: { ...smtp, state, hasPassword: !!password }, openAtLogin,
      schedulesEnabled: saved.schedulesEnabled, emailLocale: getEmailLocale() };
  }

  function setLocale(locale: unknown) {
    return enqueue(async () => {
      const t = translate();
      if (!isLocale(locale)) throw new Error(t('chooseLocale'));
      if (locale !== getLocale()) {
        try { await persist({ locale }); }
        catch (cause) { throw new Error(t('localeSaveFailed'), { cause }); }
      }
      return getLocale();
    });
  }

  async function save(input: SaveDesktopPreferences): Promise<DesktopPreferencesResult> {
    const t = translate();
    if (input?.section === 'email-language') {
      if (!isLocale(input.emailLocale)) throw new Error(t('chooseLocale'));
      if (input.emailLocale !== getEmailLocale()) await persist({ emailLocale: input.emailLocale });
      return { preferences: get() };
    }
    if (input?.section === 'background') {
      if (typeof input.schedulesEnabled !== 'boolean' || (input.openAtLogin !== null && typeof input.openAtLogin !== 'boolean')) {
        throw new Error(t('invalidBackgroundSettings'));
      }
      if (input.schedulesEnabled !== saved.schedulesEnabled) await persist({ schedulesEnabled: input.schedulesEnabled });
      if (input.openAtLogin !== null && get().openAtLogin !== input.openAtLogin) {
        const loginError = t('loginItemFailed');
        try { app.setLoginItemSettings({ openAtLogin: input.openAtLogin }); }
        catch { return { preferences: get(), loginError }; }
        const preferences = get();
        return { preferences, loginError: preferences.openAtLogin === input.openAtLogin ? undefined : loginError };
      }
      return { preferences: get() };
    }
    if (input?.section !== 'smtp') throw new Error(t('invalidPreferences'));
    if (input.emailLocale !== undefined && !isLocale(input.emailLocale)) throw new Error(t('chooseLocale'));
    const emailLocale = input.emailLocale ?? saved.emailLocale;
    const next = input.smtp === null ? defaults : validatedMail(input.smtp, t);
    if (input.smtp !== null && saved.smtp && !send) throw new Error(t('unavailableSmtpSettings'));
    if (input.smtp && !next.password && next.host === mail.host && next.user === mail.user) next.password = mail.password;
    const nextSender = sender(next, t, getEmailLocale);
    let encrypted: string | undefined;
    if (nextSender) {
      try {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error();
        encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(next))).toString('base64');
      } catch {
        throw new Error(t('unavailableSecretStore'));
      }
    }
    await persist({ smtp: encrypted, emailLocale });
    mail = next;
    send = nextSender;
    return { preferences: get() };
  }

  return {
    get, getLocale, setLocale,
    save: (input: SaveDesktopPreferences) => enqueue(() => save(input)),
    getSender: () => send,
    schedulesEnabled: () => saved.schedulesEnabled,
    setSchedulesEnabled: (schedulesEnabled: boolean) => enqueue(() => persist({ schedulesEnabled })),
    waitForWrites: () => writes,
  };
}

function validatedMail(input: Mail, t: Translate): Mail {
  if (!input || [input.host, input.from, input.user, input.password].some(
    value => typeof value !== 'string' || value.length > 1024)
    || !['starttls', 'tls'].includes(input.tlsMode)
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !input.host.trim()) {
    throw new Error(t('invalidSmtpFields'));
  }
  return { host: input.host.trim(), port: input.port, tlsMode: input.tlsMode,
    from: input.from.trim(), user: input.user.trim(), password: input.password };
}
