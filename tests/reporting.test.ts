import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { checkUrl } from '../src/server/checker.js';
import { reportFile } from '../src/server/export.js';
import { desktopRequest } from '../src/desktop/contracts.js';
import { Store } from '../src/server/store.js';
import { seedCompletedRun } from './fixtures/run-results.js';

const inspect = (headers: { server: string; 'www-authenticate'?: string }) => checkUrl('https://example.com/', {
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  request: async () => ({ code: 401, headers }),
});

test('names exported files with the local export date and a portable project title', () => {
  const date = new Date(2026, 0, 5, 23, 59);
  const project = 'Сервисы: API / команда';
  expect(reportFile(project, 'csv', date)).toEqual({ extension: 'csv', name: '2026-01-05 - Сервисы API команда.csv' });
  expect(reportFile(project, 'excel', date)).toEqual({ extension: 'csv', name: '2026-01-05 - Сервисы API команда.csv' });
  expect(reportFile(project, 'json', date)).toEqual({ extension: 'json', name: '2026-01-05 - Сервисы API команда.json' });
  expect(reportFile(' ... ', 'csv', date).name).toBe('2026-01-05 - Проект.csv');
  const large = reportFile('🧰'.repeat(100), 'json', date).name;
  expect(Buffer.byteLength(large)).toBeLessThanOrEqual(255);
  expect(large).toMatch(/^2026-01-05 - (?:🧰)+\.json$/u);
});

test('reports a Curator signal separately from TLS and ordinary authentication', async () => {
  expect(await inspect({ server: 'QRATOR' })).toMatchObject({
    status: 'error', httpCode: 401, errorKind: 'http', tlsCode: null, accessHint: 'curator-challenge',
  });
  expect((await inspect({ server: 'QRATOR', 'www-authenticate': 'Basic realm="test"' })).accessHint).toBeNull();
  expect((await inspect({ server: 'nginx' })).accessHint).toBeNull();
});

test('clears notifications without deleting reports or interrupting email delivery', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Уведомления', '');
    store.saveSettings(project.id, { schedule: null, notify: 'all', email: 'operator@example.com' });
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, await inspect({ server: 'QRATOR' }));
    store.finish(run.id);
    const notification = store.claimEmail()!;
    expect(store.unread()).toBe(1);
    const action = desktopRequest({ method: 'POST', path: '/api/notifications/clear', body: '{}' });
    const cleared = await app.inject({ method: action.method, url: action.path, payload: {} });
    expect(cleared.statusCode).toBe(200);
    expect((await app.inject('/api/notifications')).json()).toEqual([]);
    expect(store.unread()).toBe(0);
    store.finishEmail(notification, null, false);
    expect(store.notifications()).toEqual([]);
    expect(store.runResults(run.id)[0]).toMatchObject({ accessHint: 'curator-challenge' });
    expect((await app.inject(`/api/projects/${project.id}/export?format=csv`)).body).toContain('curator-challenge');

    const later = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, await inspect({ server: 'nginx' }));
    store.finish(later.id);
    expect(store.notifications().map(entry => entry.runId)).toEqual([later.id]);
    expect(store.unread()).toBe(1);
  } finally { await app.close(); store.close(); }
});

test('returns a compact reply for an unchanged project view and invalidates after mutation', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Снимок', '');
    const url = `/api/projects/${project.id}`;
    const first = (await app.inject(url)).json();
    expect(first.revision).toEqual(expect.any(String));
    expect((await app.inject(url + '?since=' + first.revision)).json()).toEqual({ unchanged: true });
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const updated = (await app.inject(url + '?since=' + first.revision)).json();
    expect(updated.addresses).toHaveLength(1);
    expect(updated.revision).not.toBe(first.revision);
  } finally { await app.close(); store.close(); }
});

