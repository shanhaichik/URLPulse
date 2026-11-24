import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { CatalogService } from '../dist/server/catalog/service.js';
import { Store } from '../dist/server/store.js';

const directory = await mkdtemp(join(tmpdir(), 'pulse-catalog-export-'));
const file = join(directory, 'pulse.sqlite3');
const store = new Store(file);
const catalog = new CatalogService(file);
const db = new DatabaseSync(file);
const app = createApp({ store, catalog });
const readers = [];

async function pauseDownload(url, body) {
  const req = request(url, { agent: false, method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} });
  const response = once(req, 'response');
  req.end(body);
  const [stream] = await response;
  assert.equal(stream.statusCode, 200);
  stream.on('error', () => {});
  stream.pause();
  readers.push(stream);
  return stream;
}

function checkpoint() { return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy; }

try {
  const { id: project } = store.createProject('Выгрузка каталога', '');
  const job = catalog.db.create(project, { url: 'https://example.test/index.xml' });
  const total = 100_000;
  db.exec('BEGIN IMMEDIATE');
  const document = db.prepare("INSERT INTO catalog_documents(import_id,location,done,records) VALUES (?,'fixture',1,?)")
    .run(job.id, total).lastInsertRowid;
  db.prepare(`INSERT INTO catalog_urls(import_id,url,domain,path,document_id)
    WITH RECURSIVE fixture(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM fixture WHERE i<?)
    SELECT ?,printf('https://example.test/%07d',i)||CASE WHEN i<=5000 THEN ? ELSE ? END,
      'example.test',printf('/%07d',i),? FROM fixture`).run(total, job.id, 'x'.repeat(1_400), 'x'.repeat(95), document);
  db.prepare("UPDATE catalog_imports SET state='done' WHERE id=?").run(job.id);
  db.prepare('UPDATE catalog_sources SET current_id=?,count=? WHERE id=?').run(job.id, total, job.sourceId);
  db.exec('COMMIT');
  assert.equal(checkpoint(), 0);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = `/api/projects/${project}/catalog/export`;
  const url = origin + path;
  const selected = db.prepare('SELECT url FROM catalog_urls WHERE import_id=? ORDER BY url LIMIT 5000')
    .all(job.id).map(row => row.url);
  const ordinary = await app.inject({ method: 'POST', url: path,
    payload: { sourceId: job.sourceId, revision: job.id, selected: selected.slice(0, 2) } });
  assert.equal(ordinary.statusCode, 200);
  assert.equal(ordinary.body.trimEnd().split('\r\n').length, 3);

  const disconnected = await pauseDownload(url + '?sourceId=' + job.sourceId);
  store.editProject(project, 'После начала экспорта');
  assert.equal(checkpoint(), 1, 'The snapshot pins the WAL while the reader is paused.');
  disconnected.destroy();
  for (let attempt = 0; attempt < 30 && checkpoint(); attempt++) await setTimeout(15);
  assert.equal(checkpoint(), 0);

  await pauseDownload(url + '?sourceId=' + job.sourceId);
  await pauseDownload(url, JSON.stringify({ sourceId: job.sourceId, revision: job.id, selected }));
  store.editProject(project, 'Перед остановкой');
  assert.equal(checkpoint(), 1);
  const start = performance.now();
  await Promise.race([app.close(), setTimeout(500, null, { ref: false }).then(() => {
    throw new Error('Server waits for stalled catalog CSV downloads.');
  })]);
  assert.equal(checkpoint(), 0);
  console.log(JSON.stringify({ catalogRows: total, selectedRows: selected.length, shutdownMs: performance.now() - start,
    releasedSnapshot: true }));
} finally {
  for (const stream of readers) stream.destroy();
  await app.close();
  await catalog.close();
  db.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
