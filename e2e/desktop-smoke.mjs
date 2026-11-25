import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';

const directory = await mkdtemp(join(tmpdir(), 'pulse-electron-smoke-'));
const data = join(directory, 'data');
const backup = join(directory, 'backup.sqlite3');
const report = join(directory, 'report.csv');
const sitemap = join(directory, 'sitemap.xml');
const catalogCsv = join(directory, 'catalog.csv');
const executablePath = process.env.PULSE_SMOKE_EXECUTABLE;
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function start() {
  return electron.launch({
    args: executablePath ? [] : ['.'], executablePath,
    env: { ...process.env, PULSE_RUSSIAN_CA_FILE: '', PULSE_DESKTOP_DATA_DIR: data, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' },
  });
}

async function appsAreReady(app) {
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
  const page = await app.firstWindow();
  await page.getByRole('banner').getByRole('button', { name: 'Настройки приложения' }).waitFor();
  await page.waitForFunction(() => document.querySelector('img.brand-mark')?.naturalWidth === 128);
  return page;
}

async function waitForRun(id) {
  for (let attempt = 0; attempt < 75; attempt++) {
    const db = new DatabaseSync(join(data, 'pulse.sqlite3'), { readOnly: true });
    try {
      const row = db.prepare("SELECT id, tls_profile FROM runs WHERE project_id = ? AND status = 'done'").get(id);
      if (row) return row;
    } finally { db.close(); }
    await setTimeout(300);
  }
  throw new Error('Проверка в фоне не завершилась.');
}

let app;
try {
  app = await start();
  let page = await appsAreReady(app);
  const competingWeb = spawnSync(process.execPath, ['dist/server/main.js'], {
    env: { ...process.env, URL_PULSE_DB: join(data, 'pulse.sqlite3') }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(competingWeb.status, 1);
  assert.match(competingWeb.stderr, /База Пульса URL уже открыта в другой копии/);
  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта', { exact: true }).fill('Desktop smoke');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByRole('heading', { name: 'Desktop smoke' }).waitFor();

  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByLabel('Адреса', { exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'Добавить адреса' }).click();
  await page.getByRole('button', { name: 'Готово' }).click();
  await page.getByText('https://example.com/', { exact: true }).waitFor();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async url => { globalThis.pulseOpenedUrl = url; };
  });
  await page.getByRole('button', { name: 'https://example.com/', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть в браузере' }).click();
  const opened = await app.evaluate(() => globalThis.pulseOpenedUrl);
  assert.equal(opened, 'https://example.com/');
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();

  await app.evaluate(() => {
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    const postMessage = Worker.prototype.postMessage;
    const pendingClaims = [];
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.command === 'claim') pendingClaims.push(() => postMessage.call(this, message, ...args));
      else return postMessage.call(this, message, ...args);
    };
    globalThis.releaseSmokeClaims = () => {
      Worker.prototype.postMessage = postMessage;
      pendingClaims.forEach(resume => resume());
    };
  });
  try {
    await page.getByRole('button', { name: 'Проверить проект' }).click();
    const progress = page.locator('.progress-bar');
    await progress.getByText('Проверка в очереди', { exact: true }).waitFor();
    await progress.getByRole('button', { name: 'Остановить проверку' }).click();
    await page.getByText(/^Проверка №\d+ остановлена\.$/).waitFor();
    const stoppedCheck = page.getByRole('region', { name: 'Остановленная проверка' });
    await stoppedCheck.getByRole('button', { name: 'Открыть отчёт' }).click();
    const stopped = page.getByRole('dialog', { name: /Отчёт по запуску/ });
    await stopped.getByText('Остановлена', { exact: true }).waitFor();
    const previousReport = new URL(page.url()).searchParams.get('run');
    await stopped.getByRole('button', { name: 'Запустить заново', exact: true }).click();
    await stopped.getByRole('button', { name: 'Открыть новый отчёт' }).click();
    await stopped.getByText('В очереди', { exact: true }).first().waitFor();
    assert.notEqual(new URL(page.url()).searchParams.get('run'), previousReport);
    await stopped.getByRole('button', { name: 'Остановить проверку' }).click();
    await stopped.getByText('Остановлена', { exact: true }).waitFor();
    await stopped.getByRole('button', { name: 'Закрыть' }).click();
  } finally { await app.evaluate(() => globalThis.releaseSmokeClaims()); }

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить профиль' }).click();
  const profile = page.getByRole('dialog', { name: 'Новый профиль HTTP' });
  await profile.getByLabel('Название профиля').fill('Desktop smoke HTTP');
  await profile.getByLabel('Адрес сервера').fill('https://example.com');
  await profile.getByRole('checkbox', { name: 'Применять по умолчанию к URL этого сервера' }).check();
  await profile.getByRole('button', { name: 'Сохранить профиль' }).click();
  await page.getByText('Desktop smoke HTTP', { exact: true }).waitFor();
  await page.getByLabel('Включить расписание').check();
  await page.getByLabel('Профиль HTTPS').selectOption('russian-ca');
  const concurrency = page.getByRole('spinbutton', { name: 'Одновременных проверок' });
  assert.equal(await concurrency.inputValue(), '6');
  await concurrency.fill('3');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await page.getByText('Настройки сохранены', { exact: true }).waitFor();
  const projectId = Number(new URL(page.url()).searchParams.get('project'));
  const pacPath = `/api/projects/${projectId}/proxy-pac`;
  const pac = await page.evaluate(path => window.pulseDesktop.request({
    method: 'PUT', path, body: JSON.stringify({
      filename: 'desktop.pac', source: 'function FindProxyForURL(url, host) { return "DIRECT"; }',
    }),
  }), pacPath);
  assert.equal(pac.status, 200, JSON.stringify(pac.data));
  const corporateProxy = { url: 'https://proxy.office.test:8443', allowPrivate: true, connectByHostname: true };
  const trusted = await page.evaluate(({ path, revision, proxy }) => window.pulseDesktop.request({
    method: 'PATCH', path, body: JSON.stringify({ revision, proxies: [proxy] }),
  }), { path: pacPath, revision: pac.data.pac.revision, proxy: corporateProxy });
  assert.equal(trusted.status, 200, JSON.stringify(trusted.data));
  assert.deepEqual(trusted.data.pac.proxies, [corporateProxy]);
  assert.notEqual(trusted.data.pac.revision, pac.data.pac.revision);
  const preview = await page.evaluate(path => window.pulseDesktop.request({
    method: 'POST', path: path + '/test', body: JSON.stringify({ url: 'https://example.com/' }),
  }), pacPath);
  assert.deepEqual(preview, { status: 200, data: { routes: [{ kind: 'direct' }], source: 'pac' } });
  const certificatePath = await app.evaluate(() => process.env.PULSE_RUSSIAN_CA_FILE);
  assert.equal(certificatePath, join(data, 'cert', 'Russian_Trusted_Root_CA.cer'));

  await app.evaluate(() => {
    // Use a fixed DNS answer so the missing CA can be checked without external requests.
    const dns = process.getBuiltinModule('node:dns/promises');
    const lookup = dns.lookup;
    dns.lookup = (hostname, options) => hostname === 'example.com' && options?.all
      ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : lookup(hostname, options);
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
  });

  const visible = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    return window.isVisible();
  });
  assert.equal(visible, false);
  const db = new DatabaseSync(join(data, 'pulse.sqlite3'));
  try { db.prepare('UPDATE projects SET next_at = ? WHERE id = ?').run(Date.now() - 10, projectId); }
  finally { db.close(); }
  const run = await waitForRun(projectId);
  assert.equal(run.tls_profile, 'russian-ca');
  const checked = new DatabaseSync(join(data, 'pulse.sqlite3'), { readOnly: true });
  try {
    const result = checked.prepare('SELECT tls_code, request_profile, request_route, request_source FROM results WHERE run_id = ?').get(run.id);
    assert.equal(result.tls_code, 'ERR_TLS_PROFILE_CA', 'Проверка отсутствующего локального CA');
    assert.equal(result.request_profile, 'Desktop smoke HTTP');
    assert.equal(result.request_route, null);
    assert.equal(result.request_source, 'pac');
  } finally { checked.close(); }
  await app.evaluate(({ app }) => app.emit('activate'));

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.pulseExportFilename = options.defaultPath;
      return { canceled: false, filePath: path };
    };
  }, report);
  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.locator('.run-table').getByRole('button', { name: 'Открыть отчёт' }).first().click();
  await page.getByRole('dialog', { name: `Отчёт по запуску №${run.id}` }).getByRole('button', { name: 'CSV', exact: true }).click();
  for (let attempt = 0; attempt < 40; attempt++) {
    const csv = await readFile(report, 'utf8').catch(() => '');
    if (csv.includes('https://example.com/')) break;
    if (attempt === 39) throw new Error('Не сохранён desktop-отчёт.');
    await setTimeout(100);
  }
  assert.match(await app.evaluate(() => globalThis.pulseExportFilename), /^\d{4}-\d{2}-\d{2} - Desktop smoke\.csv$/);
  const excel = join(directory, 'excel.csv');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, excel);
  const runReport = page.getByRole('dialog');
  await runReport.getByLabel('URL или название').fill('example.com');
  await runReport.getByRole('button', { name: 'Найти', exact: true }).click();
  await runReport.getByText('Выгрузить по фильтрам', { exact: true }).waitFor();
  await runReport.getByRole('button', { name: 'CSV для Excel', exact: true }).click();
  for (let attempt = 0; attempt < 40; attempt++) {
    const csv = await readFile(excel, 'utf8').catch(() => '');
    if (csv.includes('Название;Статус;HTTP-код') && csv.includes('https://example.com/')) break;
    if (attempt === 39) throw new Error('Не сохранён фильтрованный CSV для Excel.');
    await setTimeout(100);
  }
  const reportDialog = page.getByRole('dialog', { name: /Отчёт по запуску/ });
  await reportDialog.locator('.result summary').first().click();
  await reportDialog.getByRole('alert').filter({ hasText: 'ERR_TLS_PROFILE_CA' }).waitFor();
  const inspect = reportDialog.getByRole('button', { name: 'История этого URL' }).first();
  const runUrl = page.url();
  for (const action of ['Escape', 'button']) {
    await inspect.click();
    const history = page.getByRole('dialog', { name: 'История URL' });
    await history.getByText('https://example.com/', { exact: true }).first().waitFor();
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await history.getByRole('button', { name: 'Закрыть' }).click();
    await inspect.waitFor();
    assert.equal(await inspect.evaluate(element => element === document.activeElement), true);
    assert.equal(await reportDialog.getByRole('searchbox').inputValue(), 'example.com');
    assert.equal(page.url(), runUrl);
  }
  const jsonButton = reportDialog.getByRole('button', { name: 'JSON', exact: true });
  const saveError = reportDialog.locator('.report-exports').getByRole('alert');
  const jsonPath = join(directory, 'report.json');
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await jsonButton.click();
  await jsonButton.locator('xpath=self::*[not(@disabled)]').waitFor();
  assert.equal(await saveError.count(), 0);
  assert.equal((await readdir(directory)).includes('report.json'), false);
  await mkdir(jsonPath);
  const marker = join(jsonPath, 'existing');
  await writeFile(marker, 'existing data');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, jsonPath);
  await jsonButton.click();
  await saveError.waitFor();
  assert.match(await saveError.textContent(), /^(Не удалось сохранить файл по выбранному пути\. Выберите другой файл или папку\.|Нет прав на запись\. Выберите другое место для сохранения\.)$/);
  assert.equal(await readFile(marker, 'utf8'), 'existing data');
  assert.equal((await readdir(directory)).some(name => name.startsWith('.pulse-write-')), false);
  await rm(jsonPath, { recursive: true });
  await jsonButton.click();
  for (let attempt = 0; attempt < 40; attempt++) {
    const json = await readFile(jsonPath, 'utf8').catch(() => '');
    if (json) { assert.equal(JSON.parse(json)[0].url, 'https://example.com/'); break; }
    if (attempt === 39) throw new Error('Не сохранён desktop-отчёт JSON.');
    await setTimeout(100);
  }
  assert.equal(await saveError.count(), 0);
  await reportDialog.getByRole('button', { name: 'Закрыть' }).click();

  const catalogUrl = 'https://example.com/catalog-smoke';
  await writeFile(sitemap, '<urlset><url><loc>' + catalogUrl + '</loc></url></urlset>');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, sitemap);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
  await page.getByRole('cell', { name: catalogUrl, exact: true }).waitFor();
  const sitemapTwo = join(directory, 'second.xml');
  const catalogUrlTwo = 'https://example.com/second-source';
  await writeFile(sitemapTwo, '<urlset><url><loc>' + catalogUrlTwo + '</loc></url></urlset>');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, sitemapTwo);
  const source = page.getByRole('combobox', { name: /^Источник/ });
  await page.getByRole('button', { name: 'Источник', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
  await page.getByRole('cell', { name: catalogUrlTwo, exact: true }).waitFor();
  const secondSource = await source.inputValue();
  const updatedUrl = 'https://example.com/updated-source';
  await writeFile(sitemapTwo, '<urlset><url><loc>' + updatedUrl + '</loc></url></urlset>');
  await page.getByRole('button', { name: 'Загрузить новую версию', exact: true }).click();
  await page.getByRole('cell', { name: updatedUrl, exact: true }).waitFor();
  assert.equal(await source.inputValue(), secondSource);
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: 'Источник', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
  await page.getByRole('cell', { name: updatedUrl, exact: true }).waitFor();
  assert.equal(await source.inputValue(), secondSource);
  await source.selectOption({ label: 'sitemap.xml' });
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.pulseExportFilename = options.defaultPath;
      return { canceled: false, filePath: file };
    };
  }, catalogCsv);
  await page.getByRole('button', { name: 'CSV по фильтру' }).click();
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await readFile(catalogCsv, 'utf8').catch(() => '')).includes(catalogUrl)) break;
    if (attempt === 39) throw new Error('Не сохранён CSV каталога.');
    await setTimeout(100);
  }
  assert.match(await app.evaluate(() => globalThis.pulseExportFilename), /^\d{4}-\d{2}-\d{2} - Desktop smoke\.csv$/);

  await page.getByRole('button', { name: 'Добавить все в «Адреса»' }).click();
  await page.getByRole('button', { name: 'Перенести адреса', exact: true }).click();
  await page.getByText('Добавлено: 2 · Уже в списке: 0', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть «Адреса»' }).click();
  await page.getByRole('button', { name: catalogUrl, exact: true }).waitFor();

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, backup);
  await page.getByRole('button', { name: 'Настройки приложения' }).click();
  await page.getByRole('button', { name: 'Экспорт базы' }).click();
  await page.getByText('Резервная копия сохранена.').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта', { exact: true }).fill('После резервной копии');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByRole('heading', { name: 'После резервной копии' }).waitFor();

  await page.getByRole('button', { name: 'Настройки приложения' }).click();
  const restoreButton = page.getByRole('button', { name: 'Восстановить базу' });
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise(resolve => {
      globalThis.pulseCancelRestore = () => resolve({ canceled: true, filePaths: [] });
    });
  });
  await restoreButton.click();
  try {
    await expect.poll(() => app.evaluate(() => typeof globalThis.pulseCancelRestore)).toBe('function');
    await assert.rejects(page.evaluate(() => window.pulseDesktop.exportBackup()), /текущей операции с файлом/);
  } finally {
    await app.evaluate(() => globalThis.pulseCancelRestore?.());
  }
  await expect(restoreButton).toBeEnabled();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, backup);
  assert.equal(await page.evaluate(() => window.pulseDesktop.importBackup()), false);
  assert.deepEqual((await readdir(data)).filter(name => name.startsWith('pulse-before-import-')), []);

  const unrelated = join(directory, 'unrelated.sqlite3');
  const unrelatedDatabase = new DatabaseSync(unrelated);
  try { unrelatedDatabase.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)'); }
  finally { unrelatedDatabase.close(); }
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, unrelated);
  await page.evaluate(() => {
    window.pulseRestorePhases = [];
    window.pulseStopRestoreListener = window.pulseDesktop.onBackupProgress(phase => window.pulseRestorePhases.push(phase));
  });
  await restoreButton.click();
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Не удалось восстановить резервную копию.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.pulseRestorePhases)).toEqual(['copy', 'validate', null]);
  await page.evaluate(() => window.pulseStopRestoreListener());
  await expect(restoreButton).toBeEnabled();
  assert.deepEqual((await readdir(data)).filter(name => name.startsWith('.pulse-import-') || name.startsWith('pulse-before-import-')), []);
  assert.equal((await page.evaluate(() => window.pulseDesktop.getPreferences())).schedulesEnabled, true);
  await page.getByRole('heading', { name: 'После резервной копии' }).waitFor();

  await app.evaluate(({ app, dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    app.relaunch = () => {};
  }, backup);
  const closed = app.waitForEvent('close');
  await restoreButton.click();
  await closed;
  const previousCopies = (await readdir(data)).filter(name => name.startsWith('pulse-before-import-'));
  assert.equal(previousCopies.length, 1);
  const previous = new DatabaseSync(join(data, previousCopies[0]), { readOnly: true });
  try {
    assert.equal(previous.prepare('SELECT name FROM projects WHERE name = ?').get('После резервной копии')?.name,
      'После резервной копии');
  } finally { previous.close(); }
  app = await start();
  page = await appsAreReady(app);
  await page.getByRole('heading', { name: 'Desktop smoke' }).waitFor();
  await page.getByText('Расписания приостановлены.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: 'Одновременных проверок' }).inputValue(), '3');
  assert.equal(await page.getByRole('button', { name: /После резервной копии/ }).count(), 0);
  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.getByRole('button', { name: 'Открыть отчёт' }).first().waitFor();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByRole('cell', { name: catalogUrl, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await page.getByRole('button', { name: catalogUrl, exact: true }).waitFor();

  const lateFile = join(directory, 'late.xml');
  const lateUrl = 'https://example.com/late-catalog';
  await writeFile(lateFile, `<urlset><url><loc>${lateUrl}</loc></url></urlset>`);
  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта', { exact: true }).fill('Другой каталог');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByRole('heading', { name: 'Другой каталог' }).waitFor();
  await page.getByRole('button', { name: /Desktop smoke/ }).click();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise(resolve => { globalThis.pulseReleasePicker = resolve; });
  });
  await page.getByRole('button', { name: 'Источник', exact: true }).click();
  await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
  await page.getByRole('button', { name: /Другой каталог/ }).click();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await app.evaluate((_, file) => globalThis.pulseReleasePicker({ canceled: false, filePaths: [file] }), lateFile);
  await page.getByRole('heading', { name: 'Другой каталог' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: /^Источник/ }).count(), 0);
  await page.getByRole('button', { name: /Desktop smoke/ }).click();
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.locator('option').filter({ hasText: 'late.xml' }).waitFor({ state: 'attached' });
  await page.getByRole('combobox', { name: /^Источник/ }).selectOption({ label: 'late.xml' });
  await page.getByRole('cell', { name: lateUrl, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Очистить каталог', exact: true }).click();
  const clearCatalog = page.getByRole('dialog', { name: 'Очистить каталог sitemap?' });
  await clearCatalog.getByText('Источников: 3', { exact: true }).waitFor();
  await clearCatalog.getByRole('button', { name: /^(Очистить каталог|Остановить и очистить)$/ }).click();
  await page.getByText('Каталог очищен. Удалено источников: 3.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await page.getByRole('button', { name: catalogUrl, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Действия', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить все адреса проекта', exact: true }).click();
  const clear = page.getByRole('dialog', { name: 'Удалить все адреса проекта?' });
  await clear.getByText('Адресов к удалению: 3', { exact: true }).waitFor();
  await clear.getByRole('button', { name: 'Удалить все адреса', exact: true }).click();
  await page.getByText('В проекте пока нет адресов', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.locator('.run-table').getByRole('button', { name: 'Открыть отчёт' }).first().waitFor();
  console.log('Desktop smoke passed: version, TLS, HTTP profiles, PAC import, trusted proxy settings and background routing, run cancellation and restart, report history, CSV/Excel/JSON, save cancellation and retry, sitemap source selection, complete transfer, backup restore cancellation, rejection and retry, and catalog and worklist clearing.');
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { force: true, recursive: true });
}