test('invalidates project views only for changes within their own project', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Первый', '');
    const other = store.createProject('Второй', '');
    const path = `/api/projects/${project.id}?view=summary`;
    const first = (await app.inject(path)).json().revision;
    const poll = async (revision: string) => (await app.inject(path + '&since=' + encodeURIComponent(revision))).json();
    store.editProject(other.id, 'Другое имя');
    store.addUrls(other.id, [{ input: 'example.test/other', line: 1 }]);
    store.enqueue(other.id);
    expect(await poll(first)).toEqual({ unchanged: true });

    store.addUrls(project.id, [{ input: 'example.test/a', line: 1 }]);
    const afterAdd = await poll(first);
    expect(afterAdd.summary.total).toBe(1);
    const address = store.addresses(project.id)[0];
    store.editUrl(project.id, address.id, address.url, 'Новое название');
    const afterEdit = await poll(afterAdd.revision);
    expect(afterEdit.revision).not.toBe(afterAdd.revision);
    const group = store.saveGroup(project.id, 'Группа');
    const afterGroup = await poll(afterEdit.revision);
    store.changeGroupMembers(project.id, group.id, 'add', [address.id]);
    const afterMembership = await poll(afterGroup.revision);
    expect(afterMembership.revision).not.toBe(afterGroup.revision);
    const run = store.enqueue(project.id);
    expect((await poll(afterMembership.revision)).activeRun.id).toBe(run.id);
  } finally { await app.close(); store.close(); }
});

test('filters a run across pages and exports the same results in Excel-friendly CSV', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Сравнение', '');
    store.addUrls(project.id, [{ input: 'example.com/first', line: 1 }], '=HYPERLINK("foo")');
    store.addUrls(project.id, Array.from({ length: 102 }, (_, i) => ({
      input: 'example.com/check/' + i, line: i + 1,
    })));
    const okay = await inspect({ server: 'nginx' });
    const old = store.enqueue(project.id);
    const initial = store.claim()!;
    for (const entry of initial.items) store.saveResult(entry.id, { ...okay, status: 'ok', httpCode: 200, finalUrl: entry.url });
    store.finish(old.id);
    const current = store.enqueue(project.id);
    for (const entry of store.claim()!.items) {
      store.saveResult(entry.id, { ...okay, status: 'error', httpCode: 503, finalUrl: entry.url });
    }
    store.finish(current.id);
    const path = `/api/projects/${project.id}/runs/${current.id}`;
    const filters = 'status=error&httpCode=503&change=regression';
    const first = (await app.inject(path + '?' + filters)).json();
    expect(first.previousRun.id).toBe(old.id);
    expect(first.results).toHaveLength(100);
    expect(first.results[0]).toMatchObject({ change: 'regression', previousHttpCode: 200 });
    const rest = (await app.inject(path + '?' + filters + '&after=' + first.nextAfter)).json();
    expect(rest.results).toHaveLength(3);
    expect(rest.nextAfter).toBeNull();
    const allMatches = (await app.inject(path + '/export?format=json&' + filters)).json();
    expect(allMatches).toHaveLength(103);
    expect(allMatches[0]).toMatchObject({ change: 'regression', previousHttpCode: 200 });
    const exported = await app.inject(path + '/export?format=excel&' + filters + '&q=first');
    expect(exported.statusCode).toBe(200);
    const filename = decodeURIComponent(exported.headers['content-disposition']?.match(/filename\*=UTF-8''(.+)$/)?.[1] ?? '');
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2} - Сравнение\.csv$/);
    expect(exported.body).toContain('ID;Запуск;');
    expect(exported.body).toContain("'=HYPERLINK");
    expect(exported.body).toContain('Предыдущий HTTP-код');
    expect(exported.body).toContain('"Новые сбои";200;');
    expect(exported.body).toContain('https://example.com/first');
    expect(exported.body).not.toContain('https://example.com/check/');
    const original = await app.inject(path + '/export?format=json&q=first');
    expect(original.json()).toMatchObject([{ status: 'error', httpCode: 503 }]);
    expect((await app.inject(path + '?httpCode=503%20OR%201')).statusCode).toBe(400);
  } finally { await app.close(); store.close(); }
});

