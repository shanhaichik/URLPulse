import { expect, test } from 'vitest';
import { reportParams } from '../src/shared/reports.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('accepts local clients and consistently applies the cache and framing policy', async () => {
  const app = createApp({ origin: 'http://127.0.0.1:8731' });
  try {
    const options = { method: 'POST' as const, url: '/api/projects', payload: { name: 'Локальный проект' } };
    const deniedHost = await app.inject({ ...options, headers: { host: 'not-local.test' } });
    const deniedOrigin = await app.inject({ ...options, headers: { host: '127.0.0.1:8731', origin: 'https://not-local.test' } });
    expect(deniedHost.statusCode).toBe(403);
    expect(deniedOrigin.statusCode).toBe(403);
    const read = await app.inject({ url: '/api/projects', headers: { host: '127.0.0.1:8731' } });
    expect(read.json().projects).toEqual([]);
    expect(read.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': expect.stringContaining("frame-ancestors 'none'"),
    });
    const saved = await app.inject({ ...options, headers: { host: 'localhost:8731', origin: 'http://localhost:8731' } });
    expect(saved.statusCode).toBe(201);
  } finally { await app.close(); }
});

test('validates schedule and notification payloads before replacing a saved configuration', async () => {
  const app = createApp();
  try {
    const { id } = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Настройки' } })).json();
    const root = `/api/projects/${id}`;
    const schedule = { weekdays: [7, 1, 7], time: '23:59', timezone: 'Europe/Moscow' };
    const valid = { notify: 'errors', tlsProfile: 'russian-ca', checkConcurrency: 24, email: 'tester@example.test', schedule };
    const save = (payload: object) => app.inject({ method: 'PATCH', url: root + '/settings', payload });
    const saved = (await save(valid)).json();
    expect(saved).toMatchObject({ ...valid, schedule: { ...schedule, weekdays: [1, 7] }, nextAt: expect.any(String) });
    for (const patch of [
      { notify: 'sometimes' }, { tlsProfile: 'unknown' }, { checkConcurrency: 0 }, { checkConcurrency: 25 },
      { checkConcurrency: '6' }, { checkConcurrency: 1.25 }, { email: 'a@example.test,b@example.test' },
      ...[{ weekdays: [] }, { weekdays: [0, 8] }, { time: '24:00' }, { time: '9:00' }, { timezone: 'Mars/Olympus' }]
        .map(schedulePatch => ({ schedule: { ...schedule, ...schedulePatch } })),
    ]) expect((await save({ ...valid, ...patch })).statusCode, JSON.stringify(patch)).toBe(400);
    expect((await app.inject(root)).json().project).toEqual(saved);
    expect((await save({ notify: 'off', checkConcurrency: 1, schedule: null })).json())
      .toMatchObject({ notify: 'off', checkConcurrency: 1, schedule: null, nextAt: null, email: null });
  } finally { await app.close(); }
});

test('validates report/export filters and protects project scope', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const first = store.createProject('Проверки', '');
    const other = store.createProject('Отдельный проект', '');
    store.addUrls(first.id, [{ input: 'https://sample.test/case', line: 1 }], 'Тест & проверка');
    const { id } = store.enqueue(first.id);
    const [item] = store.claim()!.items;
    store.saveResult(item.id, {
      status: 'error', httpCode: 599, durationMs: 10, finalUrl: item.url, redirects: 0,
      contentType: null, contentLength: null, errorKind: 'http', error: 'HTTP 599',
    }, id);
    store.finish(id);
    const root = `/api/projects/${first.id}/runs/${id}`;
    const filters = reportParams({ q: 'ТЕСТ & проверка', status: 'error', httpCode: 599 });
    expect((await app.inject(`${root}?${filters}`)).json().results).toMatchObject([{ httpCode: 599, label: 'Тест & проверка' }]);
    expect((await app.inject(`${root}/export?format=json&${filters}`)).json()).toMatchObject([{ httpCode: 599 }]);
    expect((await app.inject(`/api/projects/${other.id}/runs/${id}/export?format=json`)).statusCode).toBe(404);
    for (const query of ['httpCode=99', 'httpCode=600', 'httpCode=2e2', 'httpCode=200&httpCode=201',
      'status=pending', 'change=other', 'q=%09', 'q=' + 'x'.repeat(513), 'after=0']) {
      expect((await app.inject(`${root}?${query}`)).statusCode, query.slice(0, 35)).toBe(400);
    }
    expect((await app.inject(root + '/export?format=xml')).statusCode).toBe(400);
    expect((await app.inject(root + '?httpCode=100')).json().results).toEqual([]);
  } finally { await app.close(); store.close(); }
});
