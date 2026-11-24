import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect } from 'playwright/test';
import { createBackup, openStagingJournal } from '../dist/desktop/backup.js';
import { Store } from '../dist/server/store.js';

const root = await mkdtemp(join(tmpdir(), 'pulse-electron-recovery-'));
const profile = join(root, 'profile');
const destination = join(root, 'report.csv');
const active = join(profile, 'pulse.sqlite3');
const invalid = join(root, 'invalid.sqlite3');
let app;
try {
  await mkdir(profile, { mode: 0o700 });
  const store = new Store(active);
  const project = store.createProject('Рабочая тестовая база', '').id;
  store.addUrls(project, [{ input: 'https://fixture.invalid/', line: 1 }]);
  const { id: run } = store.enqueue(project);
  const [item] = store.claim().items;
  store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url,
    redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
  store.finish(run, false);
  store.close();
  await createBackup(active, invalid);
  const copy = new DatabaseSync(invalid);
  try { copy.prepare('UPDATE runs SET completed=0, available=0 WHERE id=?').run(run); }
  finally { copy.close(); }

  await writeFile(destination, 'Ранее опубликованный отчёт');
  await mkdir(join(root, '.pulse-write-unrelated'));
  const journal = await openStagingJournal(profile);
  const abandoned = await journal.create(root, 'write');
  await writeFile(abandoned.file, 'Ещё не опубликованные строки');
  const pending = await journal.create(profile, 'import');
  await writeFile(pending.file, 'Временная копия');

  app = await electron.launch({ args: ['.'], env: { ...process.env,
    PULSE_DESKTOP_DATA_DIR: profile, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' } });
  const page = await app.firstWindow();
  const activeHeading = page.getByRole('heading', { name: 'Рабочая тестовая база', exact: true });
  await expect(activeHeading).toBeVisible();
  assert.ok(!(await readdir(root)).includes(basename(dirname(abandoned.file))));
  assert.ok((await readdir(root)).includes('.pulse-write-unrelated'));
  assert.ok(!(await readdir(profile)).some(file => file.startsWith('.pulse-import-')));
  assert.equal(await readFile(destination, 'utf8'), 'Ранее опубликованный отчёт');

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, invalid);
  await page.getByRole('button', { name: 'Настройки приложения' }).click();
  await page.getByRole('button', { name: 'Восстановить базу' }).click();
  await expect(page.getByRole('alert')).toContainText(`не совпадают счётчики или цели прогона №${run}.`);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
  await expect(activeHeading).toBeVisible();
  const activeCopy = new DatabaseSync(active, { readOnly: true });
  try { assert.equal(activeCopy.prepare('SELECT completed FROM runs WHERE id=?').get(run).completed, 1); }
  finally { activeCopy.close(); }
  assert.ok(!(await readdir(profile)).some(file => file.startsWith('.pulse-import-') || file.startsWith('pulse-before-import-')));
  console.log('Electron recovered only journaled staging and rejected an inconsistent backup before replacement.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
