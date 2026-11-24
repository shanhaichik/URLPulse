import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { defaultFilters } from '../src/shared/addresses.js';
import { databaseBusy, DatabaseTasks } from '../src/server/database-tasks.js';
import { Store } from '../src/server/store.js';

async function fixture(run: (store: Store, tasks: DatabaseTasks, file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-database-tasks-'));
  const file = join(directory, 'pulse.sqlite3');
  const store = new Store(file);
  const tasks = new DatabaseTasks(file);
  try { await run(store, tasks, file); }
  finally {
    try { await tasks.close(); }
    finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test('serializes duplicate enqueues while the read worker serves another project', () => fixture(async (store, tasks) => {
  const first = store.createProject('Первая очередь', '');
  const second = store.createProject('Вторая очередь', '');
  store.addUrls(first.id, [{ input: 'https://sample.test/a', line: 1 }]);
  store.addUrls(second.id, [{ input: 'https://sample.test/b', line: 1 }]);
  const [left, right, other] = await Promise.all([
    tasks.run('enqueue', first.id), tasks.run('enqueue', first.id),
    tasks.run('page', second.id, defaultFilters, 1),
  ]);
  expect(left).toEqual(right);
  expect(other.items).toMatchObject([{ url: 'https://sample.test/b' }]);
  await expect(tasks.run('report', second.id, left.id, {}, 0)).rejects.toMatchObject({ statusCode: 404 });
  expect(await tasks.run('report', first.id, left.id, {}, 0)).toMatchObject({ run: { id: left.id, status: 'queued' } });
}));

test('allows a read during a blocked write and applies the write once the lock is released', () => fixture(async (store, tasks, file) => {
  const project = store.createProject('Параллельное чтение', '');
  store.addUrls(project.id, [{ input: 'https://sample.test/a', line: 1 }]);
  const lock = new DatabaseSync(file);
  lock.exec('BEGIN IMMEDIATE');
  const write = tasks.run('enqueue', project.id);
  try {
    const before = await tasks.run('overview', project.id);
    expect(before.activeRun).toBeNull();
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
    await write.catch(() => undefined);
  }
  const { id } = await write;
  expect(store.run(id, project.id).status).toBe('queued');
}));

test('requeues only unfinished results and rejects operations after the worker lanes close', () => fixture(async (store, tasks) => {
  const project = store.createProject('Возврат в очередь', '');
  store.addUrls(project.id, [{ input: 'https://sample.test/a', line: 1 }, { input: 'https://sample.test/b', line: 2 }]);
  const { id } = await tasks.run('enqueue', project.id);
  const running = await tasks.run('claim', true);
  expect(running?.items).toHaveLength(2);
  const checked = running!.items[0];
  await tasks.run('saveResult', checked.id, {
    status: 'ok', httpCode: 204, durationMs: 1, finalUrl: checked.url, redirects: 0,
    contentType: null, contentLength: null, errorKind: null, error: null,
  }, id);
  await tasks.run('requeue', id);
  const resumed = await tasks.run('claim', true);
  expect(resumed?.items).toEqual([running!.items[1]]);
  expect(store.run(id, project.id).completed).toBe(1);
  await tasks.close();
  await expect(tasks.run('overview', project.id)).rejects.toThrow(/завершает работу/);
  expect(databaseBusy({ errcode: 517 })).toBe(true);
  expect(databaseBusy({ errcode: 6 })).toBe(false);
  expect(databaseBusy(null)).toBe(false);
}));
