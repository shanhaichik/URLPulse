import { expect, test } from 'vitest';
import * as schedule from '../src/server/schedule.js';
import { Store } from '../src/server/store.js';
import { deliverPending, smtpSender, startBackground } from '../src/server/worker.js';

test('calculates the next project-local occurrence and handles daylight saving time', () => {
  const weekdays = [1];
  expect(schedule.nextOccurrence({ weekdays, time: '09:00', timezone: 'Europe/Moscow' },
    Date.parse('2026-11-15T18:00:00Z'))).toBe(Date.parse('2026-11-16T06:00:00Z'));
  expect(schedule.nextOccurrence({ weekdays: [7], time: '02:30', timezone: 'America/New_York' },
    Date.parse('2026-03-08T00:00:00Z'))).toBe(Date.parse('2026-03-08T07:30:00Z'));
});

test('schedules a repeated autumn hour only once and uses a strictly future occurrence', () => {
  const rule = { weekdays: [7], time: '01:30', timezone: 'America/New_York' };
  expect(schedule.nextOccurrence(rule, Date.parse('2026-11-01T05:29:59.999Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'));
  expect(schedule.nextOccurrence(rule, Date.parse('2026-11-01T05:30:00Z'))).toBe(Date.parse('2026-11-08T06:30:00Z'));
  expect(() => schedule.nextOccurrence({ ...rule, weekdays: [] }, Date.parse('2026-11-01T05:30:00Z'))).toThrow(/действительный день недели/);
});

test('leaves SMTP disabled without a host and rejects incomplete connection settings', () => {
  const origin = 'http://127.0.0.1:8731';
  const env = { SMTP_HOST: 'mail.example.test', SMTP_FROM: 'pulse@example.test' };
  expect(smtpSender({ SMTP_HOST: '' }, origin)).toBeUndefined();
  expect(smtpSender({ ...env, SMTP_TLS_MODE: 'tls' }, origin)).toBeTypeOf('function');
  for (const invalid of [
    { SMTP_TLS_MODE: 'off' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' },
    { SMTP_PORT: '587.5' }, { SMTP_FROM: ' ' }, { SMTP_USER: 'operator' },
  ]) expect(() => smtpSender({ ...env, ...invalid }, origin)).toThrow(/настройки SMTP/);
});

test('marks a permanent SMTP rejection once without including the raw server message', async () => {
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const store = new Store(':memory:', () => clock);
  try {
    const { id } = store.createProject('Отказ почты', '');
    store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@example.test' });
    store.addUrls(id, [{ input: 'https://example.test/', line: 1 }]);
    const run = store.enqueue(id);
    const [entry] = store.claim()!.items;
    store.saveResult(entry.id, {
      status: 'ok', httpCode: 204, redirects: 0, durationMs: 1, finalUrl: entry.url,
      contentType: null, contentLength: null, errorKind: null, error: null,
    });
    store.finish(run.id);
    let attempts = 0;
    const send = async () => {
      attempts++;
      throw Object.assign(new Error('private transport diagnostic'), { responseCode: 535 });
    };
    await deliverPending(store, send);
    clock += 24 * 60 * 60_000;
    await deliverPending(store, send);
    expect(attempts).toBe(1);
    expect(store.notifications()[0]).toMatchObject({ attempts: 1, delivery: 'failed' });
    expect(JSON.stringify(store.notifications())).not.toContain('private transport diagnostic');
  } finally { store.close(); }
});

test('coalesces overdue occurrences and persists retries separately from the run', async () => {
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const store = new Store(':memory:', () => clock);
  try {
    const { id } = store.createProject('Расписание', '');
    store.addUrls(id, [{ input: 'example.com', line: 1 }]);
    store.saveSettings(id, {
      schedule: { weekdays: [1], time: '09:00', timezone: 'Europe/Moscow' },
      notify: 'all', email: 'operator@example.com',
    });
    clock = Date.parse('2026-12-08T00:00:00Z');
    store.enqueueDue();
    store.enqueueDue();
    expect(store.runs(id)).toHaveLength(1);
    const run = store.claim()!;
    store.saveResult(run.items[0].id, {
      status: 'error', httpCode: 503, redirects: 0, durationMs: 11,
      finalUrl: 'https://example.com/', contentType: null, contentLength: null,
      errorKind: 'http', error: 'HTTP 503',
    });
    store.finish(run.id);
    const send = async () => { throw Object.assign(new Error('SMTP busy'), { responseCode: 451 }); };
    for (let attempt = 0; attempt < 4; attempt++) {
      await deliverPending(store, send);
      clock += 60 * 60_000;
    }
    expect(store.notifications()[0]).toMatchObject({ delivery: 'failed', attempts: 4, failures: 1 });
    expect(store.run(run.id, id)).toMatchObject({ status: 'done', completed: 1 });
  } finally {
    store.close();
  }
});

test.each(['errors', 'off'] as const)('filters notifications for successful runs in %s mode', notify => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('Тихий проект', '');
    store.saveSettings(id, { schedule: null, notify, email: 'operator@example.com' });
    store.addUrls(id, [{ input: 'example.com', line: 1 }]);
    store.enqueue(id);
    const run = store.claim()!;
    store.saveResult(run.items[0].id, {
      status: 'ok', httpCode: 200, redirects: 0, durationMs: 20,
      finalUrl: 'https://example.com/', contentType: null, contentLength: null,
      errorKind: null, error: null,
    });
    store.finish(run.id);
    expect(store.notifications()).toEqual([]);
  } finally {
    store.close();
  }
});

