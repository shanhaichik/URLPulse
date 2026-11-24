import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('rejects a stale full-clear preview after equal-count replacement and new checks', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Предпросмотр', '');
    const path = `/api/projects/${id}/urls/delete/all`;
    const preview = async () => (await app.inject(path)).json();
    const clear = (scope: Awaited<ReturnType<typeof preview>>) => app.inject({
      method: 'POST', url: path, payload: { confirmation: scope.confirmation, expectedCount: scope.addresses },
    });
    store.addUrls(id, [{ input: 'https://example.test/old', line: 1 }]);
    const old = store.addresses(id)[0];
    const first = await preview();
    store.deleteUrls(id, [old.id]);
    store.addUrls(id, [{ input: 'https://example.test/new', line: 1 }]);
    expect((await clear(first)).statusCode).toBe(409);
    const second = await preview();
    expect(second.addresses).toBe(first.addresses);
    const run = store.enqueue(id);
    expect((await clear(second)).statusCode).toBe(409);
    expect(store.run(run.id, id).status).toBe('queued');
    expect(store.addresses(id)).toMatchObject([{ url: 'https://example.test/new' }]);
    expect((await clear(await preview())).json()).toEqual({ deleted: 1, stopped: 1 });
  } finally { await app.close(); store.close(); }
});

test('clears thirty thousand addresses in one request and stops only the confirmed project’s checks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-clear-worklist-'));
  const file = join(directory, 'pulse.sqlite');
  const store = new Store(file);
  const db = new DatabaseSync(file);
  const interrupted: number[] = [];
  const app = createApp({ store, onRunStopped: id => interrupted.push(id) });
  try {
    const project = store.createProject('Большой список', '');
    const other = store.createProject('Другой проект', '');
    const count = 30_000;
    db.prepare(`INSERT INTO urls(project_id,url,label)
      WITH RECURSIVE series(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM series WHERE n<?)
      SELECT ?,printf('https://example.test/page/%05d',n),'' FROM series`).run(count, project.id);
    db.prepare('UPDATE projects SET url_count=? WHERE id=?').run(count, project.id);
    const first = store.worklist.page(project.id, { q: '', status: 'all', sort: 'url', direction: 'asc' }, 1).items[0];
    const group = store.saveGroup(project.id, 'Ключевые URL');
    store.changeGroupMembers(project.id, group.id, 'add', [first.id]);
    store.addUrls(other.id, [{ input: 'https://example.test/other-project', line: 1 }]);
    const running = store.enqueue(project.id);
    const [checked, pending] = store.claim()!.items;
    const outcome = { status: 'ok', httpCode: 200, durationMs: 2, finalUrl: checked.url, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null } as const;
    store.saveResult(checked.id, outcome, running.id);
    const waiting = store.enqueueGroup(project.id, group.id);
    const separate = store.enqueue(other.id);
    const catalog = store.enqueueCatalog(project.id, ['https://example.test/catalog-only']);
    const catalogAddress = store.runResults(catalog.id)[0].urlId;
    const schedule = { weekdays: [1, 2, 3, 4, 5, 6, 7], time: '00:00', timezone: 'UTC' };
    store.saveSettings(project.id, { schedule, notify: 'off', email: null });
    db.prepare('UPDATE projects SET next_at=0 WHERE id=?').run(project.id);
    store.enqueueDue();
    const scheduled = store.queuedRuns(project.id).find(run => run.source === 'schedule')!;

    const path = `/api/projects/${project.id}/urls/delete/all`;
    const preview = await app.inject(desktopRequest({ method: 'GET', path }).path);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ projectName: project.name, addresses: count, running: 1, queued: 3 });
    const clear = (expectedCount: number, confirmation = preview.json().confirmation) =>
      app.inject({ method: 'POST', url: path, payload: { expectedCount, confirmation } });
    expect((await clear(count - 1, 'a'.repeat(64))).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: path, payload: {} })).statusCode).toBe(400);
    db.prepare("INSERT INTO catalog_transfers(project_id,created_at) VALUES (?,datetime('now'))").run(project.id);
    expect((await app.inject(path)).json().transferActive).toBe(true);
    expect((await clear(count)).statusCode).toBe(409);
    db.prepare("UPDATE catalog_transfers SET state='cancelled' WHERE project_id=?").run(project.id);
    expect(store.run(running.id, project.id).status).toBe('running');
    expect(interrupted).toEqual([]);
    expect(desktopRequest({ method: 'POST', path }).path).toBe(path);
    expect((await clear(count)).statusCode).toBe(409);
    expect((await clear(count, (await app.inject(path)).json().confirmation)).json()).toEqual({ deleted: count, stopped: 4 });
    expect(interrupted).toEqual([running.id]);
    store.saveResult(pending.id, outcome, running.id);
    expect(store.project(project.id).urlCount).toBe(0);
    expect(store.groups(project.id)).toMatchObject([{ id: group.id, count: 0 }]);
    expect(store.address(project.id, catalogAddress).removedAt).toBeNull();
    expect(store.run(running.id, project.id)).toMatchObject({ status: 'cancelled', completed: 1, total: count });
    expect(store.runResults(running.id)).toMatchObject([{ httpCode: 200, urlId: first.id }]);
    expect(store.run(waiting.id, project.id).status).toBe('cancelled');
    expect(store.run(catalog.id, project.id).status).toBe('cancelled');
    expect(store.run(scheduled.id, project.id).status).toBe('cancelled');
    expect(store.project(project.id).schedule).toEqual(schedule);
    expect(store.run(separate.id, other.id).status).toBe('queued');
    expect(store.project(other.id).urlCount).toBe(1);
    expect((await clear(count)).statusCode).toBe(409);

    store.restoreUrl(project.id, first.id);
    expect(store.addresses(project.id)[0]).toMatchObject({ id: first.id, latest: { httpCode: 200 } });
    expect(store.groups(project.id)).toMatchObject([{ id: group.id, count: 1 }]);
  } finally { await app.close(); db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('edits and clears a project description while preserving it for name-only requests', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Проект', 'Исходное описание');
    const url = `/api/projects/${project.id}`;
    const patch = async (name: string, description?: string) =>
      (await app.inject({ method: 'PATCH', url, payload: { name, description } })).json();
    expect(await patch('Одно имя')).toMatchObject({ name: 'Одно имя', description: 'Исходное описание' });
    expect(await patch('Новое имя', 'Новое описание')).toMatchObject({ name: 'Новое имя', description: 'Новое описание' });
    expect(await patch('Новое имя', '')).toMatchObject({ name: 'Новое имя', description: '' });
  } finally { await app.close(); store.close(); }
});

