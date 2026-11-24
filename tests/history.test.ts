import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import * as appModule from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { CheckResult } from '../src/shared/types.js';

const result: CheckResult = {
  status: 'ok', httpCode: 204, durationMs: 12, finalUrl: 'https://example.com/',
  redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null,
};

test('paginates a project journal without shifting older pages when a new run is added', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const project = store.createProject('Журнал', '');
    const other = store.createProject('Чужой журнал', '');
    for (const entry of [project, other]) store.addUrls(entry.id, [{ input: 'example.com', line: 1 }]);
    const ids = Array.from({ length: 50 }, () => {
      const { id } = store.enqueue(project.id);
      store.stopRun(project.id, id);
      return id;
    }).reverse();
    store.enqueue(other.id);
    const path = `/api/projects/${project.id}/runs`;
    expect((await app.inject(path)).json().map((run: { id: number }) => run.id)).toEqual(ids);

    const first = (await app.inject(path + '?view=page')).json();
    expect(first.items).toHaveLength(25);
    expect(first.items.map((run: { id: number }) => run.id)).toEqual(ids.slice(0, 25));
    expect(first.nextBefore).toBe(ids[24]);
    store.enqueue(project.id);
    const second = (await app.inject(`${path}?view=page&before=${first.nextBefore}`)).json();
    expect(second.items.map((run: { id: number }) => run.id)).toEqual(ids.slice(25));
    expect(second.nextBefore).toBeNull();
  } finally { await app.close(); store.close(); }
});

test('resumes pending items and preserves completed results across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-history-'));
  try {
    const file = join(dir, 'history.db');
    const initial = new Store(file);
    const project = initial.createProject('Проверки', '');
    initial.addUrls(project.id, [{ input: 'example.com', line: 1 }, { input: 'example.org', line: 2 }]);
    const run = initial.enqueue(project.id);
    const job = initial.claim();
    expect(job?.id).toBe(run.id);
    initial.saveResult(job!.items[0].id, result);
    initial.close();

    const restarted = new Store(file);
    try {
      const resumed = restarted.claim();
      expect(resumed?.items).toHaveLength(1);
      expect(resumed?.items[0].url).toBe('https://example.org/');
      restarted.saveResult(resumed!.items[0].id, result);
      restarted.finish(run.id);
      expect(restarted.run(run.id, project.id)).toMatchObject({ completed: 2, available: 2, status: 'done' });
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exports the original checks after an address is edited and deleted', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const project = store.createProject('Отчёт', '');
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }], '=1+1');
    const address = store.addresses(project.id)[0];
    const run = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, result);
    store.finish(run.id);
    store.editUrl(project.id, address.id, 'example.org', 'Новый адрес');
    expect(store.addresses(project.id)[0].latest).toBeNull();
    store.deleteUrls(project.id, [address.id]);
    const root = `/api/projects/${project.id}`;
    for (const scope of [root, `${root}/urls/${address.id}`, `${root}/runs/${run.id}`]) {
      const response = await app.inject(scope + '/export?format=json');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject([{
        url: 'https://example.com/', label: '=1+1', checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }]);
    }
    const csv = await app.inject(root + '/export?format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain("'=1+1");
    expect((await app.inject(`${root}/urls/${address.id}`)).json().versions).toHaveLength(2);
  } finally {
    await app.close();
    store.close();
  }
});

test('renames a project while preserving history, configuration and its ID', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const project = store.createProject('Старое имя', 'Описание');
    const schedule = { weekdays: [1], time: '09:00', timezone: 'Europe/Moscow' };
    const settings = store.saveSettings(project.id, { schedule, notify: 'errors', email: null });
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, result);
    store.finish(run.id);
    const path = `/api/projects/${project.id}`;
    const response = await app.inject({ method: 'PATCH', url: path, payload: { name: '  Новое имя  ' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ...settings, name: 'Новое имя', urlCount: 1 });
    expect((await app.inject(path + '/runs/' + run.id)).json().results).toHaveLength(1);
    expect((await app.inject({ method: 'PATCH', url: path, payload: { name: '   ' } })).statusCode).toBe(400);
  } finally {
    await app.close();
    store.close();
  }
});

test('deletes all data for one project and never reuses the deleted project ID', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const kept = store.createProject('Сохранить', '');
    store.addUrls(kept.id, [{ input: 'example.org', line: 1 }]);
    const project = store.createProject('Удалить', '');
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, result);
    store.finish(run.id);
    store.enqueue(project.id);
    expect(store.notifications()).toHaveLength(1);
    const path = `/api/projects/${project.id}`;
    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
    expect((await app.inject(path + '/export')).statusCode).toBe(404);
    expect(store.projects().map(entry => entry.id)).toEqual([kept.id]);
    expect(store.addresses(kept.id)).toHaveLength(1);
    expect(store.addresses(project.id)).toHaveLength(0);
    expect(store.runs(project.id)).toHaveLength(0);
    expect(store.notifications()).toHaveLength(0);
    expect(store.claim()).toBeUndefined();
    expect(store.createProject('Новый проект', '').id).toBeGreaterThan(project.id);
  } finally {
    await app.close();
    store.close();
  }
});

test('asks to retry project deletion while a check or email is in flight', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const project = store.createProject('Активный', '');
    store.saveSettings(project.id, { schedule: null, notify: 'all', email: 'operator@example.com' });
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(project.id);
    const check = store.claim()!;
    const path = `/api/projects/${project.id}`;
    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(409);
    store.saveResult(check.items[0].id, result);
    store.finish(run.id);
    const email = store.claimEmail()!;
    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(409);
    store.finishEmail(email, null, false);
    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
  } finally {
    await app.close();
    store.close();
  }
});

