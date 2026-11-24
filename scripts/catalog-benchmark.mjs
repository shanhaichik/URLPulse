import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { createGzip } from 'node:zlib';
import { _electron as electron } from 'playwright';
import { Catalog } from '../dist/server/catalog/database.js';
import { runImport } from '../dist/server/catalog/importer.js';
import { Store } from '../dist/server/store.js';

const directory = await mkdtemp(join(tmpdir(), 'pulse-catalog-bench-'));
const file = join(directory, 'pulse.sqlite3');
const gzipFile = join(directory, 'oversized.xml.gz');
const millionFile = join(directory, 'million.xml.gz');
const fixtureCount = 500_001;
const largestCount = 1_000_000;
const rangeSize = 50_000;
const domain = 'sitemap-fixture.example';
const folders = ['articles', 'catalog', 'support', 'help', 'news'];
const url = index => `https://${domain}/${folders[index % folders.length]}/${String(index).padStart(7, '0')}`;

function rows(start, end) {
  return Readable.from((function* () {
    yield '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    for (let offset = start; offset < end; offset += 500) {
      let chunk = '';
      for (let index = offset; index < Math.min(offset + 500, end); index++) {
        chunk += '<url><loc>' + url(index) + '</loc><lastmod>2026-11-18</lastmod></url>';
      }
      yield chunk;
    }
    yield '</urlset>';
  })(), { objectMode: false });
}

function index(files) {
  return Readable.from(['<sitemapindex>' + files.map(file => `<sitemap><loc>https://${domain}/${file}</loc></sitemap>`).join('') + '</sitemapindex>']);
}

function latest(catalog, project, id, expected) {
  const job = catalog.job(project, id);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.uniqueUrls, expected);
  return job;
}

function timing(name, start, data) {
  console.log(JSON.stringify({ name, milliseconds: Math.round(performance.now() - start), ...data }));
}

async function seed() {
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    await Promise.all([
      pipeline(rows(0, fixtureCount), createGzip(), createWriteStream(gzipFile)),
      pipeline(rows(0, largestCount), createGzip(), createWriteStream(millionFile)),
    ]);
    const nested = store.createProject('Вложенный индекс', '').id;
    const job = catalog.create(nested, { url: `https://${domain}/index.xml` });
    let start = performance.now();
    await runImport(catalog, job.id, { open: async document => {
      const file = new URL(document.location).pathname.slice(1);
      if (file === 'index.xml') return index(['child.xml', 'part-10.xml.gz']);
      if (file === 'child.xml') return index(Array.from({ length: 10 }, (_, index) => `part-${index}.xml.gz`));
      const position = Number(/part-(\d+)/.exec(file)[1]) * rangeSize;
      return rows(position, Math.min(position + rangeSize, fixtureCount)).pipe(createGzip());
    } });
    timing('nested index with 500001 URLs', start, { documents: latest(catalog, nested, job.id, fixtureCount).documentsDone });

    const project = store.createProject('Каталог 1 млн URL', '').id;
    const large = catalog.create(project, { fileName: 'oversized.xml.gz' });
    start = performance.now();
    catalog.uploaded(project, large.id);
    await runImport(catalog, large.id, { file: gzipFile });
    assert.equal(latest(catalog, project, large.id, fixtureCount).warning, true);
    timing('one oversized gzip with 500001 URLs', start);

    const full = catalog.create(project, { fileName: 'million.xml.gz', sourceId: large.sourceId });
    catalog.uploaded(project, full.id);
    start = performance.now();
    await runImport(catalog, full.id, { file: millionFile });
    latest(catalog, project, full.id, largestCount);
    assert.equal(catalog.sources(project)[0].added, largestCount - fixtureCount);
    timing('one oversized gzip with 1000000 URLs and comparison', start);
    return { project, sourceId: large.sourceId, full: full.id };
  } finally {
    catalog.close();
    store.close();
  }
}

let app;
try {
  const { project, sourceId, full } = await seed();
  app = await electron.launch({ args: ['.'], env: { ...process.env, PULSE_DESKTOP_DATA_DIR: directory } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: /Каталог 1 млн URL/ }).click();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByRole('cell', { name: url(0), exact: true }).waitFor();
  const path = `/api/projects/${project}/catalog`;
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, gzipFile);
  await page.getByRole('button', { name: 'Загрузить новую версию' }).click();
  const start = performance.now();
  const results = await page.evaluate(async ({ path, sourceId, full, domain }) => {
    const samples = [];
    let size = 0;
    let running = 0;
    const send = path => window.pulseDesktop.request({ method: 'GET', path });
    for (let index = 0; index < 50; index++) {
      const overview = await send(path);
      if (overview.data.jobs[0].state === 'running') {
        const before = performance.now();
        const response = await send(path + '/page?' + new URLSearchParams({
          sourceId: String(sourceId), revision: String(full), domain, prefix: '/catalog/',
        }));
        if (response.status !== 200 || response.data.items.length !== 100) throw new Error(JSON.stringify(response));
        samples.push(performance.now() - before);
        size = JSON.stringify(response.data).length;
        running++;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return { samples, size, running };
  }, { path, sourceId, full, domain });
  assert.ok(results.running >= 20, 'Expected at least 20 measurements during an active import');
  const sorted = results.samples.sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * .95) - 1];
  assert.ok(p95 <= 250, `p95 exceeds 250 ms: ${p95}`);
  timing('Electron renderer to IPC: indexed first page during import', start,
    { samples: results.running, p95: Number(p95.toFixed(1)), pageBytes: results.size });
  const clickStart = performance.now();
  await page.getByLabel('Домен', { exact: true }).fill(domain);
  await page.getByLabel('Начало пути', { exact: true }).fill('/catalog/');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByRole('cell', { name: url(1), exact: true }).waitFor();
  timing('Electron: applied filter to visible first page', clickStart);
  await page.getByRole('cell', { name: url(1), exact: true }).waitFor();
  const records = await page.locator('.catalog-table tbody tr').count();
  assert.equal(records, 100);
  for (let iteration = 0; iteration < 300; iteration++) {
    const state = await page.evaluate(async path => (await window.pulseDesktop.request({ path, method: 'GET' })).data.jobs[0], path);
    if (state.state === 'failed') throw new Error(state.error);
    if (state.state === 'done') {
      assert.equal(state.uniqueUrls, fixtureCount);
      timing('Electron background refresh with 500001 URLs', start);
      break;
    }
    if (iteration === 299) throw new Error('The desktop import did not complete in time.');
    await setTimeout(200);
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
