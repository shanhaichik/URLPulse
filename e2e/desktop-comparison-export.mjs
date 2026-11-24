import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import { createApp } from '../dist/server/app.js';
import { Store } from '../dist/server/store.js';
import { addUrls, digest, run } from './report-fixture.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pulse-comparison-export-'));
const database = join(directory, 'pulse.sqlite3');
const executablePath = process.env.PULSE_SMOKE_EXECUTABLE;
const projectName = 'Сравнение выгрузок';
const rowCount = 1_305;

async function fixture() {
  const store = new Store(database);
  const db = new DatabaseSync(database);
  const api = createApp({ store });
  try {
    const { id: projectId } = store.createProject(projectName, '');
    addUrls(store, projectId, rowCount, 'fixture');
    store.addUrls(projectId, [{ input: 'https://example.com/outside-search', line: 1 }]);
    const cases = [];
    for (const [format, side] of [['csv', 'baseline'], ['excel', 'baseline'], ['json', 'target']]) {
      const input = { baseline: run(store, db, projectId, 200), target: run(store, db, projectId, 503),
        kind: 'regression', q: 'fixture' };
      const reference = await api.inject(
        `/api/projects/${projectId}/run-comparison/export?${new URLSearchParams({ ...input, format })}`);
      assert.equal(reference.statusCode, 200, reference.body);
      assert.ok(!reference.body.includes('outside-search'));
      const filename = decodeURIComponent(reference.headers['content-disposition'].match(/filename\*=UTF-8''(.+)$/)[1]);
      assert.match(filename, /^\d{4}-\d{2}-\d{2} - Сравнение выгрузок\.(csv|json)$/u);
      if (format === 'json') {
        const { baseline, target, rows } = reference.json();
        assert.deepEqual([baseline.id, target.id], [input.baseline, input.target]);
        assert.equal(rows.length, rowCount);
        assert.equal(new Set(rows.map(row => row.urlId)).size, rowCount);
        assert.ok(rows.every(row => row.baseline.result.httpCode === 200 && row.target.result.httpCode === 503));
      } else {
        assert.equal(reference.body.trim().split('\r\n').length, rowCount + 1);
      }
      cases.push({ projectId, input, format, filename, sha256: digest(reference.rawPayload), runId: input[side] });
    }
    const { id: sample, url } = store.addresses(projectId)[0];
    for (let index = 0; index < 21; index++) {
      const { id } = store.enqueue(projectId, [sample]);
      const [item] = store.claim().items;
      store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 12, finalUrl: url,
        redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
      store.finish(id, false);
    }
    return cases;
  } finally { await api.close(); db.close(); store.close(); }
}