test('previews the exact deletion scope and rejects changes to a previewed URL', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Выделение', '');
    store.addUrls(project.id, [{ input: 'example.test/hidden', line: 1 }, { input: 'example.test/visible', line: 2 }]);
    const [hidden, visible] = store.addresses(project.id);
    const path = `/api/projects/${project.id}/urls/delete`;
    const response = await app.inject({ method: 'POST', url: path + '/preview?q=visible', payload: { ids: [hidden.id, visible.id] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: hidden.id, url: hidden.url, version: 1, matchesFilter: false },
      { id: visible.id, url: visible.url, version: 1, matchesFilter: true },
    ]);
    store.editUrl(project.id, hidden.id, 'example.test/changed', '');
    expect((await app.inject({ method: 'POST', url: path, payload: { ids: [hidden.id, visible.id], versions: [1, 1] } })).statusCode).toBe(409);
    expect(store.addresses(project.id)).toHaveLength(2);
  } finally { await app.close(); store.close(); }
});

test('restores the same address with its history through the API and by adding the URL again', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Архив', '');
    const input = 'https://example.test/archive';
    store.addUrls(project.id, [{ input, line: 1 }], 'Название');
    const address = store.addresses(project.id)[0];
    const run = store.enqueue(project.id);
    const [job] = store.claim()!.items;
    store.saveResult(job.id, { status: 'ok', httpCode: 200, durationMs: 2, finalUrl: input, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null });
    store.finish(run.id);
    store.deleteUrls(project.id, [address.id]);

    const path = `/api/projects/${project.id}/urls/${address.id}/restore`;
    const response = await app.inject({ method: 'POST', url: path });
    expect(response.statusCode).toBe(200);
    expect(store.addresses(project.id)[0]).toMatchObject({ id: address.id, label: 'Название', latest: { httpCode: 200 } });
    expect(store.project(project.id).urlCount).toBe(1);
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(200);
    expect(store.project(project.id).urlCount).toBe(1);

    store.deleteUrls(project.id, [address.id]);
    expect(store.addUrls(project.id, [{ input, line: 1 }]).added).toBe(1);
    expect(store.addresses(project.id)[0]).toMatchObject({ id: address.id, label: 'Название', latest: { httpCode: 200 } });
    expect(store.history(address.id)).toHaveLength(1);

    store.deleteUrls(project.id, [address.id]);
    const catalogRun = store.enqueueCatalog(project.id, [input]);
    expect(store.runResults(catalogRun.id)[0].urlId).toBe(address.id);
    expect(store.addresses(project.id)).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(200);
  } finally { await app.close(); store.close(); }
});

test('restores an archived worklist row alongside legacy catalog-only duplicates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-legacy-url-'));
  const file = join(directory, 'pulse.sqlite');
  const store = new Store(file);
  const db = new DatabaseSync(file);
  try {
    const project = store.createProject('Старая база', '');
    const input = 'https://example.test/legacy';
    store.addUrls(project.id, [{ input, line: 1 }], 'Старый адрес');
    const [address] = store.addresses(project.id);
    store.deleteUrls(project.id, [address.id]);
    const duplicate = Number(db.prepare('INSERT INTO urls(project_id,url,label,worklist) VALUES (?,?,?,1)')
      .run(project.id, input, 'Дубль').lastInsertRowid);
    expect(() => store.restoreUrl(project.id, address.id)).toThrow('Этот URL уже есть в проекте.');
    db.prepare('UPDATE urls SET worklist=0 WHERE id=?').run(duplicate);

    expect(store.restoreUrl(project.id, address.id).id).toBe(address.id);
    expect(store.address(project.id, duplicate).removedAt).toEqual(expect.any(String));
    expect(store.project(project.id).urlCount).toBe(1);

    store.deleteUrls(project.id, [address.id]);
    db.prepare('UPDATE urls SET removed_at=NULL WHERE id=?').run(duplicate);
    expect(store.addUrls(project.id, [{ input, line: 1 }]).added).toBe(1);
    expect(store.addresses(project.id)[0]).toMatchObject({ id: address.id, label: 'Старый адрес' });
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