test('runs scheduled work without HTTP clients and skips email when SMTP is unavailable', async () => {
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const store = new Store(':memory:', () => clock);
  const { id } = store.createProject('Фоновый запуск', '');
  store.addUrls(id, [{ input: 'example.com', line: 1 }]);
  store.saveSettings(id, {
    schedule: { weekdays: [1], time: '09:00', timezone: 'Europe/Moscow' },
    notify: 'all', email: 'operator@example.com',
  });
  clock = Date.parse('2026-11-16T06:00:00Z');
  const stop = startBackground(store, { check: async url => ({
    status: 'ok', httpCode: 200, durationMs: 12, finalUrl: url, redirects: 0,
    contentType: null, contentLength: null, errorKind: null, error: null,
  }) });
  try {
    await expect.poll(() => store.runs(id)[0]).toMatchObject({ source: 'schedule', status: 'done', available: 1 });
    expect(store.notifications()[0]).toMatchObject({ delivery: 'disabled', attempts: 0, failures: 0 });
  } finally {
    await stop();
    store.close();
  }
});

test('pauses already queued scheduled runs while manual checks complete', async () => {
  let clock = Date.parse('2040-01-01T09:59:00Z');
  const store = new Store(':memory:', () => clock);
  const { id } = store.createProject('Пауза автоматических проверок', '');
  store.addUrls(id, [{ input: 'example.com', line: 1 }]);
  store.saveSettings(id, { schedule: { weekdays: [7], time: '10:00', timezone: 'UTC' }, notify: 'off', email: null });
  clock = Date.parse('2040-01-01T10:00:00Z');
  store.enqueueDue();
  const [scheduled] = store.runs(id);
  expect(scheduled).toMatchObject({ source: 'schedule', status: 'queued' });
  const manual = store.enqueue(id);
  let enabled = false;
  const stop = startBackground(store, { schedulesEnabled: () => enabled, check: async url => ({
    status: 'ok', httpCode: 200, redirects: 0, durationMs: 12, finalUrl: url,
    contentType: null, contentLength: null, errorKind: null, error: null,
  }) });
  try {
    await expect.poll(() => store.run(manual.id, id).status, { timeout: 3500 }).toBe('done');
    expect(store.run(scheduled.id, id)).toMatchObject({ status: 'queued', completed: 0 });
    enabled = true;
    await expect.poll(() => store.run(scheduled.id, id).status, { timeout: 3500 }).toBe('done');
  } finally {
    await stop();
    store.close();
  }
});

test.each([
  { initialSmtp: false, delivery: 'sent' },
  { initialSmtp: true, delivery: 'disabled' },
])('uses SMTP availability at completion with initial SMTP $initialSmtp', async ({ initialSmtp, delivery }) => {
  const store = new Store(':memory:');
  const { id } = store.createProject('Настройки SMTP во время проверки', '');
  store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@example.com' });
  store.addUrls(id, [{ input: 'example.com', line: 1 }]);
  const run = store.enqueue(id);

  let entered!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  let checked!: () => void;
  const releaseCheck = new Promise<void>(resolve => { checked = resolve; });
  let configured = initialSmtp;
  const send = async () => {};
  const stop = startBackground(store, {
    getSend: () => configured ? send : undefined,
    check: async url => {
      entered();
      await releaseCheck;
      return {
        status: 'ok', httpCode: 200, redirects: 0, durationMs: 12, finalUrl: url,
        contentType: null, contentLength: null, errorKind: null, error: null,
      };
    },
  });
  try {
    await checking;
    configured = !initialSmtp;
    checked();
    await expect.poll(() => store.notifications()[0]?.delivery, { timeout: 2000 }).toBe(delivery);
    expect(store.run(run.id, id).status).toBe('done');
  } finally {
    checked();
    await stop();
    store.close();
  }
});

test('retries marking a delivered email after SQLite busy without sending it again', async () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('Почта и очередь', '');
    store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@example.com' });
    store.addUrls(id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(id);
    store.saveResult(store.claim()!.items[0].id, {
      status: 'ok', httpCode: 200, durationMs: 10, finalUrl: 'https://example.com/', redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null,
    });
    store.finish(run.id);
    let sends = 0, writes = 0;
    const complete = store.finishEmail.bind(store);
    store.finishEmail = (...args) => {
      if (++writes === 1) throw Object.assign(new Error('database is locked'), { errcode: 5 });
      complete(...args);
    };
    await deliverPending(store, async () => { sends++; });
    expect(sends).toBe(1);
    expect(writes).toBe(2);
    expect(store.notifications()[0].delivery).toBe('sent');
  } finally { store.close(); }
});
