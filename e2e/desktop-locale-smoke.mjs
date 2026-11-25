import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';

const profile = await mkdtemp(join(tmpdir(), 'pulse-electron-locale-'));
const preferences = join(profile, 'desktop-preferences.json');
const executablePath = process.env.PULSE_SMOKE_EXECUTABLE;
let app;

function launch() {
  return electron.launch({
    executablePath, args: executablePath ? [] : ['.'],
    env: { ...process.env, PULSE_DESKTOP_DATA_DIR: profile, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' },
  });
}

async function nativeLabels() {
  return app.evaluate(({ BrowserWindow, Menu }) => {
    const menus = Menu.getApplicationMenu().items;
    return {
      title: BrowserWindow.getAllWindows()[0].getTitle(),
      menu: menus[0].label, edit: menus[1].label,
      actions: menus[0].submenu.items.filter(item => item.label).map(item => item.label),
    };
  });
}

async function checkRunningInstaller() {
  const installer = process.env.PULSE_SMOKE_INSTALLER;
  if (process.platform !== 'win32' || !installer || !executablePath) return;
  const dir = dirname(executablePath);
  const uninstaller = join(dir, 'Uninstall.exe');
  for (const [path, args, windowsVerbatimArguments] of [
    [installer, ['/S'], false], [uninstaller, ['/S', '_?=' + dir], true],
  ]) {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(path, args, { windowsVerbatimArguments, windowsHide: true,
        argv0: windowsVerbatimArguments ? '"' + path + '"' : undefined, signal: AbortSignal.timeout(60_000) });
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(status, 1, 'Running Pulse URL must block installation and removal');
  }
}

try {
  await writeFile(preferences, JSON.stringify({ schedulesEnabled: false, locale: 'not-supported' }));
  app = await launch();
  let page = await app.firstWindow();
  const initial = await page.evaluate(async () => {
    const desktop = window.pulseDesktop;
    window.localeSmokeEvents = [];
    desktop.onLocaleChanged(locale => window.localeSmokeEvents.push(locale));
    return desktop.getLocale();
  });
  assert.equal(initial, 'ru-RU');
  const russian = await nativeLabels();
  assert.deepEqual(russian, {
    title: 'Пульс URL', menu: 'Пульс URL', edit: 'Правка',
    actions: ['Открыть Пульс URL', 'Экспорт резервной копии…', 'Восстановить резервную копию…', 'Язык', 'Выход'],
  });

  await page.getByRole('combobox', { name: 'Язык' }).selectOption('en-US');
  await expect.poll(() => page.evaluate(() => window.localeSmokeEvents)).toEqual(['en-US']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  const english = await nativeLabels();
  assert.deepEqual(english, {
    title: 'Pulse URL', menu: 'Pulse URL', edit: 'Edit',
    actions: ['Open Pulse URL', 'Export Backup…', 'Restore Backup…', 'Language', 'Quit'],
  });

  const missingProject = await page.evaluate(() => {
    const request = { method: 'GET', path: '/api/projects/999999' };
    return Promise.all([window.pulseDesktop.request(request), window.pulseDesktop.request({ ...request, i18n: true })]);
  });
  assert.deepEqual(missingProject[0], { status: 404, data: { error: 'Проект не найден.' } });
  assert.equal(missingProject[1].status, 404);
  assert.equal(typeof missingProject[1].data.messageKey, 'string');

  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.localeSmokeSaveDialog = options;
      return { canceled: true };
    };
  });
  assert.deepEqual(await page.evaluate(() => window.pulseDesktop.exportBackup()), { saved: false });
  assert.deepEqual(await app.evaluate(() => globalThis.localeSmokeSaveDialog), {
    title: 'Export backup', defaultPath: 'pulse-backup.sqlite3',
    filters: [{ name: 'SQLite database', extensions: ['sqlite3', 'sqlite', 'db'] }],
  });
  await expect(page.evaluate(() => window.pulseDesktop.setLocale({ locale: 'ru-RU' })))
    .rejects.toThrow('Choose Russian or English.');
  assert.deepEqual(JSON.parse(await readFile(preferences, 'utf8')), { schedulesEnabled: false, locale: 'en-US' });

  const project = await page.evaluate(() => window.pulseDesktop.request({
    path: '/api/projects', method: 'POST', body: JSON.stringify({ name: 'Excel fixture', description: '' }),
  }));
  assert.equal(project.status, 201);
  const report = join(profile, 'report.csv');
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (_window, options) => new Promise(resolve => {
      globalThis.localeSmokeSaveDialog = options;
      globalThis.finishLocaleSmokeSaveDialog = resolve;
    });
  });
  const exporting = page.evaluate(id => window.pulseDesktop.exportReport('/api/projects/' + id, 'excel', undefined, 'en-US'), project.data.id);
  try {
    await expect.poll(() => app.evaluate(() => globalThis.localeSmokeSaveDialog?.title)).toBe('Export report');
    assert.equal(await page.evaluate(() => window.pulseDesktop.setLocale('ru-RU')), 'ru-RU');
  } finally {
    await app.evaluate((_electron, filePath) => globalThis.finishLocaleSmokeSaveDialog?.({ canceled: false, filePath }), report);
    assert.deepEqual(await exporting, { saved: true });
  }
  assert.match(await readFile(report, 'utf8'), /^\uFEFFID;Run;URL ID;/);
  assert.equal(await page.evaluate(() => window.pulseDesktop.setLocale('en-US')), 'en-US');

  const foreign = await app.evaluate(async ({ app: main, BrowserWindow }) => {
    const path = process.getBuiltinModule('node:path');
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(main.getAppPath(), 'dist', 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true,
    } });
    try {
      await win.loadURL('pulse-app://app/');
      return await win.webContents.executeJavaScript(
        "window.pulseDesktop.setLocale('ru-RU').catch(error => error.message)");
    } finally { win.destroy(); }
  });
  assert.match(foreign, /This action is available from the main application window/);
  await checkRunningInstaller();

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  assert.equal(await page.evaluate(() => window.pulseDesktop.getLocale()), 'en-US');
  assert.deepEqual(await nativeLabels(), english);
  await page.evaluate(() => {
    window.localeSmokeEvents = [];
    window.pulseDesktop.onLocaleChanged(locale => window.localeSmokeEvents.push(locale));
  });
  const windowVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  await expect.poll(windowVisible).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(windowVisible).toBe(false);
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const russian = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Language')
      .submenu.items.find(item => item.label === 'Русский');
    russian.click(russian, win, {});
  });
  await expect.poll(() => page.evaluate(() => window.localeSmokeEvents)).toEqual(['ru-RU']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
  assert.equal(await windowVisible(), false);
  assert.deepEqual(await nativeLabels(), russian);
  await checkRunningInstaller();
  assert.deepEqual(JSON.parse(await readFile(preferences, 'utf8')), { schedulesEnabled: false, locale: 'ru-RU' });
  console.log('Desktop locale smoke passed (native menu, dialogs, restricted IPC, restart and hidden window).');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