test.each(['baseline', 'fallback baseline', 'current'] as const)('keeps all 1305 rows when the %s is deleted after 500 rows', async target => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openReportRows } = await import('../src/server/export.js');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-export-snapshot-'));
  const file = join(dir, 'pulse.sqlite3');
  let now = Date.parse('2026-11-20T09:00:00.000Z');
  const store = new Store(file, () => ++now);
  const fixture = new DatabaseSync(file);
  try {
    const project = store.createProject('Снимок', '');
    store.addUrls(project.id, Array.from({ length: 1305 }, (_, i) => ({ input: 'example.com/row/' + i, line: i + 1 })));
    const complete = (httpCode: number) => {
      const run = store.enqueue(project.id);
      expect(store.claim()?.id).toBe(run.id);
      seedCompletedRun(fixture, run.id, httpCode, new Date(++now).toISOString());
      store.finish(run.id);
      return run.id;
    };
    const baseline = complete(200);
    if (target === 'fallback baseline') {
      store.enqueueCatalog(project.id, ['https://example.com/standalone']);
      const { id, items: [item] } = store.claim()!;
      store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 12, finalUrl: item.url,
        redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null }, id);
      store.finish(id);
    }
    const current = complete(503);
    const results = [];
    for await (const row of await openReportRows(store, project.id, { runId: current }, { change: 'regression' })) {
      results.push(row);
      if (results.length === 500) store.deleteRun(project.id, target === 'current' ? current : baseline);
    }
    expect(results).toHaveLength(1305);
    expect(new Set(results.map(row => row.id)).size).toBe(1305);
    expect(results.every(row => row.previousHttpCode === 200)).toBe(true);
  } finally { fixture.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reports and exports regressions when the nearest completed run skipped the URL', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Точечные проверки', '');
    store.addUrls(id, ['a', 'b', 'c'].map((url, i) => ({ input: 'example.com/' + url, line: i + 1 })));
    const [a, b, c] = store.addresses(id);
    const complete = (codes: number[], ids?: number[], cancelled = false) => {
      const run = store.enqueue(id, ids);
      const { items } = store.claim()!;
      for (const [index, code] of codes.entries()) {
        const item = items[index];
        store.saveResult(item.id, { status: code === 200 ? 'ok' : 'error', httpCode: code,
          durationMs: 12, finalUrl: item.url, redirects: 0, contentType: null, contentLength: null,
          errorKind: code === 200 ? null : 'http', error: code === 200 ? null : 'HTTP ' + code }, run.id);
      }
      if (cancelled) store.stopRun(id, run.id);
      else store.finish(run.id);
      return run;
    };
    complete([200, 200, 200]);
    complete([404], [b.id, c.id], true);
    const nearest = complete([200], [a.id]);
    store.editUrl(id, c.id, 'example.com/c-v2', '');
    const current = complete([200, 503, 503]);
    const path = `/api/projects/${id}/runs/${current.id}`;
    const report = await app.inject(path);
    expect(report.json().previousRun.id).toBe(nearest.id);
    expect(report.json().results).toMatchObject([
      { urlId: a.id, change: null, previousHttpCode: 200 },
      { urlId: b.id, change: 'regression', httpCode: 503, previousHttpCode: 200 },
      { urlId: c.id, change: null, previousHttpCode: null },
    ]);
    const filtered = await app.inject(path + '?change=regression');
    expect(filtered.json().results).toMatchObject([{ urlId: b.id, previousHttpCode: 200 }]);

    const exported = await app.inject(path + '/export?format=json&change=regression');
    expect(exported.json()).toMatchObject([{ urlId: b.id, change: 'regression', previousHttpCode: 200 }]);
    for (const format of ['csv', 'excel']) {
      const csv = await app.inject(path + `/export?format=${format}&change=regression`);
      expect(csv.body).toContain('https://example.com/b');
      expect(csv.body).not.toContain('https://example.com/a');
      expect(csv.body).not.toContain('https://example.com/c-v2');
    }
  } finally { await app.close(); store.close(); }
});

