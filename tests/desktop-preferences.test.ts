import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { desktopPreferences, readDesktopLocale } from '../src/desktop/preferences.js';
import type { SendEmail } from '../src/server/worker.js';
import type { SaveDesktopPreferences } from '../src/shared/desktop.js';

const os = vi.hoisted(() => ({ login: false, rejectLogin: false, ignoreLogin: false }));
const storage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
  encryptStringAsync: vi.fn<(value: string) => Promise<Buffer>>(),
  decryptStringAsync: vi.fn<(value: Buffer) => Promise<{ result: string }>>(),
}));
const sendMail = vi.hoisted(() => vi.fn(async (_message: object) => {}));

vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: os.login }),
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => {
      if (os.rejectLogin) throw new Error('Registration unavailable');
      if (!os.ignoreLogin) os.login = openAtLogin;
    },
  },
  safeStorage: storage,
}));

const credentials = {
  host: 'smtp.fixture.invalid', port: 65535, tlsMode: 'tls' as const,
  from: 'sender@fixture.invalid', user: 'fixture', password: 'synthetic password',
};

beforeEach(() => {
  os.login = false;
  os.rejectLogin = false;
  os.ignoreLogin = false;
  storage.isAsyncEncryptionAvailable.mockReset().mockResolvedValue(false);
  storage.encryptStringAsync.mockReset();
  storage.decryptStringAsync.mockReset().mockRejectedValue(new Error('Key unavailable'));
  sendMail.mockClear();
});

