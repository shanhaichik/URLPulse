import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { startBackground } from '../src/server/worker.js';
import type { CheckResult } from '../src/shared/types.js';

const checked = (url: string): CheckResult => ({ status: 'ok', httpCode: 200, durationMs: 10, finalUrl: url,
  redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });

test('retains the partial report and never restarts a stopped run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-stop-'));
  const file = join(directory, 'test.sqlite3');
  const store = new Store(file);
  const app = createApp({ store });
  try {
    const project = store.createProject('Проверки', '');
    const other = store.createProject('Другой проект', '');
    store.addUrls(project.id, ['first', 'second'].map((path, i) => ({ input: `example.com/${path}`, line: i + 1 })));
    const { id } = store.enqueue(project.id);
    const [first, pending] = store.claim()!.items;
    store.saveResult(first.id, checked(first.url));
    expect((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/runs/${id}/stop` })).statusCode).toBe(404);
    expect(store.run(id, project.id).status).toBe('running');

    const path = `/api/projects/${project.id}/runs/${id}`;
    const stopped = await app.inject({ method: 'POST', url: path + '/stop' });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'cancelled', total: 2, completed: 1, available: 1, finishedAt: expect.any(String) });
    store.requeue(id);
    store.finish(id);
    store.saveResult(pending.id, checked(pending.url));
    expect(store.activeRun(project.id)).toBeNull();
    expect(store.notifications()).toEqual([]);
    expect((await app.inject(path)).json().results.map((row: { id: number }) => row.id)).toEqual([first.id]);
    expect((await app.inject(path + '/export?format=json')).json()).toMatchObject([{ id: first.id, httpCode: 200 }]);
    expect((await app.inject({ method: 'POST', url: path + '/stop' })).json()).toEqual(stopped.json());

    const restarted = new Store(file);
    try {
      expect(restarted.claim()).toBeUndefined();
      expect(restarted.run(id, project.id).status).toBe('cancelled');
    } finally { restarted.close(); }
    expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('can stop a queued run without starting it or changing a completed one', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Очередь', '');
    store.addUrls(project.id, [{ input: 'example.com/one', line: 1 }, { input: 'example.com/two', line: 2 }]);
    const [one, two] = store.addresses(project.id);
    const stopped = store.enqueue(project.id, [one.id]);
    const queued = store.enqueue(project.id, [two.id]);
    const path = `/api/projects/${project.id}/runs`;
    const request = desktopRequest({ method: 'POST', path: `${path}/${stopped.id}/stop` });
    const response = await app.inject({ method: request.method, url: request.path });
    expect(response.json()).toMatchObject({ id: stopped.id, status: 'cancelled', completed: 0 });
    const work = store.claim()!;
    expect(work.id).toBe(queued.id);
    store.saveResult(work.items[0].id, checked(work.items[0].url));
    store.finish(queued.id);
    expect((await app.inject({ method: 'POST', url: `${path}/${queued.id}/stop` })).json()).toMatchObject({ status: 'done' });
    expect(store.activeRun(project.id)).toBeNull();
  } finally { await app.close(); store.close(); }
});

test('restarts every original target of a stopped selection with clean results and current TLS settings', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Заново', '');
    const other = store.createProject('Другой проект', '');
    store.addUrls(id, ['finished', 'pending', 'unselected'].map((path, i) => ({ input: `example.com/${path}`, line: i + 1 })));
    const [finished, pending] = store.addresses(id);
    const run = store.enqueue(id, [finished.id, pending.id]);
    const [result] = store.claim()!.items;
    store.saveResult(result.id, checked(result.url));
    const path = `/api/projects/${id}/runs/${run.id}`;
    expect((await app.inject({ method: 'POST', url: path + '/restart' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/runs/${run.id}/restart` })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: path + '/stop' });
    store.editUrl(id, pending.id, 'https://example.com/changed', 'Edited');
    store.deleteUrls(id, [finished.id]);
    store.saveSettings(id, { schedule: null, notify: 'off', email: null, tlsProfile: 'russian-ca' });

    const request = desktopRequest({ method: 'POST', path: path + '/restart' });
    const response = await app.inject({ method: request.method, url: request.path });
    expect(response.statusCode).toBe(202);
    const next = response.json().id;
    expect(next).not.toBe(run.id);
    expect((await app.inject({ method: request.method, url: request.path })).json()).toEqual({ id: next });
    expect((await app.inject(path)).json()).toMatchObject({
      run: { status: 'cancelled', total: 2, completed: 1 }, results: [{ id: result.id, httpCode: 200 }],
    });
    const work = store.claim()!;
    expect(work).toMatchObject({ id: next, tlsProfile: 'russian-ca', items: [
      { url: 'https://example.com/finished' }, { url: 'https://example.com/pending' },
    ] });
    expect(store.run(next, id)).toMatchObject({ total: 2, completed: 0 });
    expect(store.runResults(next).map(row => [row.status, row.httpCode, row.version])).toEqual([
      ['pending', null, 1], ['pending', null, 1],
    ]);
    await app.inject({ method: 'DELETE', url: path });
    expect(store.runResults(next)).toHaveLength(2);
  } finally { await app.close(); store.close(); }
});