test('orders late scheduled results by check time and compares only preceding outcomes', async () => {
  let now = Date.parse('2026-11-20T09:00:00.000Z');
  const store = new Store(':memory:', () => now);
  const app = createApp({ store });
  try {
    const project = store.createProject('Фактическая хронология', '');
    const base = `/api/projects/${project.id}`;
    store.addUrls(project.id, [{ input: 'https://example.test/chronology', line: 1 }]);
    const address = store.addresses(project.id)[0];
    store.saveSettings(project.id, { schedule: { weekdays: [5], time: '09:10', timezone: 'UTC' },
      notify: 'off', email: null });
    now = Date.parse('2026-11-20T09:10:01.000Z');
    store.enqueueDue();
    const scheduled = store.queuedRuns(project.id)[0];
    const manual = store.enqueue(project.id);
    function complete(runId: number, schedulesEnabled: boolean, at: string, code: number) {
      const claimed = store.claim(schedulesEnabled)!;
      expect(claimed.id).toBe(runId);
      now = Date.parse(at);
      const item = claimed.items[0];
      store.saveResult(item.id, { status: code === 200 ? 'ok' : 'error', httpCode: code, durationMs: 10,
        finalUrl: item.url, redirects: 0, contentType: null, contentLength: null,
        errorKind: code === 200 ? null : 'http', error: code === 200 ? null : 'HTTP 503' }, runId);
      store.finish(runId, false);
    }
    complete(manual.id, false, '2026-11-20T10:01:00.000Z', 200);
    complete(scheduled.id, true, '2026-11-20T10:02:00.000Z', 503);

    expect((await app.inject(base + '?view=summary')).json().summary).toMatchObject({ available: 0, failures: 1 });
    expect((await app.inject(base + '/urls/page')).json().items[0].latest.httpCode).toBe(503);
    const path = base + '/urls/' + address.id;
    const history = (await app.inject(path)).json().history;
    expect(history.map((entry: { httpCode: number }) => entry.httpCode)).toEqual([503, 200]);
    expect((await app.inject(path + '?before=' + history[0].id)).json().history).toMatchObject([{ httpCode: 200 }]);
    expect((await app.inject(path + '/export?format=json')).json().map((entry: { httpCode: number }) => entry.httpCode)).toEqual([503, 200]);
    const original = (await app.inject(base + '/runs/' + manual.id)).json();
    expect(original.previousRun).toBeNull();
    expect(original.results[0]).toMatchObject({ httpCode: 200, change: null, previousHttpCode: null });
    const late = base + '/runs/' + scheduled.id;
    const comparison = (await app.inject(late + '?change=regression')).json();
    expect(comparison.previousRun.id).toBe(manual.id);
    expect(comparison.results).toMatchObject([{ httpCode: 503, change: 'regression', previousHttpCode: 200 }]);
    expect((await app.inject(late + '/export?format=json')).json()).toMatchObject([
      { httpCode: 503, change: 'regression', previousHttpCode: 200 },
    ]);
    expect((await app.inject(late + '/export?format=csv')).body).toContain('"regression",200');
    expect((await app.inject(late + '/export?format=excel&change=regression')).body).toContain('"Новые сбои";200;');
    store.deleteRun(project.id, scheduled.id);
    const older = new URLSearchParams({ before: String(history[0].id), beforeAt: history[0].checkedAt });
    expect((await app.inject(path + '?' + older)).json().history).toMatchObject([{ httpCode: 200 }]);
  } finally { await app.close(); store.close(); }
});