test('deletes one finished report and restores the latest remaining URL result', async () => {
  const store = new Store(':memory:');
  const app = appModule.createApp({ store });
  try {
    const project = store.createProject('Отчёты', '');
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const path = `/api/projects/${project.id}`;
    const first = store.enqueue(project.id);
    store.saveResult(store.claim()!.items[0].id, result);
    store.finish(first.id);
    const removed = store.enqueue(project.id);
    const report = path + '/runs/' + removed.id;
    expect((await app.inject({ method: 'DELETE', url: report })).statusCode).toBe(409);
    store.saveResult(store.claim()!.items[0].id, { ...result, status: 'error', httpCode: 503, errorKind: 'http' });
    store.finish(removed.id);
    expect(store.addresses(project.id)[0].latest?.httpCode).toBe(503);
    expect((await app.inject({ method: 'DELETE', url: report })).statusCode).toBe(200);
    expect((await app.inject(report + '/export')).statusCode).toBe(404);
    expect(store.addresses(project.id)[0].latest?.httpCode).toBe(204);
    expect(store.runs(project.id).map(run => run.id)).toEqual([first.id]);
    expect(store.notifications().map(entry => entry.runId)).toEqual([first.id]);
    expect(store.enqueue(project.id).id).toBeGreaterThan(removed.id);
  } finally {
    await app.close();
    store.close();
  }
});

test('keeps existing project and run IDs when an older database is opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-upgrade-'));
  try {
    const file = join(dir, 'legacy.sqlite3');
    const previous = new Store(file);
    const project = previous.createProject('До обновления', '');
    previous.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const run = previous.enqueue(project.id);
    previous.close();

    const legacy = new DatabaseSync(file);
    legacy.exec(`
      DROP TABLE id_sequences;
      DROP TABLE request_url_profiles;
      DROP TABLE request_profiles;
      DROP TABLE project_pac_versions;
      DROP INDEX project_pac_runs;
      DROP INDEX visible_notifications;
      ALTER TABLE projects DROP COLUMN tls_profile;
      ALTER TABLE projects DROP COLUMN url_count;
      ALTER TABLE projects DROP COLUMN check_concurrency;
      ALTER TABLE projects DROP COLUMN request_revision;
      ALTER TABLE runs DROP COLUMN tls_profile;
      ALTER TABLE runs DROP COLUMN total;
      ALTER TABLE runs DROP COLUMN completed;
      ALTER TABLE runs DROP COLUMN available;
      ALTER TABLE runs DROP COLUMN failures;
      ALTER TABLE runs DROP COLUMN request_revision;
      ALTER TABLE runs DROP COLUMN request_snapshot;
      ALTER TABLE runs DROP COLUMN pac_revision;
      ALTER TABLE results DROP COLUMN tls_code;
      ALTER TABLE results DROP COLUMN access_hint;
      ALTER TABLE results DROP COLUMN request_profile_override;
      ALTER TABLE results DROP COLUMN request_profile;
      ALTER TABLE results DROP COLUMN request_route;
      ALTER TABLE results DROP COLUMN failure_stage;
      ALTER TABLE results DROP COLUMN proxy_http_code;
      ALTER TABLE results DROP COLUMN request_proxy;
      ALTER TABLE results DROP COLUMN request_source;
      ALTER TABLE notifications DROP COLUMN cleared_at;
    `);
    legacy.close();

    const upgraded = new Store(file);
    try {
      expect(upgraded.project(project.id)).toMatchObject({ name: 'До обновления', tlsProfile: 'default', urlCount: 1, checkConcurrency: 6 });
      expect(upgraded.run(run.id, project.id)).toMatchObject({ total: 1, tlsProfile: 'default' });
      expect(upgraded.requestProfiles(project.id)).toEqual([]);
      expect(upgraded.requestSnapshot(run.id)).toEqual([]);
      expect(upgraded.pacSnapshot(run.id)).toBeUndefined();
      expect(upgraded.runResults(run.id)[0]).toMatchObject({ tlsCode: null, accessHint: null, requestProfile: null, requestRoute: null });
      expect(upgraded.clearNotifications()).toEqual({ cleared: 0 });
      expect(upgraded.createProject('После обновления', '').id).toBeGreaterThan(project.id);
      expect(upgraded.enqueue(project.id).id).toBe(run.id);
      upgraded.stopRun(project.id, run.id);
      expect(upgraded.enqueue(project.id).id).toBeGreaterThan(run.id);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshots the complete working list and reads pending checks in bounded batches', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('Большой запуск', '');
    const urls = Array.from({ length: 535 }, (_, i) => ({ input: `https://sample.test/${i}`, line: i + 1 }));
    store.addUrls(id, urls);
    const run = store.enqueue(id);
    store.deleteUrls(id, [store.addresses(id)[0].id]);
    const claimed = store.claim()!;
    expect(claimed.items.length).toBeLessThan(urls.length);
    const first = claimed.items[0];
    expect(first.url).toBe(urls[0].input);
    store.saveResult(first.id, result);
    store.saveResult(first.id, result);
    expect(store.run(run.id, id)).toMatchObject({ total: urls.length, completed: 1, available: 1 });
    expect(store.pendingResults(run.id)[0].id).not.toBe(first.id);
  } finally { store.close(); }
});
