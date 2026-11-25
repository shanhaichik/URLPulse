import { buffer } from 'node:stream/consumers';
import { expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { exportStream, reportFile } from '../src/server/export.js';
import { Store } from '../src/server/store.js';
import { smtpSender, type SendEmail } from '../src/server/worker.js';
import { type Result } from '../src/shared/types.js';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn(async (_message: object) => {}) }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

test('translates Excel headers and leaves machine exports byte-compatible', async () => {
  const row = {
    id: 1, url: 'https://example.test/', label: '=Test', status: 'error', checkedAt: '2026-11-25T12:00:00.000Z',
    error: 'Не удалось разрешить имя хоста (DNS).',
  } as Result;
  const legacy = (await buffer(exportStream([row], 'excel'))).toString('utf8');
  const ru = (await buffer(exportStream([row], 'excel', false, 'ru-RU'))).toString('utf8');
  const en = (await buffer(exportStream([row], 'excel', false, 'en-US'))).toString('utf8');
  expect(ru.startsWith('\uFEFFID;Запуск;ID адреса')).toBe(true);
  expect(legacy).toContain(';"error";');
  expect(ru).toContain(';"Ошибка";');
  expect(en.startsWith('\uFEFFID;Run;URL ID')).toBe(true);
  expect(en).toContain('"Failed"');
  expect(en).toContain('"DNS couldn\'t resolve the hostname."');
  expect(ru).toContain(row.error);
  expect(en).toContain('"\'=Test"');
  expect(en).toContain('"2026-11-25T12:00:00.000Z"');
  const date = new Date(2026, 10, 25);
  for (const type of ['csv', 'json'] as const) {
    expect(await buffer(exportStream([row], type, false, 'en-US'))).toEqual(await buffer(exportStream([row], type)));
    expect(reportFile('***', type, date, 'en-US')).toEqual(reportFile('***', type, date));
  }
  expect(reportFile('', 'excel', date, 'en-US').name).toBe('2026-11-25 - Project.csv');
});

test('keeps machine download errors stable and translates explicit English Excel errors', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  const path = '/api/projects/99999/export?locale=en-US&format=';
  const original = { error: 'Проект не найден.' };
  try {
    for (const format of ['csv', 'json']) {
      const response = await app.inject(path + format);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(original);
    }
    const download = await app.inject(path + 'excel');
    expect(download.statusCode).toBe(404);
    expect(download.json()).toEqual({ error: 'Project not found.' });
    const structured = await app.inject({ url: path + 'excel', headers: { 'x-urlpulse-i18n': '1' } });
    expect(structured.statusCode).toBe(404);
    expect(structured.json()).toMatchObject({ ...original, messageKey: expect.any(String) });
  } finally {
    await app.close();
    store.close();
  }
});

test('uses the installation language for mail sent with no renderer', async () => {
  const origin = 'http://127.0.0.1:8731';
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'alerts@example.test', PULSE_EMAIL_LOCALE: 'en-US' };
  const job = {
    projectId: 1, runId: 2, projectName: 'Status', email: 'owner@example.test', messageId: '<test@example.test>',
    available: 3501, total: 3600, failures: 99,
  } as Parameters<SendEmail>[0];
  await smtpSender(env, origin)!(job);
  expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({
    subject: 'URLPulse · Status',
    text: expect.stringContaining('Available: 3,501 of 3,600.'),
    messageId: job.messageId,
  }));
  await smtpSender({ ...env, PULSE_EMAIL_LOCALE: 'invalid' }, origin)!(job);
  expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Пульс URL · Status' }));
});
