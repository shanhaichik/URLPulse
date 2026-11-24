import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { CatalogService } from '../src/server/catalog/service.js';
import { Store } from '../src/server/store.js';

function seedPublishedSource(db: DatabaseSync, projectId: number, urlsPerVersion: number) {
  const sourceId = Number(db.prepare('INSERT INTO catalog_sources(project_id,name) VALUES (?,?)')
    .run(projectId, 'fixture.xml').lastInsertRowid);
  const addImport = db.prepare(`INSERT INTO catalog_imports(source_id,state,profile,file_name,file_key,created_at)
    VALUES (?,'done','default','fixture.xml',?,'2026-11-19T12:00:00.000Z')`);
  const keys = ['5555', '6666'].map(revision => `11111111-2222-3333-${revision}-${String(sourceId).padStart(12, '0')}`);
  const revisions = keys.map(key => addImport.run(sourceId, key).lastInsertRowid);
  const insertDocument = db.prepare(`INSERT INTO catalog_documents(import_id,location,done,records)
    VALUES (?,'@upload',1,?)`);
  const insertUrls = db.prepare(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<?)
    INSERT INTO catalog_urls(import_id,url,domain,path,document_id)
    SELECT ?, 'https://example.test/'||n, 'example.test', '/'||n, ? FROM entries`);
  db.exec('BEGIN');
  for (const revision of revisions) {
    const document = insertDocument.run(revision, urlsPerVersion).lastInsertRowid;
    insertUrls.run(urlsPerVersion, revision, document);
  }
  db.prepare('UPDATE catalog_sources SET previous_id=?,current_id=?,count=? WHERE id=?')
    .run(...revisions, urlsPerVersion, sourceId);
  db.exec('COMMIT');
  return { sourceId, keys };
}

test('clears all sources off the main thread, stops catalog operations and preserves project addresses and reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-catalog-clear-'));
  const file = join(directory, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new CatalogService(file);
  const db = new DatabaseSync(file);
  const app = createApp({ store, catalog });
  const stream = new PassThrough();
  try {
    const { id } = store.createProject('Каталог для очистки', '');
    const other = store.createProject('Другой каталог', '');
    const first = seedPublishedSource(db, id, 25_000);
    const second = seedPublishedSource(db, id, 25_000);
    seedPublishedSource(db, other.id, 1);
    const transfer = catalog.db.transfers.enqueue(id);
    const otherTransfer = catalog.db.transfers.enqueue(other.id);
    expect(catalog.db.transfers.batch(transfer.id, 1)).toBe(true);
    expect(catalog.db.transfers.batch(otherTransfer.id, 1)).toBe(true);
    const worklist = store.addresses(id);
    const run = store.enqueue(id, [worklist[0].id]);
    expect(worklist).toHaveLength(1);
    const [checked] = store.claim()!.items;
    store.saveResult(checked.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: checked.url,
      redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
    store.finish(run.id);
    const waiting = store.enqueueCatalog(id, ['https://example.test/2']);
    const upload = catalog.db.create(id, { fileName: 'upload.xml' });
    const download = catalog.db.create(id, { url: 'https://example.test/import.xml' });
    catalog.db.start(download.id);
    const key = catalog.db.fileKey(upload.id)!;
    const partial = join(file + '.catalog', key + '.bin.partial');
    const uploading = catalog.upload(id, upload.id, () => stream).catch(error => error);
    stream.write('<urlset>');
    await vi.waitFor(async () => expect((await stat(partial)).isFile()).toBe(true));
    const existing = [...first.keys, ...second.keys].map(key => join(file + '.catalog', key + '.bin'));
    await Promise.all(existing.map(path => writeFile(path, 'file')));

    const path = `/api/projects/${id}/catalog/clear`;
    const response = await app.inject(path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectName: 'Каталог для очистки', sources: 4,
      publishedUrls: 50_000, imports: 6, activeImports: 2, transferActive: true });
    const { confirmation } = response.json();
    const newest = catalog.db.create(id, { fileName: 'new.xml' });
    const clear = (confirmation: string) => app.inject({ method: 'POST', url: path, payload: { confirmation } });
    expect((await clear(confirmation)).statusCode).toBe(409);
    expect(catalog.db.job(id, upload.id).state).toBe('upload');
    expect(catalog.db.transfers.latest(id)?.state).toBe('running');
    const confirmed = (await app.inject(path)).json();
    expect(desktopRequest({ method: 'GET', path }).path).toBe(path);
    expect(desktopRequest({ method: 'POST', path }).path).toBe(path);
    const clearing = clear(confirmed.confirmation);
    const turn = setImmediate().then(() => catalog.db.sources(id).length);
    expect(await Promise.race([clearing.then(() => 'done'), turn])).toBe(5);
    expect((await clearing).json()).toEqual({ deleted: 5 });

    expect(await uploading).toBeInstanceOf(Error);
    expect(stream.destroyed).toBe(true);
    for (const path of [...existing, partial]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(catalog.db.sources(id)).toEqual([]);
    expect(catalog.db.jobs(id)).toEqual([]);
    expect(catalog.db.transfers.latest(id)).toBeUndefined();
    expect(catalog.db.transfers.batch(transfer.id, 512)).toBe(false);
    expect(catalog.db.transfers.latest(other.id)).toMatchObject({ id: otherTransfer.id, state: 'running' });
    expect(catalog.db.sources(other.id)).toHaveLength(1);
    expect(catalog.db.state(newest.id)).toBeUndefined();
    expect(store.addresses(id).map(address => address.id)).toEqual(worklist.map(address => address.id));
    expect(store.runResults(run.id)).toMatchObject([{ httpCode: 200 }]);
    expect(store.run(waiting.id, id).status).toBe('queued');
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_urls').get()?.count).toBe(2);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    stream.destroy();
    await app.close();
    await catalog.close();
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('deletes a large published source without blocking the event loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-source-worker-'));
  const file = join(directory, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new CatalogService(file);
  const db = new DatabaseSync(file);
  try {
    const { id } = store.createProject('Большой каталог', '');
    const { sourceId } = seedPublishedSource(db, id, 50_000);
    const deleting = catalog.deleteSource(id, sourceId);
    const signal = setImmediate().then(() => catalog.db.sources(id).length);
    const observed = await Promise.race([deleting.then(() => 'deleted'), signal]);
    await deleting;
    expect(observed).toBe(1);
    expect(catalog.db.sources(id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_urls').get()?.count).toBe(0);
  } finally {
    await catalog.close();
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves guard and error statuses and removes staged files only after deletion commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-source-guard-'));
  const file = join(directory, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new CatalogService(file);
  const db = new DatabaseSync(file);
  const app = createApp({ store, catalog });
  try {
    const { id } = store.createProject('Защита версии', '');
    const { sourceId, keys } = seedPublishedSource(db, id, 1);
    await mkdir(file + '.catalog');
    const files = keys.map(key => join(file + '.catalog', key + '.bin'));
    await Promise.all(files.map(path => writeFile(path, 'fixture')));
    const transfer = catalog.db.transfers.enqueue(id);
    const remove = () => app.inject({ method: 'DELETE', url: `/api/projects/${id}/catalog/sources/${sourceId}` });
    expect((await remove()).statusCode).toBe(409);
    expect(await Promise.all(files.map(path => stat(path).then(file => file.isFile())))).toEqual([true, true]);
    catalog.db.transfers.stop(id, transfer.id);

    db.exec('BEGIN IMMEDIATE');
    try { expect((await remove()).statusCode).toBe(503); }
    finally { db.exec('ROLLBACK'); }
    expect((await remove()).statusCode).toBe(200);
    for (const path of files) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await remove()).statusCode).toBe(404);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    await app.close();
    await catalog.close();
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('waits for accepted deletions during shutdown and rejects requests after closing begins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-source-close-'));
  const file = join(directory, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new CatalogService(file);
  const db = new DatabaseSync(file);
  try {
    const { id } = store.createProject('Завершение удаления', '');
    const first = seedPublishedSource(db, id, 1);
    const second = seedPublishedSource(db, id, 1);
    const remaining = Promise.all([catalog.deleteSource(id, first.sourceId), catalog.deleteSource(id, second.sourceId)]);
    const closing = catalog.close();
    const closedAgain = catalog.close();
    const observed = await Promise.race([remaining.then(() => 'deleted'), closedAgain.then(() => 'closed')]);
    await Promise.all([remaining, closing, closedAgain]);
    expect(observed).toBe('deleted');
    await expect(catalog.deleteSource(id, second.sourceId)).rejects.toMatchObject({ statusCode: 503 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_sources').get()?.count).toBe(0);
  } finally {
    await catalog.close();
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
