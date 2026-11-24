import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect } from 'playwright/test';
import { Store } from '../dist/server/store.js';

const directory = await mkdtemp(join(tmpdir(), 'pulse-electron-settings-'));
const data = join(directory, 'data');
let app;

try {
  await mkdir(data, { mode: 0o700 });
  const store = new Store(join(data, 'pulse.sqlite3'));
  const project = store.createProject('Синтетический отчёт', '');
  store.addUrls(project.id, [{ input: 'https://fixture.invalid/', line: 1 }]);
  const run = store.enqueue(project.id);
  const result = store.claim().items[0];
  store.saveResult(result.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: result.url,
    redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
  store.finish(run.id);
  store.close();
  const link = `pulse-url://report/?project=${project.id}&run=${run.id}`;
  async function start(...args) {
    return electron.launch({ args: ['.', ...args],
      env: { ...process.env, PULSE_DESKTOP_DATA_DIR: data, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' } });
  }

  app = await start(link);
  let page = await app.firstWindow();
  const settings = () => page.getByRole('banner').getByRole('button', { name: 'Настройки приложения' });
  const report = () => page.getByRole('dialog', { name: `Отчёт по запуску №${run.id}` });
  await expect(report()).toBeVisible();
  await report().getByRole('button', { name: 'Закрыть' }).click();

  if (process.argv.includes('link') || process.argv.length === 2) {
    await page.evaluate(() => { window.pulseWarmLinkMarker = true; });
    await app.evaluate(({ app }, value) => app.emit('second-instance', {}, [value]), link);
    await expect(report()).toBeVisible();
    assert.equal(await page.evaluate(() => window.pulseWarmLinkMarker), true, 'Warm report must preserve the renderer');
    await report().getByRole('button', { name: 'Закрыть' }).click();
    await settings().click();
    await page.getByLabel('SMTP-хост').fill('unsaved fixture');
    const showReport = () => app.evaluate(({ app }, value) => {
      app.emit('open-url', { preventDefault() {} }, value);
    }, link);
    const leavePrompt = page.waitForEvent('dialog');
    await showReport();
    await (await leavePrompt).dismiss();
    await expect(page.getByLabel('SMTP-хост')).toHaveValue('unsaved fixture');
    await expect(report()).toHaveCount(0);
    const discardPrompt = page.waitForEvent('dialog');
    await showReport();
    await (await discardPrompt).accept();
    await expect(report()).toBeVisible();
    assert.equal(await page.evaluate(() => window.pulseWarmLinkMarker), true);
    await report().getByRole('button', { name: 'Закрыть' }).click();
  }

  if (process.argv.includes('backup') || process.argv.length === 2) {
    await settings().click();
    const backup = page.getByRole('button', { name: 'Экспорт базы' });
    const success = page.getByText('Резервная копия сохранена.', { exact: true });
    const path = join(directory, 'copy.sqlite3');
    const invalid = join(directory, 'occupied.sqlite3');
    await mkdir(invalid);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await backup.click();
    await expect(success).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, invalid);
    await backup.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Выберите другой файл или папку.' })).toBeVisible();
    await expect(success).toHaveCount(0);
    await expect(backup).toBeEnabled();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
    await backup.click();
    await expect(success).toBeVisible();
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    const files = await readdir(directory);
    await backup.click();
    await expect(success).toHaveCount(0);
    await expect(backup).toBeEnabled();
    assert.deepEqual(await readdir(directory), files);
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
  }

  if (process.argv.includes('preferences') || process.argv.length === 2) {
    await app.evaluate(({ app }) => {
      app.getLoginItemSettings = () => ({ openAtLogin: false });
      app.setLoginItemSettings = () => { throw new Error('Registration unavailable'); };
    });
    await settings().click();
    await page.getByLabel('SMTP-хост').fill('bad host');
    const schedules = page.getByRole('checkbox', { name: 'Выполнять расписания' });
    await schedules.uncheck();
    await page.getByRole('checkbox', { name: 'Запускать приложение при входе в систему' }).check();
    await page.getByRole('button', { name: 'Сохранить фоновую работу' }).click();
    await expect(page.getByText('Расписания приостановлены.', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Не удалось изменить автозапуск.' })).toBeVisible();
    assert.equal(JSON.parse(await readFile(join(data, 'desktop-preferences.json'))).schedulesEnabled, false);
    assert.equal(await page.getByLabel('SMTP-хост').inputValue(), 'bad host');
    page.once('dialog', prompt => prompt.dismiss());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Настройки приложения' })).toBeVisible();
    page.once('dialog', prompt => prompt.accept());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Настройки приложения' })).toHaveCount(0);
    await expect(settings()).toBeFocused();
    await app.close();
    app = await start();
    page = await app.firstWindow();
    await settings().click();
    await expect(page.getByRole('checkbox', { name: 'Выполнять расписания' })).not.toBeChecked();
    await page.getByRole('dialog', { name: 'Настройки приложения' })
      .getByRole('button', { name: 'Закрыть' }).click();
  }

  if (process.argv.includes('shutdown') || process.argv.length === 2) {
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = () => new Promise(resolve => {
        globalThis.finishSaveDialog = () => resolve({ canceled: true });
      });
    });
    const inFlight = page.evaluate(() => window.pulseDesktop.exportBackup());
    try {
      await expect.poll(() => app.evaluate(() => typeof globalThis.finishSaveDialog)).toBe('function');
      await app.evaluate(({ app }) => { app.quit(); });
      const response = await page.evaluate(() => window.pulseDesktop.request({ method: 'GET', path: '/api/projects' })
        .catch(error => ({ rejection: error.message })));
      assert.deepEqual(response, { status: 503, data: { error: 'Приложение завершает работу.', code: 'desktop-shutdown' } });
      await page.waitForTimeout(3500); // Let the workspace's background poll run while the dialog keeps shutdown pending.
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      await app.evaluate(() => globalThis.finishSaveDialog?.()).catch(() => {});
      await inFlight.catch(() => {});
    }
  }

  console.log(`Desktop settings smoke passed (${process.argv.slice(2).join(', ') || 'deep links, backup, preferences, shutdown'}).`);
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
