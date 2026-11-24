import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import { Catalog } from '../dist/server/catalog/database.js';
import { DatabaseTasks } from '../dist/server/database-tasks.js';
import { Store } from '../dist/server/store.js';

const folder = await mkdtemp(join(tmpdir(), 'pulse-worklist-benchmark-'));
const file = join(folder, 'pulse.sqlite3');
const size = 1_000_000;
const seed = new Store(file);
const project = seed.createProject('Миллион адресов', '').id;
seed.close();
const root = '/api/projects/' + project;
let app;
let tasks;

try {
  const catalog = new Catalog(file);
  const db = new DatabaseSync(file);
  try {
    const job = catalog.create(project, { url: 'https://sitemap-fixture.example/sitemap.xml' });
    assert.equal(catalog.start(job.id), true);
    const doc = catalog.document(job.id);
    db.prepare(`INSERT INTO catalog_urls(import_id,url,domain,path,lastmod,document_id)
      WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i<?)
      SELECT ?,printf('https://sitemap-fixture.example/page/%07d',i),'sitemap-fixture.example',
        printf('/page/%07d',i),NULL,? FROM series`).run(size, job.id, doc.id);
    db.prepare('UPDATE catalog_documents SET records=?,done=1 WHERE id=?').run(size, doc.id);
    catalog.publish(job.id);
  } finally { db.close(); catalog.close(); }

  app = await electron.launch({ args: ['.'], env: { ...process.env, PULSE_DESKTOP_DATA_DIR: folder } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  const transfer = page.getByRole('button', { name: 'Добавить все в «Адреса»' });
  await transfer.waitFor();
  await transfer.click();
  const start = performance.now();
  await page.getByRole('button', { name: 'Перенести адреса', exact: true }).click();
  const measured = await page.evaluate(async root => {
    const get = async path => {
      const response = await window.pulseDesktop.request({ method: 'GET', path: root + path });
      if (response.status !== 200) throw new Error(JSON.stringify(response));
      return response.data;
    };
    const samples = [];
    const end = performance.now() + 120_000;
    let bytes = 0;
    while (performance.now() < end) {
      const { transfer } = await get('/catalog');
      if (transfer?.state === 'failed') throw new Error(transfer.error);
      if (transfer?.state === 'done') return { transfer, samples, bytes };
      if (transfer?.state === 'running') {
        const before = performance.now();
        const view = await get('/urls/page');
        samples.push(performance.now() - before);
        if (view.items.length > 25) throw new Error('Too many rows returned for the address page');
        bytes = JSON.stringify(view).length;
      }
      await new Promise(resolve => setTimeout(resolve, 45));
    }
    throw new Error('Transfer exceeded the benchmark time limit');
  }, root);
  assert.equal(measured.transfer.added, size);
  assert.equal(measured.transfer.existing, 0);
  assert.ok(measured.samples.length >= 20, 'The benchmark needs at least 20 measurements during transfer');
  const elapsed = Math.round(performance.now() - start);
  const sorted = measured.samples.sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 <= 250, 'p95 page latency exceeded 250ms: ' + p95);
  console.log(JSON.stringify({ transferred: size, elapsed, p95, samples: sorted.length, pageBytes: measured.bytes }));

  await page.getByRole('button', { name: 'Открыть «Адреса»' }).click();
  await page.getByRole('button', { name: 'https://sitemap-fixture.example/page/0000001', exact: true }).waitFor();
  assert.equal(await page.locator('.address-table tbody tr').count(), 25);
  await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
  await page.getByRole('button', { name: 'https://sitemap-fixture.example/page/0000026', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('/1000000');
  await page.getByRole('button', { name: 'https://sitemap-fixture.example/page/1000000', exact: true }).waitFor();
  assert.equal(await page.locator('.address-table tbody tr').count(), 1);
  await app.close();
  app = undefined;

  // Validate the queued snapshot with the application closed to keep the fixture offline.
  tasks = new DatabaseTasks(file);
  const queuedAt = performance.now();
  const run = await tasks.run('enqueue', project);
  const store = new Store(file);
  try {
    assert.equal(store.run(run.id, project).total, size);
    const claimed = store.claim();
    assert.equal(claimed.id, run.id);
    assert.equal(claimed.items.length, 256);
    console.log(JSON.stringify({ queued: size, elapsed: Math.round(performance.now() - queuedAt), batch: claimed.items.length }));
  } finally { store.close(); }
} finally {
  await tasks?.close();
  await app?.close();
  await rm(folder, { recursive: true, force: true });
}
