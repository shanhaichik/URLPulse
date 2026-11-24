import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../dist/server/app.js';
import { DatabaseTasks } from '../dist/server/database-tasks.js';
import { Store } from '../dist/server/store.js';

const count = 100_000;
const directory = await mkdtemp(join(tmpdir(), 'pulse-run-comparison-'));
const file = join(directory, 'pulse.sqlite3');
const store = new Store(file);
const tasks = new DatabaseTasks(file);
const app = createApp({ store, tasks, staticRoot: resolve('dist/client') });
let browser;

function seed(projectId) {
  const database = new DatabaseSync(file);
  try {
    database.exec('BEGIN IMMEDIATE');
    const insert = database.prepare('INSERT INTO urls(project_id,url,label) VALUES (?,?,?)');
    for (let i = 1; i <= count; i++) {
      const section = i % 25 ? 'regular' : 'featured';
      insert.run(projectId, `https://comparison.example/${section}/${i}`, 'Синтетический адрес');
    }
    database.prepare('UPDATE projects SET url_count=? WHERE id=?').run(count, projectId);
    database.exec('COMMIT');
    return [false, true].map(changed => {
      const { id } = store.enqueue(projectId);
      assert.equal(store.claim().id, id);
      const failures = changed ? count / 10 : 0;
      database.prepare(`UPDATE results SET
        status=CASE WHEN ?=1 AND url_id%10=0 THEN 'error' ELSE 'ok' END,
        http_code=CASE WHEN ?=1 AND url_id%10=0 THEN 503 ELSE 200 END,
        error_kind=CASE WHEN ?=1 AND url_id%10=0 THEN 'http' END,
        duration_ms=CASE WHEN ?=1 AND url_id%10=1 THEN 450 ELSE 100 END,
        checked_at=?, final_url=url WHERE run_id=?`)
        .run(+changed, +changed, +changed, +changed, new Date().toISOString(), id);
      database.prepare('UPDATE runs SET completed=total,available=total-?,failures=? WHERE id=?')
        .run(failures, failures, id);
      store.finish(id, false);
      return id;
    });
  } finally {
    database.close();
  }
}

const ms = value => Math.round(value * 10) / 10;
async function measure(url, verify) {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const started = performance.now();
    const response = await fetch(url);
    assert.equal(response.status, 200);
    verify(await response.json());
    if (i >= 2) samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { samples: samples.length, p50Ms: ms(samples[4]), p95Ms: ms(samples[9]) };
}

try {
  const project = store.createProject('Большое сравнение', '').id;
  const [baseline, target] = seed(project);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const root = `${origin}/api/projects/${project}`;
  const pair = `baseline=${baseline}&target=${target}`;
  const comparison = `${root}/run-comparison?${pair}`;
  const firstPage = await measure(`${comparison}&kind=all`, page => {
    assert.equal(page.items.length, 100);
    assert.equal(page.items[0].urlId, 1);
    assert.equal(page.nextAfter, 100);
  });
  const deepPage = await measure(`${comparison}&kind=all&after=99000`, page => {
    assert.equal(page.items.length, 100);
    assert.equal(page.items[0].urlId, 99001);
    assert.equal(page.nextAfter, 99100);
  });
  const filter = await measure(`${comparison}&kind=regression&q=featured`, page => {
    assert.equal(page.items.length, 100);
    assert.ok(page.items.every(row => row.urlId % 50 === 0 && row.flags.includes('regression')));
  });
  const summary = await measure(comparison + '&view=summary', data => {
    assert.equal(data.total, count);
    assert.equal(data.differences, count / 5);
    for (const key of ['regression', 'httpChanged', 'slower']) assert.equal(data.counts[key], count / 10);
  });

  browser = await chromium.launch({ channel: process.env.PULSE_E2E_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.auditLongTasks = [];
    new PerformanceObserver(entries => {
      window.auditLongTasks.push(...entries.getEntries().map(entry => entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  const openedAt = performance.now();
  await page.goto(`${origin}/?project=${project}&tab=runs&compare=1&${pair}`);
  const panel = page.getByRole('dialog', { name: 'Сравнение прогонов', exact: true });
  const rows = panel.locator('.comparison-row');
  await expect(rows).toHaveCount(100);
  await expect(rows.first()).toContainText('https://comparison.example/regular/1');
  const openMs = ms(performance.now() - openedAt);
  const next = panel.getByRole('button', { name: 'Далее', exact: true });
  await next.scrollIntoViewIfNeeded();
  await next.evaluate(element => {
    const dialog = element.closest('dialog');
    if (!dialog) throw new Error('Не найдено окно сравнения.');
    element.addEventListener('click', () => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        if (dialog.querySelector('.comparison-row')?.textContent.includes('/regular/501')) {
          window.auditPageTurnMs = performance.now() - started;
          observer.disconnect();
        }
      });
      observer.observe(dialog, { childList: true, subtree: true });
    }, { once: true });
  });
  await next.click();
  await expect(rows.first()).toContainText('https://comparison.example/regular/501');
  await expect(rows).toHaveCount(100);
  const pageTurn = await page.evaluate(() => window.auditPageTurnMs);
  assert.ok(Number.isFinite(pageTurn));
  const nextMs = ms(pageTurn);
  const longTasks = await page.evaluate(() => window.auditLongTasks);

  const started = performance.now();
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  try {
    const response = await fetch(`${root}/run-comparison/export?${pair}&kind=all&format=csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/csv/);
    const reader = response.body.getReader();
    let bytes = 0;
    let lines = 0;
    const accumulate = chunk => {
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
    };
    const first = await reader.read();
    assert.equal(first.done, false);
    accumulate(first.value);
    const firstChunkMs = ms(performance.now() - started);
    assert.equal((await fetch(`${root}/runs/${baseline}`, { method: 'DELETE' })).status, 200);
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      accumulate(part.value);
    }
    assert.equal(lines, count + 1);
    assert.equal((await fetch(comparison)).status, 404);
    console.log(JSON.stringify({
      platform: `${process.platform}/${process.arch}`, node: process.version, chromium: browser.version(), rowsPerRun: count,
      api: { firstPage, deepPage, filter, summary },
      ui: { openMs, nextMs, longTasksMs: longTasks.map(ms) },
      export: { rows: lines - 1, bytes, firstChunkMs, elapsedMs: ms(performance.now() - started),
        peakRssMiB: Math.round(peakRss / (1024 * 1024)), survivesDeletion: true },
    }, null, 2));
  } finally {
    clearInterval(rssTimer);
  }
} finally {
  await browser?.close();
  await app.close();
  await tasks.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
