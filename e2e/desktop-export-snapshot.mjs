import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import { createApp } from '../dist/server/app.js';
import { Store } from '../dist/server/store.js';
import { addUrls, checkSnapshot, digest, run } from './report-fixture.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-export-'));
const database = join(directory, 'pulse.sqlite3');
const executablePath = process.env.PULSE_SMOKE_EXECUTABLE;
let desktop;

async function fixture() {
  const store = new Store(database);
  const db = new DatabaseSync(database);
  const app = createApp({ store });
  const cases = [];
  try {
    const project = store.createProject('Desktop export fixture', '').id;
    addUrls(store, project, 1305);
    for (const format of ['csv', 'excel', 'json']) {
      for (const target of ['baseline', 'current']) {
        const baseline = run(store, db, project, 200);
        const current = run(store, db, project, 503);
        const path = `/api/projects/${project}/runs/${current}`;
        const reference = await app.inject(`${path}/export?format=${format}&change=regression`);
        assert.equal(reference.statusCode, 200);
        cases.push({ format, target, path, runId: target === 'baseline' ? baseline : current,
          rows: checkSnapshot(reference.body, format), sha256: digest(reference.rawPayload) });
      }
    }
    const address = store.addresses(project)[0];
    const group = store.saveGroup(project, 'Группа для экспорта');
    store.changeGroupMembers(project, group.id, 'add', [address.id]);
    const groupRun = store.enqueueGroup(project, group.id);
    const [item] = store.claim().items;
    store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null });
    store.finish(groupRun.id);
    return { cases, group, groupRun, address };
  } finally { await app.close(); db.close(); store.close(); }
}

try {
  const { cases, group, groupRun, address } = await fixture();
  desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'],
    env: { ...process.env, PULSE_DESKTOP_DATA_DIR: directory, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' } });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'Desktop export fixture' }).waitFor();
  const [projectId, runId] = cases.at(-1).path.match(/\d+/g);
  const reportUrl = `pulse-app://app/?project=${projectId}&run=${runId}`;
  await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), reportUrl);
  const report = page.getByRole('dialog', { name: `Отчёт по запуску №${runId}` });
  const search = report.getByRole('searchbox');
  await search.fill('example.com');
  await report.getByRole('button', { name: 'Найти', exact: true }).click();
  await report.getByText('Выгрузить по фильтрам').waitFor();
  const filteredReportUrl = page.url();
  const route = new URL(filteredReportUrl).searchParams;
  assert.equal(route.get('project'), projectId);
  assert.equal(route.get('run'), runId);
  assert.equal(route.get('q'), 'example.com');
  for (let number = 2; number <= 14; number++) {
    await report.getByRole('button', { name: 'Далее', exact: true }).click();
    await report.getByText(`Страница ${number}`, { exact: true }).waitFor();
  }
  const row = report.locator('.result').last();
  await row.locator('summary').click();
  const inspect = row.getByRole('button', { name: 'История этого URL' });
  const body = report.locator('.modal-body');
  await inspect.scrollIntoViewIfNeeded();
  const scroll = await body.evaluate(element => element.scrollTop);
  for (const close of ['Escape', 'button']) {
    await inspect.click();
    const history = page.getByRole('dialog', { name: 'История URL' });
    await history.getByRole('button', { name: 'Открыть в браузере' }).waitFor();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await history.getByRole('button', { name: 'Закрыть' }).click();
    await inspect.waitFor();
    assert.equal(await inspect.evaluate(element => element === document.activeElement), true);
    assert.equal(await body.evaluate(element => element.scrollTop), scroll);
    assert.equal(await search.inputValue(), 'example.com');
    assert.equal(page.url(), filteredReportUrl);
  }
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Журнал запусков' }).waitFor();
  const checks = [];
  for (const entry of cases) {
    const output = join(directory, `${entry.format}-${entry.target}.out`);
    await desktop.evaluate(({ dialog }, { output, database, runId }) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const post = Worker.prototype.postMessage;
      globalThis.pulseExportTest = {};
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.command === 'readExport') {
          Worker.prototype.postMessage = post;
          const afterBatch = response => {
            if (response.id !== message.id) return;
            this.off('message', afterBatch);
            globalThis.pulseExportTest.batch = response.value?.length;
            const db = new DatabaseSync(database);
            try {
              db.exec('BEGIN IMMEDIATE');
              db.prepare('DELETE FROM notifications WHERE run_id=?').run(runId);
              db.prepare('DELETE FROM results WHERE run_id=?').run(runId);
              globalThis.pulseExportTest.deleted = Number(db.prepare('DELETE FROM runs WHERE id=?').run(runId).changes);
              db.exec('COMMIT');
            } catch (error) { globalThis.pulseExportTest.failure = error.message; }
            finally { db.close(); }
          };
          this.prependListener('message', afterBatch);
        }
        return post.call(this, message, ...args);
      };
    }, { output, database, runId: entry.runId });
    const result = await page.evaluate(({ path, format }) => window.pulseDesktop.exportReport(path, format, { change: 'regression' }), entry);
    assert.deepEqual(result, { saved: true });
    assert.deepEqual(await desktop.evaluate(() => globalThis.pulseExportTest), { batch: 500, deleted: 1 });
    assert.equal(digest(await readFile(output)), entry.sha256);
    const { format, target, rows, sha256 } = entry;
    checks.push({ format, deleted: target, rows, sha256 });
  }
  const groupPath = `/api/projects/${projectId}/groups/${group.id}`;
  const groupPage = await page.evaluate(path => window.pulseDesktop.request({ method: 'GET', path: `${path}/runs` }), groupPath);
  assert.equal(groupPage.status, 200);
  assert.deepEqual(groupPage.data.items.map(entry => entry.id), [groupRun.id]);
  for (const [scope, path] of [['group', groupPath], ['run', `/api/projects/${projectId}/runs/${groupRun.id}`]]) {
    const output = join(directory, `${scope}.json`);
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    assert.deepEqual(await page.evaluate(target => window.pulseDesktop.exportReport(target, 'json'), path), { saved: true });
    const records = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(records.map(record => [record.runId, record.url]), [[groupRun.id, address.url]]);
  }
  console.log(JSON.stringify({ reportNavigation: { page: 14, close: ['Escape', 'button'] }, ipc: checks, groupExport: groupRun.id }));
} finally {
  await desktop?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
