import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, _electron as electron } from 'playwright';
import { createApp } from '../dist/server/app.js';
import { DatabaseTasks } from '../dist/server/database-tasks.js';
import { Store } from '../dist/server/store.js';

const dir = await mkdtemp(join(tmpdir(), 'audit-current-'));
const dbFile = join(dir, 'pulse.sqlite3');
const store = new Store(dbFile);
const tasks = new DatabaseTasks(dbFile);
const p = store.createProject('Скорость', '').id;
const root = '/api/projects/' + p;
const desktopBinary = process.env.PULSE_BENCHMARK_DESKTOP;
const app = createApp({ store, tasks, staticRoot: resolve('dist/client') });
const labels = ['?view=summary', '/urls/page', '/urls/page?page=2', '/urls/page?q=featured',
  '/urls/page?sort=durationMs&direction=desc'];
let browser, instance;
function dist(values) {
  const sorted = [...values].sort((a,b) => a-b);
  const at = q => +sorted[Math.ceil(q*sorted.length)-1].toFixed(2);
  return { rounds: sorted.length, p50: at(.5), p95: at(.95) };
}
async function measure(fn, n = 20) {
  const times = [];
  let last;
  for (let i = -3; i < n; i++) {
    const start = performance.now();
    last = await fn(i + 3);
    if (i >= 0) times.push(performance.now() - start);
  }
  return { ...dist(times), ...(last ?? {}) };
}
try {
  for (let i = 0; i < 5000; i += 1000) store.addUrls(p, Array.from({ length: 1000 }, (_, j) => {
    const n = i+j;
    return { input: 'https://speed-fixture.example/' + String(n).padStart(4,'0') + '/' +
      (n%23 === 0 ? 'featured' : 'detail'), line: n + 1 };
  }), 'Рабочий каталог');
  const db = new DatabaseSync(dbFile);
  let recent;
  try {
    for (let k = 0; k < 3; k++) {
      recent = store.enqueue(p).id;
      assert.equal(store.claim().id, recent);
      db.prepare(`UPDATE results SET status=CASE WHEN (id+?)%9=0 THEN 'error' ELSE 'ok' END,
        http_code=CASE WHEN (id+?)%9=0 THEN 503 ELSE 200 END,
        duration_ms=id%1350, final_url=url, content_type='text/html', content_length='900',
        checked_at=? WHERE run_id=?`).run(k,k,new Date().toISOString(),recent);
      db.prepare(`UPDATE runs SET completed=total, failures=(SELECT count(*) FROM results WHERE run_id=? AND status='error')
        WHERE id=?`).run(recent,recent);
      db.prepare('UPDATE runs SET available=total-failures WHERE id=?').run(recent);
      store.finish(recent,false);
    }
  } finally { db.close(); }
  const report = '/runs/' + recent;
  if (!desktopBinary) {
    const api = {};
    for (const path of [...labels, report, report + '?q=featured&status=error&httpCode=503',
      report + '/export?format=csv&q=featured&status=error', report + '/export?format=csv']) {
      api[path] = await measure(async () => {
        const result = await app.inject(root + path);
        assert.equal(result.statusCode,200);
        return { bytes: Buffer.byteLength(result.body) };
      }, (path.includes('/export') ? 12 : 20));
    }
    console.log(JSON.stringify({ direct: api }));
  }
  const base = desktopBinary ? 'pulse-app://app' : await app.listen({ host: '127.0.0.1', port: 0 });
  let page;
  if (desktopBinary) {
    instance = await electron.launch({ executablePath: resolve(desktopBinary),
      env: { ...process.env, PULSE_DESKTOP_DATA_DIR: dir } });
    page = await instance.firstWindow();
  } else {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: {width:1280,height:820} });
  }
  page.setDefaultTimeout(9500);
  await page.addInitScript(() => {
    window.auditLongs = [];
    try { new PerformanceObserver(x => window.auditLongs.push(...x.getEntries().map(e => e.duration)))
      .observe({ type: 'longtask', buffered: true }); } catch {}
  });
  const nav = suffix => desktopBinary
    ? instance.evaluate(({ BrowserWindow }, path) => BrowserWindow.getAllWindows()[0].loadURL(path), base+suffix)
    : page.goto(base+suffix, {waitUntil:'domcontentloaded'});
  const project = '/?project=' + p;
  const reportLink = project + '&run=' + recent;
  const addresses = page.locator('.address-table tbody tr');
  const items = page.locator('dialog .result');
  const search = page.getByRole('searchbox', {name:'Поиск по адресам'});
  const timings = {};
  timings.project = await measure(async () => { await nav(project); await addresses.nth(24).waitFor(); }, 12);
  assert.equal(await addresses.count(), 25);
  const projectLong = await page.evaluate(() => ({ count:window.auditLongs.length, max:Math.max(0,...window.auditLongs) }));
  timings.search = await measure(async i => {
    const term = i % 2 === 0 ? 'featured' : 'detail';
    await search.fill(term);
    await page.locator('.address-table tbody .url-link').first().filter({hasText:new RegExp('/'+term+'$')}).waitFor();
  }, 16);
  await search.fill('');
  await page.getByText('1 / 200', {exact:true}).waitFor();
  const sort = page.getByRole('button', {name:'Ответ',exact:true});
  const firstAddress = addresses.first().locator('.url-link');
  const firstFor = async (direction, page = 1) => {
    const result = await app.inject(`${root}/urls/page?sort=durationMs&direction=${direction}&page=${page}`);
    assert.equal(result.statusCode, 200);
    return result.json().items[0].url;
  };
  const [low, high] = await Promise.all([firstFor('asc'), firstFor('desc')]);
  assert.notEqual(low, high);
  let asc = true;
  timings.sort = await measure(async () => {
    await sort.click();
    await firstAddress.filter({ hasText: asc ? low : high }).waitFor();
    asc = !asc;
  }, 16);
  const firstPage = asc ? high : low;
  const secondPage = await firstFor(asc ? 'desc' : 'asc', 2);
  assert.notEqual(firstPage, secondPage);
  let next = true;
  timings.addressPage = await measure(async () => {
    await page.getByRole('button',{name: (next ? 'Следующая' : 'Предыдущая') + ' страница'}).click();
    await page.getByText((next ? '2' : '1') + ' / 200', { exact: true }).waitFor();
    await firstAddress.filter({ hasText: next ? secondPage : firstPage }).waitFor();
    next = !next;
  }, 16);
  const addressRows = await addresses.count();
  const addressLong = await page.evaluate(() => ({ count:window.auditLongs.length, max:Math.max(0,...window.auditLongs) }));
  timings.report = await measure(async () => { await nav(reportLink); await items.nth(99).waitFor(); }, 12);
  assert.equal(await items.count(), 100);
  const reportRows = await items.count();
  let forward = true;
  timings.reportPage = await measure(async () => {
    await page.getByRole('button',{name:forward?'Далее':'Назад',exact:true}).click();
    await page.getByText('Страница '+(forward?2:1),{exact:true}).waitFor();
    await items.nth(99).waitFor();
    forward = !forward;
  }, 16);
  const dialog = page.getByRole('dialog');
  const field = dialog.getByRole('searchbox',{name:'URL или название'});
  timings.reportFilter = await measure(async i => {
    const match = i % 2 === 0 ? 'featured' : 'detail';
    await field.fill(match);
    await dialog.getByRole('button',{name:'Найти',exact:true}).click();
    await dialog.locator('.result-name strong').first().filter({hasText:new RegExp('/'+match+'$')}).waitFor();
  }, 16);
  const long = await page.evaluate(() => ({ count:window.auditLongs.length, max:Math.max(0,...window.auditLongs),
    heap:performance.memory?.usedJSHeapSize }));
  const transport = {};
  const revision = await page.evaluate(async path => window.pulseDesktop
    ? (await window.pulseDesktop.request({ method: 'GET', path })).data.revision
    : (await (await fetch(path)).json()).revision, root + '?view=summary');
  for (const query of [...labels, '?view=summary&since=' + revision, report,
      report + '?q=featured&status=error&httpCode=503']) {
    const read = () => page.evaluate(async path => {
      if (window.pulseDesktop) {
        const result = await window.pulseDesktop.request({ method: 'GET', path });
        if (result.status !== 200) throw new Error('IPC ' + result.status + ' ' + path);
        return { bytes: new TextEncoder().encode(JSON.stringify(result.data)).byteLength };
      }
      const result = await fetch(path);
      if (!result.ok) throw new Error('HTTP ' + result.status + ' ' + path);
      const size = (await result.arrayBuffer()).byteLength;
      return { bytes: size };
    }, root + query);
    const label = query.includes('&since=') ? '?view=summary (unchanged)' : query;
    transport[label] = await measure(read);
  }
  console.log(JSON.stringify({ mode: desktopBinary?'desktop':'chromium', urls:5000, results:15000, timings, transport,
    addressRows, reportRows, projectLong, addressLong, reportLong: long, rss: process.memoryUsage().rss }));
} finally {
  await instance?.close(); await browser?.close(); await app.close(); await tasks.close(); store.close();
  await rm(dir,{recursive:true,force:true});
}
