import { parseReportFilters } from '../server/report-query.js';
import { DatabaseTasks } from '../server/database-tasks.js';
import { ownDatabase, prepareProfileDirectory } from '../server/database-owner.js';
import { catalogFilter, catalogId, chosenUrls } from '../server/catalog/routes.js';
import { CatalogService } from '../server/catalog/service.js';
import { createWriteStream } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, safeStorage, session, shell, Tray } from 'electron';
import { DESKTOP_SHUTDOWN, type BackupPhase, type DesktopRequest, type DesktopSaveResult, type ExportFormat, type SaveDesktopPreferences } from '../shared/desktop.js';
import { normalizeUrl } from '../server/checker.js';
import { createApp } from '../server/app.js';
import { exportFormat, openReportStream, reportFile } from '../server/export.js';
import { openComparisonStream } from '../server/run-comparison-export.js';
import { parseComparisonInput } from '../server/run-comparison-input.js';
import { ApiError, Store } from '../server/store.js';
import { russianCaFilename } from '../server/tls-profile.js';
import { startBackground } from '../server/worker.js';
import { assertSeparateFile, atomicFile, copyDatabase, createBackup, openStagingJournal, prepareImport } from './backup.js';
import { desktopRequest, exportScope, reportArguments } from './contracts.js';
import { desktopPreferences } from './preferences.js';
import { desktopRequestSecrets } from './request-secrets.js';

const uiOrigin = 'pulse-app://app';
const clientPath = fileURLToPath(new URL('../client/', import.meta.url));
const projectPath = fileURLToPath(new URL('../../', import.meta.url));
const desktopAssets = join(projectPath, 'desktop-assets');
const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const explicitDirectory = process.env.PULSE_DESKTOP_DATA_DIR;
if (explicitDirectory) {
  const data = resolve(explicitDirectory);
  prepareProfileDirectory(data, false);
  app.setPath('userData', data);
}
app.setName('Pulse URL');

protocol.registerSchemesAsPrivileged([
  { scheme: 'pulse-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch(error => {
    console.error(error);
    dialog.showErrorBox('Пульс URL', 'Не удалось запустить приложение. ' + (error as Error).message);
    app.exit(1);
  });
}

const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const mimeTypes = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

async function asset(request: Request) {
  const url = new URL(request.url);
  if (url.host !== 'app' || request.method !== 'GET') return new Response(null, { status: 404 });
  const file = /^\/assets\/([a-z\d._-]+\.(js|css|woff2))$/i.exec(url.pathname);
  const icon = url.pathname === '/pulse-icon.png';
  if (url.pathname !== '/' && !icon && !file) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(file ? join(clientPath, 'assets', file[1]) : join(clientPath, icon ? 'pulse-icon.png' : 'index.html'));
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': file ? mimeTypes[file[2] as keyof typeof mimeTypes] : icon ? 'image/png' : 'text/html; charset=utf-8',
      'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
    } });
  } catch { return new Response(null, { status: 404 }); }
}

