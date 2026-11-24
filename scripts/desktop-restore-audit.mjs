import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright';
import { Catalog } from '../dist/server/catalog/database.js';
import { Store } from '../dist/server/store.js';

const directory = await mkdtemp(join(tmpdir(), 'pulse-restore-audit-'));
const profile = join(directory, 'profile');
const source = join(directory, 'sample.sqlite3');
const catalogRows = 1_000_000;
const historyUrls = 20_000;
const historyRuns = 12;
const stamp = '2040-01-01T10:00:00.000Z';
const requireProgress = !process.argv.includes('--baseline');
let app;
let memoryTimer;

try {
  await mkdir(profile, { mode: 0o700 });
  const store = new Store(source);
  const { id } = store.createProject('Восстановленная синтетическая база', '');
  store.close();
  const catalog = new Catalog(source);
  const db = new DatabaseSync(source);
  try {
    const job = catalog.create(id, { url: 'https://fixture.invalid/sitemap.xml' });
    assert.equal(catalog.start(job.id), true);
    const doc = catalog.document(job.id);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.prepare(`INSERT INTO catalog_urls(import_id,url,domain,path,lastmod,document_id)
      WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i<?)
      SELECT ?,printf('https://fixture.invalid/catalog/%07d',i),'fixture.invalid',printf('/catalog/%07d',i),NULL,? FROM series`)
      .run(catalogRows, job.id, doc.id);
    db.prepare('UPDATE catalog_documents SET records=?,done=1 WHERE id=?').run(catalogRows, doc.id);
    db.prepare(`INSERT INTO urls(id,project_id,url,label)
      WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i<?)
      SELECT i,?,printf('https://fixture.invalid/history/%07d',i),'' FROM series`).run(historyUrls, id);
    db.prepare('UPDATE projects SET url_count=? WHERE id=?').run(historyUrls, id);
    db.prepare('INSERT INTO url_versions(url_id,version,url,created_at) SELECT id,1,url,? FROM urls').run(stamp);
    const addRun = db.prepare(`INSERT INTO runs(id,project_id,source,status,created_at,finished_at,total,completed,available)
      VALUES(?,?,'manual','done',?,?,?,?,?)`);
    const addResults = db.prepare(`INSERT INTO results(run_id,url_id,version,url,label,status,http_code,checked_at)
      SELECT ?,id,1,url,label,'ok',200,? FROM urls`);
    for (let run = 1; run <= historyRuns; run++) {
      addRun.run(run, id, stamp, stamp, historyUrls, historyUrls, historyUrls);
      addResults.run(run, stamp);
    }
    db.exec('COMMIT;');
    catalog.publish(job.id);
  } finally { db.close(); catalog.close(); }
  const backupBytes = (await stat(source)).size;
  const launch = () => electron.launch({ args: ['.'],
    env: { ...process.env, PULSE_DESKTOP_DATA_DIR: profile, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' } });
  app = await launch();
  const page = await app.firstWindow();
  const settings = page.getByRole('banner').getByRole('button', { name: 'Настройки приложения' });
  await settings.click();
  const phasesLog = join(directory, 'phases.jsonl');
  await app.evaluate(({ app, BrowserWindow, dialog }, { file, phasesLog }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    app.relaunch = () => {};
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    const { appendFileSync } = process.getBuiltinModule('node:fs');
    contents.send = (channel, ...args) => {
      if (channel === 'pulse:backup-progress') appendFileSync(phasesLog, JSON.stringify([args[0], performance.now()]) + '\n');
      return send(channel, ...args);
    };
  }, { file: source, phasesLog });

  const rendererSamples = [];
  const ipcSamples = [];
  const phases = [];
  const before = performance.now();
  const pid = app.process().pid;
  let peakRssKiB = 0;
  memoryTimer = setInterval(() => {
    try { peakRssKiB = Math.max(peakRssKiB, Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }))); }
    catch { /* The app has exited. */ }
  }, 100);
  const phaseLabels = ['Копирование файла…', 'Проверка базы…', 'Подготовка данных…', 'Замена активной базы…'];
  const sample = async () => {
    while (!page.isClosed()) {
      try {
        const round = performance.now();
        const status = await page.evaluate(() => Array.from(document.querySelectorAll('[role="status"]'), element => element.textContent));
        const rendererMs = performance.now() - round;
        rendererSamples.push(rendererMs);
        const phase = phaseLabels.find(label => status.includes(label));
        if (phase && phases.at(-1)?.name !== phase) phases.push({ name: phase, atMs: performance.now() - before });
        const ipcStart = performance.now();
        await page.evaluate(() => window.pulseDesktop.getPreferences().catch(() => null));
        ipcSamples.push(performance.now() - ipcStart);
        await new Promise(resolve => setTimeout(resolve, 25));
      } catch { break; }
    }
  };
  const sampling = sample();
  const closed = app.waitForEvent('close', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Восстановить базу' }).click();
  await closed;
  clearInterval(memoryTimer);
  await sampling;
  const totalMs = performance.now() - before;
  const events = (await readFile(phasesLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const phaseDurationsMs = Object.fromEntries(events.slice(0, -1).map(([phase, start], index) => [phase, events[index + 1][1] - start]));
  console.log(JSON.stringify({ catalogRows, historyResults: historyUrls * historyRuns, backupBytes, totalMs,
    peakRssKiB, rendererSampleCount: rendererSamples.length, rendererMaxMs: Math.max(...rendererSamples),
    ipcSampleCount: ipcSamples.length, ipcMaxMs: Math.max(...ipcSamples), phaseDurationsMs, phases }, null, 2));
  if (requireProgress) {
    assert.ok(phases.some(item => item.name === 'Проверка базы…'), 'The validation phase must be visible');
    assert.deepEqual(events.map(([phase]) => phase), ['copy', 'validate', 'prepare', 'replace', null]);
    assert.ok(Math.max(...rendererSamples) < 1_000, 'The browser must respond during restoration');
    assert.ok(ipcSamples.length >= 10, 'The window must receive IPC replies during restoration');
  }

  const restored = new DatabaseSync(join(profile, 'pulse.sqlite3'), { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT count(*) FROM catalog_urls').get()['count(*)'], catalogRows);
    assert.equal(restored.prepare('SELECT count(*) FROM results').get()['count(*)'], historyUrls * historyRuns);
  } finally { restored.close(); }
} finally {
  clearInterval(memoryTimer);
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