let desktop;
try {
  const cases = await fixture();
  desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'],
    env: { ...process.env, PULSE_DESKTOP_DATA_DIR: directory, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' } });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: projectName }).waitFor();
  const { baseline } = cases[0].input;
  const { baseline: previous, target } = cases.at(-1).input;
  await page.getByRole('button', { name: 'Журнал запусков', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить прогоны', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: 'Сравнение прогонов', exact: true });
  const before = comparison.getByRole('region', { name: 'Было', exact: true });
  const after = comparison.getByRole('region', { name: 'Стало', exact: true });
  await before.getByRole('button', { name: 'Выбрать прогон', exact: true }).click();
  const beforePicker = page.getByRole('dialog', { name: 'Выберите прогон — Было', exact: true });
  await beforePicker.getByRole('button', { name: 'Следующая страница', exact: true }).click();
  await beforePicker.getByRole('button', { name: `Выбрать прогон №${baseline}`, exact: true }).click();
  await after.getByRole('button', { name: 'Выбрать прогон', exact: true }).click();
  const afterPicker = page.getByRole('dialog', { name: 'Выберите прогон — Стало', exact: true });
  await afterPicker.getByRole('button', { name: `Выбрать прогон №${target}`, exact: true }).click();
  await comparison.getByRole('button', { name: /^Новые сбои/u }).click();
  const input = comparison.getByRole('searchbox', { name: 'URL или название', exact: true });
  await input.fill('outside-search');
  await input.press('Enter');
  const filtered = comparison.locator('.comparison-row');
  await expect(filtered).toHaveCount(1);
  await expect(filtered).toContainText('https://example.com/outside-search');
  await comparison.getByRole('button', { name: 'Поменять местами', exact: true }).click();
  await expect(before).toContainText(`№${target}`);
  await expect(filtered.getByRole('cell').nth(1)).toContainText('HTTP 503');
  await expect(filtered.getByRole('cell').nth(2)).toContainText('HTTP 200');
  await comparison.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `№${target} ·` }).getByRole('button', { name: 'Открыть отчёт' }).click();
  const report = page.getByRole('dialog', { name: `Отчёт по запуску №${target}`, exact: true });
  const openComparison = report.getByRole('button', { name: 'Сравнить с другим прогоном', exact: true });
  await openComparison.click();
  await expect(before).toContainText(`№${previous}`);
  await expect(after).toContainText(`№${target}`);
  await comparison.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(openComparison).toBeFocused();
  await report.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  const save = entry => page.evaluate(({ projectId, input, format }) =>
    window.pulseDesktop.exportComparison(projectId, input, format), entry);
  assert.deepEqual(await save(cases[0]), { saved: false });
  await assert.rejects(save({ ...cases[0], input: { baseline: '1 OR 1=1', target: 2 } }), /Выберите два прогона для сравнения/u);

  for (const entry of cases) {
    const { projectId, input, format } = entry;
    const search = new URLSearchParams({ project: projectId, tab: 'runs', compare: '1',
      baseline: input.baseline, target: input.target, kind: input.kind, compareQ: input.q });
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
      `pulse-app://app/?${search}`);
    const summary = comparison.getByRole('region', { name: 'Сводка сравнения' });
    await expect(summary.getByRole('button', { name: /^Новые сбои/u })).toHaveText(/Новые сбои 1\s306/u);
    const table = comparison.getByRole('table', { name: 'Результаты сравнения' });
    await expect(table.getByRole('row')).toHaveCount(101);
    await expect(table.getByText('HTTP 200', { exact: true }).first()).toBeVisible();
    await expect(table.getByText('HTTP 503', { exact: true }).first()).toBeVisible();

    const output = join(directory, entry.filename);
    await desktop.evaluate(({ dialog }, { output, database, runId }) => {
      globalThis.pulseComparisonExportTest = {};
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.pulseComparisonExportTest.filename = options.defaultPath;
        return { canceled: false, filePath: output };
      };
      const { Worker } = process.getBuiltinModule('node:worker_threads');
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.command === 'readComparisonExport') {
          Worker.prototype.postMessage = post;
          const afterBatch = response => {
            if (response.id !== message.id) return;
            this.off('message', afterBatch);
            globalThis.pulseComparisonExportTest.batch = response.value?.length;
            const db = new DatabaseSync(database);
            try {
              db.exec('BEGIN IMMEDIATE');
              db.prepare('DELETE FROM notifications WHERE run_id=?').run(runId);
              db.prepare('DELETE FROM results WHERE run_id=?').run(runId);
              globalThis.pulseComparisonExportTest.deleted = Number(db.prepare('DELETE FROM runs WHERE id=?').run(runId).changes);
              db.exec('COMMIT');
            } catch (error) { globalThis.pulseComparisonExportTest.failure = error.message; }
            finally { db.close(); }
          };
          this.prependListener('message', afterBatch);
        }
        return post.call(this, message, ...args);
      };
    }, { output, database, runId: entry.runId });

    await comparison.getByRole('button', { name: format === 'excel' ? 'CSV для Excel' : format.toUpperCase(), exact: true }).click();
    await expect(comparison.getByText('Сравнение сохранено.', { exact: true })).toBeVisible();
    const check = await desktop.evaluate(() => globalThis.pulseComparisonExportTest);
    assert.ok(check.batch > 0 && check.batch < rowCount, JSON.stringify(check));
    assert.equal(check.deleted, 1, JSON.stringify(check));
    assert.equal(check.filename, entry.filename);
    assert.equal(digest(await readFile(output)), entry.sha256);
  }
  console.log(`Electron и HTTP выгрузили одинаковые ${rowCount} строк в CSV, CSV для Excel и JSON во время удаления отчётов.`);
} finally {
  await desktop?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