test('persists paused schedules while encrypted SMTP settings are unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const path = join(directory, 'desktop-preferences.json');
  const ciphertext = Buffer.from('previous encrypted content').toString('base64');
  try {
    await writeFile(path, JSON.stringify({ schedulesEnabled: true, smtp: ciphertext }));
    const current = await desktopPreferences(directory);
    expect(current.get().smtp).toMatchObject({ state: 'unavailable' });
    expect(await current.save({ section: 'background', schedulesEnabled: false, openAtLogin: false }))
      .toMatchObject({ preferences: { schedulesEnabled: false, smtp: { state: 'unavailable' } } });
    const restarted = await desktopPreferences(directory);
    expect(restarted.schedulesEnabled()).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8')).smtp).toBe(ciphertext);
    await expect(restarted.save({ section: 'smtp', smtp: credentials })).rejects.toThrow(/недоступны/);
    expect(JSON.parse(await readFile(path, 'utf8')).smtp).toBe(ciphertext);
    expect((await restarted.save({ section: 'smtp', smtp: null })).preferences.smtp.state).toBe('empty');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schedulesEnabled: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reports the actual login item state if registration fails after saving the pause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  os.rejectLogin = true;
  try {
    const current = await desktopPreferences(directory);
    expect(current.get().smtp).toMatchObject({ state: 'empty' });
    const result = await current.save({ section: 'background', schedulesEnabled: false, openAtLogin: true });
    expect(result).toMatchObject({ preferences: { schedulesEnabled: false, openAtLogin: false }, loginError: expect.any(String) });
    expect((await desktopPreferences(directory)).schedulesEnabled()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round-trips encrypted SMTP preferences and keeps the password for the same account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const ciphertext = Buffer.from('fixture ciphertext');
  const path = join(directory, 'desktop-preferences.json');
  storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
  storage.encryptStringAsync.mockResolvedValue(ciphertext);
  storage.decryptStringAsync.mockResolvedValue({ result: JSON.stringify(credentials) });
  const { password, ...publicFields } = credentials;
  const publicSmtp = { ...publicFields, hasPassword: true, state: 'configured' };
  try {
    const current = await desktopPreferences(directory);
    const result = await current.save({ section: 'smtp', smtp: { ...credentials, host: ` ${credentials.host} ` } });
    expect(result.preferences.smtp).toEqual(publicSmtp);
    expect(current.getSender()).toBeTypeOf('function');
    expect(storage.encryptStringAsync).toHaveBeenCalledExactlyOnceWith(JSON.stringify(credentials));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schedulesEnabled: true, smtp: ciphertext.toString('base64') });

    const restarted = await desktopPreferences(directory);
    expect(storage.decryptStringAsync).toHaveBeenCalledExactlyOnceWith(ciphertext);
    expect(restarted.get().smtp).toEqual(publicSmtp);
    await restarted.save({ section: 'smtp', smtp: { ...credentials, port: 1, password: '' } });
    expect(storage.encryptStringAsync).toHaveBeenLastCalledWith(JSON.stringify({ ...credentials, port: 1, password }));
    expect(restarted.get().smtp).toEqual({ ...publicSmtp, port: 1 });

    await expect(restarted.save({ section: 'smtp', smtp: { ...credentials, user: 'other', password: '' } }))
      .rejects.toThrow(/SMTP_USER/);
    expect(restarted.get().smtp).toEqual({ ...publicSmtp, port: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('leaves the current preferences and ciphertext intact after rejected saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const path = join(directory, 'desktop-preferences.json');
  storage.isAsyncEncryptionAvailable.mockResolvedValueOnce(true);
  storage.encryptStringAsync.mockResolvedValueOnce(Buffer.from('fixture ciphertext'));
  try {
    const current = await desktopPreferences(directory);
    await current.save({ section: 'smtp', smtp: credentials });
    const previous = current.get();
    const previousSender = current.getSender();
    const persisted = await readFile(path, 'utf8');
    const invalidPayloads = [
      { section: 'security' },
      { section: 'background', schedulesEnabled: 'false', openAtLogin: true },
      { section: 'smtp', smtp: { ...credentials, port: 0 } },
      { section: 'smtp', smtp: { ...credentials, port: 65536 } },
      { section: 'smtp', smtp: { ...credentials, host: ' ' } },
      { section: 'smtp', smtp: { ...credentials, tlsMode: 'none' } },
      { section: 'smtp', smtp: { ...credentials, password: 'x'.repeat(1025) } },
      { section: 'smtp', smtp: { ...credentials, from: 'malformed' } },
    ];
    for (const input of invalidPayloads) {
      await expect(current.save(input as SaveDesktopPreferences)).rejects.toThrow();
    }
    expect(storage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
    await expect(current.save({ section: 'smtp', smtp: { ...credentials, port: 465 } }))
      .rejects.toThrow(/Хранилище секретов/);
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(current.get()).toEqual(previous);
    expect(current.getSender()).toBe(previousSender);
    expect(await readFile(path, 'utf8')).toBe(persisted);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verifies the resulting login registration even when the OS ignores the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const input = { section: 'background', schedulesEnabled: true, openAtLogin: true } as const;
  try {
    const current = await desktopPreferences(directory);
    os.ignoreLogin = true;
    expect(await current.save(input)).toMatchObject({ preferences: { openAtLogin: false }, loginError: expect.any(String) });
    os.ignoreLogin = false;
    const saved = await current.save(input);
    expect(saved.preferences.openAtLogin).toBe(true);
    expect(saved.loginError).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persists the interface locale alongside concurrent background and email preference changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const path = join(directory, 'desktop-preferences.json');
  const ciphertext = Buffer.from('locked SMTP ciphertext').toString('base64');
  try {
    await writeFile(path, JSON.stringify({ schedulesEnabled: true, smtp: ciphertext, locale: 'invalid' }));
    const current = await desktopPreferences(directory);
    expect(current.getLocale()).toBe('ru-RU');
    expect(current.get().emailLocale).toBe('ru-RU');
    await Promise.all([
      current.setLocale('en-US'),
      current.save({ section: 'background', schedulesEnabled: false, openAtLogin: null }),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schedulesEnabled: false, smtp: ciphertext, locale: 'en-US' });
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(1);
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    await expect(current.setLocale('en' as 'en-US')).rejects.toThrow('Choose Russian or English.');
    expect(current.getLocale()).toBe('en-US');

    const restarted = await desktopPreferences(directory);
    expect(restarted.getLocale()).toBe('en-US');
    expect(restarted.schedulesEnabled()).toBe(false);
    expect(restarted.get()).toMatchObject({ emailLocale: 'ru-RU', smtp: { state: 'unavailable' } });
    await restarted.save({ section: 'smtp', smtp: null, emailLocale: 'en-US' });
    await restarted.setLocale('ru-RU');
    const nextRestart = await desktopPreferences(directory);
    expect(nextRestart.getLocale()).toBe('ru-RU');
    expect(nextRestart.get()).toMatchObject({ emailLocale: 'en-US', smtp: { state: 'empty' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saves the email language independently when SMTP credentials are locked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const path = join(directory, 'desktop-preferences.json');
  const ciphertext = Buffer.from('locked SMTP ciphertext').toString('base64');
  try {
    await writeFile(path, JSON.stringify({ schedulesEnabled: false, smtp: ciphertext, locale: 'en-US' }));
    expect(await readDesktopLocale(directory)).toBe('en-US');
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
    const current = await desktopPreferences(directory);
    await expect(current.save({ section: 'email-language', emailLocale: 'en-US' })).resolves.toMatchObject({
      preferences: { emailLocale: 'en-US', smtp: { state: 'unavailable' } },
    });
    expect(JSON.parse(await readFile(path, 'utf8')))
      .toEqual({ schedulesEnabled: false, smtp: ciphertext, locale: 'en-US', emailLocale: 'en-US' });
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(1);
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a configured desktop sender uses the current email language without recreating the SMTP preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-preferences-'));
  const job = { email: 'receiver@fixture.invalid', messageId: '<locale@fixture.invalid>', projectName: 'Fixture',
    projectId: 1, runId: 2, available: 3, failures: 1, total: 4 } as Parameters<SendEmail>[0];
  storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
  storage.encryptStringAsync.mockResolvedValue(Buffer.from('fixture ciphertext'));
  try {
    const current = await desktopPreferences(directory);
    await current.save({ section: 'smtp', smtp: credentials });
    const send = current.getSender()!;
    await current.setLocale('en-US');
    await send(job);
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Пульс URL · Fixture' }));
    await current.save({ section: 'email-language', emailLocale: 'en-US' });
    expect(current.getSender()).toBe(send);
    await send(job);
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: job.messageId, text: expect.stringContaining('Available: 3 of 4.'),
    }));
    expect(storage.encryptStringAsync).toHaveBeenCalledTimes(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