async function start() {
  const appIcon = nativeImage.createFromPath(join(desktopAssets, 'pulse-icon.png'));
  let window: BrowserWindow | undefined;
  let pendingReport = process.argv.map(reportArguments).find(Boolean);
  let navigationReady = false;
  let booted = false;
  let quitting = false;
  let allowExit = false;
  let stopTask: Promise<void> | undefined;
  let fileTask: Promise<unknown> | undefined;
  let preferencesTask: Promise<unknown> | undefined;
  let tray: Tray | undefined;
  const pendingRequests = new Set<Promise<unknown>>();

  function sendReport() {
    if (!pendingReport || !navigationReady || !window || window.isDestroyed()) return;
    window.webContents.send('pulse:navigate', '/?' + new URLSearchParams(pendingReport));
    pendingReport = undefined;
  }

  function open() {
    if (!booted || quitting) return;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        title: 'Пульс URL', width: 1280, height: 880, minWidth: 400, minHeight: 550, show: false,
        icon: appIcon,
        webPreferences: { preload, nodeIntegration: false, sandbox: true, contextIsolation: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) navigationReady = false;
      });
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('close', event => {
        if (quitting) return;
        event.preventDefault();
        window?.hide();
      });
      window.on('closed', () => { window = undefined; });
      window.once('ready-to-show', () => { window?.show(); });
      const suffix = pendingReport ? '?' + new URLSearchParams(pendingReport) : '';
      pendingReport = undefined;
      void window.loadURL(uiOrigin + '/' + suffix).catch(error => console.error(error));
      return;
    }
    sendReport();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const report = reportArguments(url);
    if (report) { pendingReport = report; open(); }
  });
  app.on('second-instance', (_event, args) => {
    pendingReport = args.map(reportArguments).find(Boolean) ?? pendingReport;
    open();
  });
  app.on('activate', open);
  app.on('window-all-closed', () => {});

  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  app.dock?.setIcon(appIcon);
  const directory = app.getPath('userData');
  prepareProfileDirectory(directory, !explicitDirectory);
  process.env.PULSE_RUSSIAN_CA_FILE ||= join(directory, 'cert', russianCaFilename);
  const { path: database, release: releaseDatabase } = ownDatabase(join(directory, 'pulse.sqlite3'));
  app.once('will-quit', releaseDatabase);
  const staging = await openStagingJournal(dirname(database));
  await staging.recover();
  const preferences = await desktopPreferences(directory);
  const requestSecrets = desktopRequestSecrets(directory, safeStorage);
  const store = new Store(database);
  const catalog = new CatalogService(database);
  const tasks = new DatabaseTasks(database);
  catalog.start();
  const api = createApp({
    store, catalog, tasks, requestSecrets,
    smtpConfigured: () => !!preferences.getSender(), schedulesPaused: () => !preferences.schedulesEnabled(),
    onRunStopped: runId => stopWorker.cancelRun(runId),
  });
  await api.ready();
  protocol.handle('pulse-app', asset);
  const stopWorker = startBackground(store, { tasks, requestSecrets,
    getSend: preferences.getSender, schedulesEnabled: preferences.schedulesEnabled,
  });

  function stop() {
    stopTask ??= (async () => {
      await Promise.all([stopWorker(), Promise.allSettled(pendingRequests)]);
      try { await Promise.all([api.close(), catalog.close()]); }
      finally { await tasks.close(); store.close(); }
    })();
    return stopTask;
  }

  function exit() {
    allowExit = true;
    tray?.destroy();
    tray = undefined;
    app.quit();
  }

  function handle<T extends unknown[]>(name: string, listener: (...parameters: T) => Promise<unknown> | unknown,
    shutdownResponse?: typeof DESKTOP_SHUTDOWN) {
    ipcMain.handle(name, (event, ...parameters: T) => {
      const frame = event.senderFrame;
      if (event.sender !== window?.webContents || !frame || frame.parent
        || !frame.url.startsWith(uiOrigin + '/')) {
        throw new Error('Операция доступна из главного окна приложения.');
      }
      if (quitting) {
        if (shutdownResponse) return shutdownResponse;
        throw new Error(DESKTOP_SHUTDOWN.data.error);
      }
      return listener(...parameters);
    });
  }

  function withFileDialog<T>(operation: () => Promise<T>) {
    if (quitting || fileTask) throw new Error('Дождитесь завершения текущей операции с файлом.');
    const task = operation().finally(() => { fileTask = undefined; });
    fileTask = task;
    return task;
  }

  async function saveExport(result: { canceled: boolean; filePath?: string },
    write: (path: string) => Promise<unknown>, kind: 'write' | 'backup' = 'write'): Promise<DesktopSaveResult> {
    if (result.canceled || !result.filePath) return { saved: false };
    try {
      await assertSeparateFile(database, result.filePath);
      await atomicFile(result.filePath, write, staging, kind);
      return { saved: true };
    } catch (error) {
      if (error instanceof ApiError) return { saved: false, error: error.message };
      const code = (error as NodeJS.ErrnoException).code;
      console.error('Не удалось записать файл выгрузки', code ?? 'UNKNOWN');
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        return { saved: false, error: 'Нет прав на запись. Выберите другое место для сохранения.' };
      }
      if (code === 'ENOSPC' || code === 'EDQUOT') {
        return { saved: false, error: 'Не хватает места. Выберите другой диск или освободите место.' };
      }
      return { saved: false, error: 'Не удалось сохранить файл по выбранному пути. Выберите другой файл или папку.' };
    }
  }

  async function saveReportFile(projectName: string, format: ExportFormat, title: string, open: () => Promise<Readable>) {
    const file = reportFile(projectName, format);
    const result = await dialog.showSaveDialog(window!, {
      title, defaultPath: file.name,
      filters: [{ name: format === 'excel' ? 'CSV для Excel' : format.toUpperCase(), extensions: [file.extension] }],
    });
    return saveExport(result, async staged => {
      const stream = await open();
      await pipeline(stream, createWriteStream(staged));
    });
  }

  function showFailure(message: string, error: unknown) {
    if (window && !window.isDestroyed()) {
      return dialog.showMessageBox(window, { type: 'error', message, detail: (error as Error).message });
    }
    dialog.showErrorBox(message, (error as Error).message);
  }

  function saveDatabase() {
    return withFileDialog(async () => {
      const result = await dialog.showSaveDialog(window!, {
        title: 'Экспорт резервной копии', defaultPath: 'pulse-backup.sqlite3',
        filters: [{ name: 'База SQLite', extensions: ['sqlite3', 'sqlite', 'db'] }],
      });
      return saveExport(result, staged => copyDatabase(database, staged), 'backup');
    });
  }

  function restoreDatabase() {
    return withFileDialog(async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Восстановление резервной копии', properties: ['openFile'],
        filters: [{ name: 'База SQLite', extensions: ['sqlite3', 'sqlite', 'db'] }],
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const source = result.filePaths[0];
      await assertSeparateFile(database, source);
      const agreement = await dialog.showMessageBox(window!, {
        type: 'warning', message: 'Заменить текущую базу?',
        detail: 'Текущая база будет сохранена в резервную копию. После перезапуска расписания будут приостановлены. Незавершённые проверки из копии не продолжатся. Уже полученные результаты сохранятся.',
        buttons: ['Отмена', 'Восстановить'], defaultId: 0, cancelId: 0,
      });
      if (agreement.response !== 1) return false;
      const progress = (phase: BackupPhase | null) => {
        if (window && !window.isDestroyed()) window.webContents.send('pulse:backup-progress', phase);
      };
      const staged = await prepareImport(source, dirname(database), progress, staging).catch(error => {
        progress(null);
        throw error;
      });
      const wasQuitting = quitting;
      if (wasQuitting) { await staged.dispose().catch(console.error); progress(null); return false; }
      progress('replace');
      quitting = true;
      let previousScheduleState: boolean | undefined;
      try {
        await preferencesTask;
        await stop();
        await createBackup(database, join(dirname(database), `pulse-before-import-${Date.now()}.sqlite3`), staging);
        previousScheduleState = preferences.schedulesEnabled();
        await preferences.setSchedulesEnabled(false);
        await rename(staged.file, database);
      } catch (error) {
        if (!stopTask) {
          quitting = false;
          throw error;
        }
        if (previousScheduleState !== undefined) {
          await preferences.setSchedulesEnabled(previousScheduleState).catch(console.error);
        }
        await showFailure('Не удалось восстановить резервную копию', error);
        app.relaunch();
        exit();
        throw error;
      } finally { await staged.dispose().catch(console.error); progress(null); }
      app.relaunch();
      exit();
      return true;
    });
  }

  const fileAction = (operation: () => Promise<boolean | DesktopSaveResult>) => () => {
    if (quitting) return;
    open();
    void Promise.resolve().then(operation).then(result => {
      if (typeof result !== 'boolean' && !result.saved && result.error) throw new Error(result.error);
    }).catch(error => showFailure('Операция с базой Пульса URL', error));
  };

  handle('pulse:navigation-ready', () => {
    navigationReady = true;
    sendReport();
  });
  handle('pulse:request', (input: DesktopRequest) => {
    const request = desktopRequest(input);
    const pending = api.inject({
      method: request.method, url: request.path, payload: request.body,
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
    }).then(response => ({ status: response.statusCode, data: response.json() }));
    pendingRequests.add(pending);
    return pending.finally(() => { pendingRequests.delete(pending); });
  }, DESKTOP_SHUTDOWN);
  handle('pulse:open-address', async (projectId: number, addressId: number) => {
    if (![projectId, addressId].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Недопустимый адрес.');
    }
    const { url } = store.address(projectId, addressId);
    await shell.openExternal(normalizeUrl(url));
  });
  handle('pulse:export-report', (path: string, format: ExportFormat, filters?: unknown) => withFileDialog(async () => {
    const kind = exportFormat(format);
    const { projectId, ...scope } = exportScope(path);
    const project = store.project(projectId);
    const requestedFilters = parseReportFilters(filters);
    return saveReportFile(project.name, kind, 'Экспорт отчёта',
      () => openReportStream(store, projectId, scope, requestedFilters, kind, tasks));
  }));
  handle('pulse:export-comparison', (project: unknown, input: unknown, format: unknown) => withFileDialog(async () => {
    const projectId = catalogId(project);
    const kind = exportFormat(format);
    const comparison = parseComparisonInput(input);
    return saveReportFile(store.project(projectId).name, kind, 'Экспорт сравнения',
      () => openComparisonStream(store, projectId, comparison, kind, tasks));
  }));
  handle('pulse:pick-catalog', (project: number, source?: number) => withFileDialog(async () => {
    const projectId = catalogId(project);
    const sourceId = source === undefined ? undefined : catalogId(source);
    store.project(projectId);
    const result = await dialog.showOpenDialog(window!, {
      title: 'Импорт sitemap', properties: ['openFile'],
      filters: [{ name: 'Sitemap XML или GZIP', extensions: ['xml', 'gz'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { sourceId: catalog.pick(projectId, result.filePaths[0], sourceId).sourceId };
  }));
  handle('pulse:export-catalog', (project: number, input: unknown, selection?: unknown) => withFileDialog(async () => {
    const projectId = catalogId(project);
    const filter = catalogFilter(input);
    const selected = chosenUrls(selection);
    const file = reportFile(store.project(projectId).name, 'csv');
    const result = await dialog.showSaveDialog(window!, {
      title: 'Экспорт каталога sitemap', defaultPath: file.name,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    return saveExport(result, staged => pipeline(catalog.csv(projectId, filter, selected), createWriteStream(staged)));
  }));
  handle('pulse:export-backup', saveDatabase);
  handle('pulse:import-backup', restoreDatabase);
  handle('pulse:get-preferences', preferences.get);
  handle('pulse:save-preferences', (input: SaveDesktopPreferences) => {
    if (preferencesTask) throw new Error('Сохранение настроек уже выполняется.');
    preferencesTask = preferences.save(input).finally(() => { preferencesTask = undefined; });
    return preferencesTask;
  });

  if (app.isPackaged && process.platform === 'win32') {
    app.setAppUserModelId('ru.pulseurl.desktop');
    if (process.env.PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION !== '1') app.setAsDefaultProtocolClient('pulse-url');
  }

  const menu = [
    { label: 'Открыть Пульс URL', click: open },
    { label: 'Экспорт резервной копии…', click: fileAction(saveDatabase) },
    { label: 'Восстановить резервную копию…', click: fileAction(restoreDatabase) },
    { type: 'separator' as const },
    { label: 'Выход', click: () => app.quit() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Пульс URL', submenu: menu }, { role: 'editMenu' }]));
  const trayImage = process.platform === 'darwin'
    ? nativeImage.createFromPath(join(desktopAssets, 'pulse-tray-template.png'))
    : appIcon.resize({ width: 20, height: 20, quality: 'best' });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setToolTip('Пульс URL');
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on('click', open);
  app.on('before-quit', event => {
    if (allowExit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.allSettled([fileTask, preferencesTask])
      .then(stop)
      .catch(error => console.error(error))
      .finally(exit);
  });
  booted = true;
  open();
}
