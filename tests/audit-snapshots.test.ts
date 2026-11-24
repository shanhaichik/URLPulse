import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { CatalogSource } from '../src/shared/catalog.js';
import { createApp } from '../src/server/app.js';
import { Catalog } from '../src/server/catalog/database.js';
import { runImport } from '../src/server/catalog/importer.js';
import { databaseBusy, DatabaseTasks } from '../src/server/database-tasks.js';
import { Store } from '../src/server/store.js';

async function fixture(run: (file: string) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-audit-snapshot-'));
  try { await run(join(directory, 'pulse.sqlite3')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('saving the same calendar schedule cannot put a processed slot back on the queue', () => fixture(file => {
  let now = Date.parse('2026-11-24T09:59:59Z');
  const store = new Store(file, () => now);
  const scheduler = new Store(file, () => now, false, false);
  scheduler['db'].exec('PRAGMA busy_timeout=0');
  try {
    const { id } = store.createProject('Расписание', '');
    store.addUrls(id, [{ input: 'https://sample.test/one', line: 1 }]);
    const schedule = { weekdays: [1, 2, 3, 4, 5, 6, 7], time: '10:00', timezone: 'UTC' };
    const settings = { schedule, notify: 'off' as const, email: null };
    store.saveSettings(id, settings);
    now = Date.parse('2026-11-24T10:00:00Z');

    const readProject = store.project.bind(store);
    const read = vi.spyOn(store, 'project').mockImplementationOnce(projectId => {
      const project = readProject(projectId);
      try {
        scheduler.enqueueDue();
        expect(scheduler.claim()?.source).toBe('schedule');
      } catch (error) {
        if (!databaseBusy(error)) throw error;
      }
      return project;
    });
    store.saveSettings(id, { ...settings, notify: 'errors' });
    read.mockRestore();
    scheduler.enqueueDue();
    scheduler.claim();
    scheduler.enqueueDue();

    expect(store.runs(id)).toMatchObject([{ source: 'schedule', status: 'running' }]);
    expect(store.project(id)).toMatchObject({ notify: 'errors', nextAt: '2026-11-25T10:00:00.000Z' });
    expect(store.saveSettings(id, { ...settings, schedule: { ...schedule, time: '10:05' } }).nextAt)
      .toBe('2026-11-24T10:05:00.000Z');
  } finally { scheduler.close(); store.close(); }
}));

test('catalog page reads version metadata and URLs from the same snapshot during deletion', () => fixture(async file => {
  const store = new Store(file);
  const reader = new Catalog(file);
  const writer = new Catalog(file);
  try {
    const { id } = store.createProject('Каталог', '');
    const job = reader.create(id, { url: 'https://sample.test/sitemap.xml' });
    const xml = '<urlset><url><loc>https://sample.test/one</loc></url></urlset>';
    await runImport(reader, job.id, { open: async () => Readable.from([Buffer.from(xml)]) });

    const catalog = reader as unknown as { source(projectId: number, sourceId: number): CatalogSource };
    const source = catalog.source.bind(catalog);
    const read = vi.spyOn(catalog, 'source').mockImplementationOnce((projectId, sourceId) => {
      const current = source(projectId, sourceId);
      writer.deleteSource(projectId, sourceId);
      return current;
    });
    const filter = { sourceId: job.sourceId, revision: job.id };
    expect(reader.page(id, filter)).toMatchObject({
      revision: job.id, items: [{ url: 'https://sample.test/one' }], next: null,
    });
    read.mockRestore();
    expect(() => reader.page(id, filter)).toThrow('Источник sitemap не найден.');
  } finally { writer.close(); reader.close(); store.close(); }
}));

test.each(['summary', 'table', 'default'])('project responses label the %s snapshot and can be polled conditionally', view => fixture(async file => {
  const store = new Store(file);
  const writer = new Store(file, Date.now, false, false);
  const tasks = new DatabaseTasks(file);
  const app = createApp({ store, tasks });
  try {
    const { id } = store.createProject('Проект до записи', '');
    const revision = store.revision.bind(store);
    const before = revision(id);
    vi.spyOn(store, 'revision').mockImplementationOnce(projectId => {
      const previous = revision(projectId);
      writer.editProject(projectId, 'Название из нового снимка');
      return previous;
    });

    const path = `/api/projects/${id}?view=${view}`;
    const response = await app.inject(path);
    const latest = revision(id);
    expect(response.statusCode).toBe(200);
    expect(latest).not.toBe(before);
    expect(response.json()).toMatchObject({ revision: latest, project: { name: 'Название из нового снимка' } });
    const runTask = vi.spyOn(tasks, 'run');
    const unchanged = await app.inject(path + '&since=' + encodeURIComponent(latest));
    expect(unchanged.json()).toEqual({ unchanged: true });
    expect(runTask).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await tasks.close();
    writer.close();
    store.close();
  }
}));