test('marks older stopped reports with missing targets and rejects an inaccurate replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-legacy-restart-'));
  const file = join(directory, 'test.sqlite3');
  const store = new Store(file);
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Старая проверка', '');
    store.addUrls(id, [{ input: 'example.com', line: 1 }]);
    const run = store.enqueue(id);
    const legacy = new DatabaseSync(file);
    try {
      legacy.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(run.id);
      legacy.prepare('DELETE FROM results WHERE run_id=?').run(run.id);
    } finally { legacy.close(); }
    const path = `/api/projects/${id}/runs/${run.id}`;
    expect((await app.inject(path)).json().restart).toMatchObject({ id: run.id, canRestart: false });
    expect((await app.inject({ method: 'POST', url: path + '/restart' })).statusCode).toBe(409);
    expect(store.claim()).toBeUndefined();
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('aborts in-flight checks and frees the worker for the next run', async () => {
  const store = new Store(':memory:');
  const project = store.createProject('Активная проверка', '');
  store.addUrls(project.id, Array.from({ length: 10 }, (_, i) => ({ input: `example.com/${i}`, line: i + 1 })));
  const [first] = store.addresses(project.id);
  const run = store.enqueue(project.id);
  const next = store.enqueue(project.id, [first.id]);
  const blocked: Array<() => void> = [];
  let aborts = 0;
  const background = startBackground(store, { check: (url, _profile, signal) => {
    if (url === first.url) return Promise.resolve(checked(url));
    return new Promise(resolve => {
      blocked.push(() => resolve(checked(url)));
      signal?.addEventListener('abort', () => { aborts++; resolve(checked(url)); }, { once: true });
    });
  } });
  const app = createApp({ store, onRunStopped: id => background.cancelRun(id) });
  try {
    await vi.waitFor(() => expect(store.run(run.id, project.id).completed).toBe(1));
    const started = blocked.length;
    expect(started).toBeGreaterThan(0);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/runs/${run.id}/stop` });
    expect(response.statusCode).toBe(200);
    expect(aborts).toBe(started);
    await vi.waitFor(() => expect(store.run(next.id, project.id).status).toBe('done'), { timeout: 3000 });
    expect(blocked).toHaveLength(started);
    expect(store.run(run.id, project.id)).toMatchObject({ completed: 1, failures: 0, status: 'cancelled' });
  } finally {
    const closeWorker = background();
    blocked.forEach(resolve => resolve());
    await closeWorker;
    await app.close();
    store.close();
  }
});

test('a late result cannot overwrite a pending row whose ID was reused by another run', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Поздний ответ', '');
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    const stopped = store.enqueue(project.id);
    const [old] = store.claim()!.items;
    store.stopRun(project.id, stopped.id);
    const next = store.enqueue(project.id);
    expect(store.claim()!.items[0].id).toBe(old.id);
    store.saveResult(old.id, checked(old.url), stopped.id);
    expect(store.run(next.id, project.id).completed).toBe(0);
  } finally { store.close(); }
});
