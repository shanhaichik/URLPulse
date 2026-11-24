import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { DesktopPreferences, DesktopPreferencesResult, SaveDesktopPreferences, SmtpFields } from '../shared/desktop.js';
import { smtpSender, type SendEmail } from '../server/worker.js';
import { atomicFile } from './backup.js';

type Mail = SmtpFields & { password: string };
const defaults: Mail = { host: '', port: 587, tlsMode: 'starttls', from: '', user: '', password: '' };
const configName = 'desktop-preferences.json';

function sender(mail: Mail) {
  if (!mail.host) return undefined;
  if (!/^[a-z\d.:-]+$/i.test(mail.host) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mail.from)) {
    throw new Error('Укажите действительные SMTP-хост и адрес отправителя.');
  }
  return smtpSender({
    SMTP_HOST: mail.host, SMTP_PORT: String(mail.port), SMTP_TLS_MODE: mail.tlsMode,
    SMTP_USER: mail.user, SMTP_PASSWORD: mail.password, SMTP_FROM: mail.from,
  }, 'pulse-url://report');
}

export async function desktopPreferences(directory: string) {
  const path = join(directory, configName);
  let mail = defaults;
  let encryptedMail: string | undefined;
  let schedulesEnabled = true;
  let send: SendEmail | undefined;
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    schedulesEnabled = data.schedulesEnabled !== false;
    encryptedMail = typeof data.smtp === 'string' ? data.smtp : undefined;
    if (encryptedMail) {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encryptedMail, 'base64'));
      const restored = validatedMail(JSON.parse(decrypted.result));
      send = sender(restored);
      mail = restored;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Не удалось прочитать настройки desktop.');
  }

  async function persist(enabled: boolean, encrypted: string | undefined) {
    await atomicFile(path, staged => writeFile(staged, JSON.stringify({ schedulesEnabled: enabled, smtp: encrypted }), { mode: 0o600 }));
  }

  function get(): DesktopPreferences {
    const { password, ...smtp } = mail;
    let openAtLogin: boolean | null = null;
    try { openAtLogin = app.getLoginItemSettings().openAtLogin ?? null; }
    catch { /* Login item settings are unavailable on this system. */ }
    const state = send ? 'configured' : encryptedMail ? 'unavailable' : 'empty';
    return { smtp: { ...smtp, state, hasPassword: !!password }, openAtLogin, schedulesEnabled };
  }

  async function setSchedulesEnabled(enabled: boolean) {
    await persist(enabled, encryptedMail);
    schedulesEnabled = enabled;
  }

  async function save(input: SaveDesktopPreferences): Promise<DesktopPreferencesResult> {
    if (input?.section === 'background') {
      if (typeof input.schedulesEnabled !== 'boolean' || (input.openAtLogin !== null && typeof input.openAtLogin !== 'boolean')) {
        throw new Error('Проверьте параметры фоновой работы.');
      }
      if (input.schedulesEnabled !== schedulesEnabled) await setSchedulesEnabled(input.schedulesEnabled);
      if (input.openAtLogin !== null && get().openAtLogin !== input.openAtLogin) {
        const loginError = 'Не удалось изменить автозапуск. Проверьте параметры автозапуска системы и повторите попытку.';
        try { app.setLoginItemSettings({ openAtLogin: input.openAtLogin }); }
        catch { return { preferences: get(), loginError }; }
        const preferences = get();
        return { preferences, loginError: preferences.openAtLogin === input.openAtLogin ? undefined : loginError };
      }
      return { preferences: get() };
    }
    if (input?.section !== 'smtp') throw new Error('Проверьте параметры приложения.');
    const next = input.smtp === null ? defaults : validatedMail(input.smtp);
    if (input.smtp !== null && encryptedMail && !send) {
      throw new Error('Сохранённые параметры SMTP недоступны. Запустите приложение заново, чтобы повторить чтение.');
    }
    if (input.smtp && !next.password && next.host === mail.host && next.user === mail.user) next.password = mail.password;
    const nextSender = sender(next);
    let encrypted: string | undefined;
    if (nextSender) {
      try {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error();
        encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(next))).toString('base64');
      } catch {
        throw new Error('Хранилище секретов операционной системы недоступно.');
      }
    }
    await persist(schedulesEnabled, encrypted);
    encryptedMail = encrypted;
    mail = next;
    send = nextSender;
    return { preferences: get() };
  }

  return { get, save, getSender: () => send, schedulesEnabled: () => schedulesEnabled, setSchedulesEnabled };
}

function validatedMail(input: Mail): Mail {
  if (!input || [input.host, input.from, input.user, input.password].some(
    value => typeof value !== 'string' || value.length > 1024)
    || !['starttls', 'tls'].includes(input.tlsMode)
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !input.host.trim()) {
    throw new Error('Проверьте параметры SMTP.');
  }
  return { host: input.host.trim(), port: input.port, tlsMode: input.tlsMode,
    from: input.from.trim(), user: input.user.trim(), password: input.password };
}
