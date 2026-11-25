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
import { defaultLocale, isLocale, type AppLocale } from '../shared/i18n/index.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { nativeTranslator } from '../shared/i18n/locales/native.js';
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
import { desktopPreferences, readDesktopLocale } from './preferences.js';
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
let activeLocale: AppLocale = defaultLocale;
const text = () => nativeTranslator(activeLocale);

protocol.registerSchemesAsPrivileged([
  { scheme: 'pulse-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch(error => {
    console.error(error);
    const t = text();
    dialog.showErrorBox(t('title'), t('startFailed', {
      detail: translateDiagnostic((error as Error).message, activeLocale),
    }));
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
        title: text()('title'), width: 1280, height: 880, minWidth: 400, minHeight: 550, show: false,
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
  activeLocale = await readDesktopLocale(directory);
  process.env.PULSE_RUSSIAN_CA_FILE ||= join(directory, 'cert', russianCaFilename);
  const { path: database, release: releaseDatabase } = ownDatabase(join(directory, 'pulse.sqlite3'));
  app.once('will-quit', releaseDatabase);
  const staging = await openStagingJournal(dirname(database));
  await staging.recover();
  const preferences = await desktopPreferences(directory);
  activeLocale = preferences.getLocale();
  const requestSecrets = desktopRequestSecrets(directory, safeStorage, () => activeLocale);
  const store = new Store(database);
  const catalog = new CatalogService(database, undefined, { store, secrets: requestSecrets });
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
    respondWhileQuitting = false) {
    ipcMain.handle(name, async (event, ...parameters: T) => {
      const locale = activeLocale;
      const t = nativeTranslator(locale);
      const frame = event.senderFrame;
      if (event.sender !== window?.webContents || !frame || frame.parent
        || !frame.url.startsWith(uiOrigin + '/')) {
        throw new Error(t('mainWindowRequired'));
      }
      if (quitting) {
        if (respondWhileQuitting) return { ...DESKTOP_SHUTDOWN, data: { ...DESKTOP_SHUTDOWN.data, error: t('shuttingDown') } };
        throw new Error(t('shuttingDown'));
      }
      try { return await listener(...parameters); }
      catch (error) {
        if (error instanceof ApiError) throw new Error(translateDiagnostic(error.message, locale), { cause: error });
        throw error;
      }
    });
  }

  function withFileDialog<T>(operation: () => Promise<T>) {
    if (quitting || fileTask) throw new Error(text()('fileBusy'));
    const task = operation().finally(() => { fileTask = undefined; });
    fileTask = task;
    return task;
  }

  async function saveExport(result: { canceled: boolean; filePath?: string },
    write: (path: string) => Promise<unknown>, locale: AppLocale, kind: 'write' | 'backup' = 'write'): Promise<DesktopSaveResult> {
    if (result.canceled || !result.filePath) return { saved: false };
    const t = nativeTranslator(locale);
    try {
      await assertSeparateFile(database, result.filePath);
      await atomicFile(result.filePath, write, staging, kind);
      return { saved: true };
    } catch (error) {
      if (error instanceof ApiError) return { saved: false, error: translateDiagnostic(error.message, locale) };
      const code = (error as NodeJS.ErrnoException).code;
      console.error(t('saveLog'), code ?? 'UNKNOWN');
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        return { saved: false, error: t('writeDenied') };
      }
      if (code === 'ENOSPC' || code === 'EDQUOT') {
        return { saved: false, error: t('diskFull') };
      }
      return { saved: false, error: t('writeFailed') };
    }
  }

  async function saveReportFile(projectName: string, format: ExportFormat, kind: 'exportReport' | 'exportComparison',
    locale: AppLocale, exportLocale: AppLocale | undefined, open: () => Promise<Readable>) {
    const file = reportFile(projectName, format, undefined, exportLocale);
    const t = nativeTranslator(locale);
    const result = await dialog.showSaveDialog(window!, {
      title: t(kind), defaultPath: file.name,
      filters: [{ name: format === 'excel' ? t('excelCsv') : format.toUpperCase(), extensions: [file.extension] }],
    });
    return saveExport(result, async staged => {
      const stream = await open();
      await pipeline(stream, createWriteStream(staged));
    }, locale);
  }

  function showFailure(message: string, error: unknown) {
    if (window && !window.isDestroyed()) {
      return dialog.showMessageBox(window, { type: 'error', message, detail: (error as Error).message });
    }
    dialog.showErrorBox(message, (error as Error).message);
  }

  function saveDatabase() {
    return withFileDialog(async () => {
      const locale = activeLocale;
      const t = nativeTranslator(locale);
      const result = await dialog.showSaveDialog(window!, {
        title: t('exportBackup'), defaultPath: 'pulse-backup.sqlite3',
        filters: [{ name: t('sqliteFile'), extensions: ['sqlite3', 'sqlite', 'db'] }],
      });
      return saveExport(result, staged => copyDatabase(database, staged), locale, 'backup');
    });
  }

  function restoreDatabase() {
    return withFileDialog(async () => {
      const locale = activeLocale;
      const t = nativeTranslator(locale);
      const result = await dialog.showOpenDialog(window!, {
        title: t('restoreBackup'), properties: ['openFile'],
        filters: [{ name: t('sqliteFile'), extensions: ['sqlite3', 'sqlite', 'db'] }],
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const source = result.filePaths[0];
      await assertSeparateFile(database, source, locale);
      const agreement = await dialog.showMessageBox(window!, {
        type: 'warning', message: t('replaceDatabase'), detail: t('replaceDatabaseDetail'),
        buttons: [t('cancel'), t('restore')], defaultId: 0, cancelId: 0,
      });
      if (agreement.response !== 1) return false;
      const progress = (phase: BackupPhase | null) => {
        if (window && !window.isDestroyed()) window.webContents.send('pulse:backup-progress', phase);
      };
      const staged = await prepareImport(source, dirname(database), progress, staging, locale).catch(error => {
        progress(null);
        throw error;
      });
      const wasQuitting = quitting;
      if (wasQuitting) { await staged.dispose().catch(console.error); progress(null); return false; }
      progress('replace');
      quitting = true;
      let previousScheduleState: boolean | undefined;
      try {
        await preferences.waitForWrites();
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
        await showFailure(t('restoreFailed'), error);
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
    }).catch(error => showFailure(text()('databaseAction'), error));
  };

  handle('pulse:navigation-ready', () => {
    navigationReady = true;
    sendReport();
  });
  handle('pulse:request', (input: DesktopRequest) => {
    const request = desktopRequest(input, activeLocale);
    const pending = api.inject({
      method: request.method, url: request.path, payload: request.body,
      headers: {
        ...(request.body !== undefined && { 'content-type': 'application/json' }),
        ...(request.i18n && { 'x-urlpulse-i18n': '1' }),
      },
    }).then(response => ({ status: response.statusCode, data: response.json() }));
    pendingRequests.add(pending);
    return pending.finally(() => { pendingRequests.delete(pending); });
  }, true);
  handle('pulse:open-address', async (projectId: number, addressId: number) => {
    if (![projectId, addressId].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error(text()('invalidAddress'));
    }
    const { url } = store.address(projectId, addressId);
    await shell.openExternal(normalizeUrl(url));
  });
  function reportLocale(requested: unknown) {
    if (requested !== undefined && !isLocale(requested)) throw new Error(text()('chooseLocale'));
    return { dialogLocale: requested ?? activeLocale, exportLocale: requested };
  }

  handle('pulse:export-report', (path: string, format: ExportFormat, filters?: unknown, locale?: unknown) => withFileDialog(async () => {
    const { dialogLocale, exportLocale } = reportLocale(locale);
    const kind = exportFormat(format);
    const { projectId, ...scope } = exportScope(path, dialogLocale);
    const project = store.project(projectId);
    const requestedFilters = parseReportFilters(filters);
    return saveReportFile(project.name, kind, 'exportReport', dialogLocale, exportLocale,
      () => openReportStream(store, projectId, scope, requestedFilters, kind, tasks, exportLocale));
  }));
  handle('pulse:export-comparison', (project: unknown, input: unknown, format: unknown, locale?: unknown) => withFileDialog(async () => {
    const { dialogLocale, exportLocale } = reportLocale(locale);
    const projectId = catalogId(project);
    const kind = exportFormat(format);
    const comparison = parseComparisonInput(input);
    return saveReportFile(store.project(projectId).name, kind, 'exportComparison', dialogLocale, exportLocale,
      () => openComparisonStream(store, projectId, comparison, kind, tasks, exportLocale));
  }));
  handle('pulse:pick-catalog', (project: number, source?: number) => withFileDialog(async () => {
    const t = text();
    const projectId = catalogId(project);
    const sourceId = source === undefined ? undefined : catalogId(source);
    store.project(projectId);
    const result = await dialog.showOpenDialog(window!, {
      title: t('importSitemap'), properties: ['openFile'],
      filters: [{ name: t('sitemapFiles'), extensions: ['xml', 'gz'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { sourceId: catalog.pick(projectId, result.filePaths[0], sourceId).sourceId };
  }));
  handle('pulse:export-catalog', (project: number, input: unknown, selection?: unknown) => withFileDialog(async () => {
    const locale = activeLocale;
    const projectId = catalogId(project);
    const filter = catalogFilter(input);
    const selected = chosenUrls(selection);
    const file = reportFile(store.project(projectId).name, 'csv');
    const result = await dialog.showSaveDialog(window!, {
      title: nativeTranslator(locale)('exportSitemap'), defaultPath: file.name,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    return saveExport(result, staged => pipeline(catalog.csv(projectId, filter, selected), createWriteStream(staged)), locale);
  }));
  handle('pulse:export-backup', saveDatabase);
  handle('pulse:import-backup', restoreDatabase);
  handle('pulse:get-preferences', preferences.get);
  handle('pulse:save-preferences', (input: SaveDesktopPreferences) => {
    if (preferencesTask) throw new Error(text()('preferencesBusy'));
    preferencesTask = preferences.save(input).finally(() => { preferencesTask = undefined; });
    return preferencesTask;
  });
  async function changeLocale(input: unknown) {
    const locale = await preferences.setLocale(input);
    if (locale === activeLocale) return locale;
    activeLocale = locale;
    refreshNativeUi();
    if (window && !window.isDestroyed()) window.webContents.send('pulse:locale-changed', locale);
    return locale;
  }
  handle('pulse:get-locale', preferences.getLocale);
  handle('pulse:set-locale', changeLocale);

  if (app.isPackaged && process.platform === 'win32') {
    app.setAppUserModelId('ru.pulseurl.desktop');
    if (process.env.PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION !== '1') app.setAsDefaultProtocolClient('pulse-url');
  }

  function refreshNativeUi() {
    const t = text();
    const title = t('title');
    const separator = { type: 'separator' } as const;
    const languageOption = (locale: AppLocale, label: string): Electron.MenuItemConstructorOptions => ({
      label, type: 'radio', checked: locale === activeLocale,
      click: () => {
        if (quitting) return;
        void changeLocale(locale).catch(error => {
          refreshNativeUi();
          void showFailure(text()('title'), error);
        });
      },
    });
    const menu: Electron.MenuItemConstructorOptions[] = [
      { label: t('open'), click: open },
      { label: t('exportBackupMenu'), click: fileAction(saveDatabase) },
      { label: t('restoreBackupMenu'), click: fileAction(restoreDatabase) },
      { label: t('language'), submenu: [languageOption('ru-RU', t('russian')), languageOption('en-US', t('english'))] },
      separator,
      { label: t('quit'), click: () => app.quit() },
    ];
    const edit: Electron.MenuItemConstructorOptions[] = [
      { role: 'undo', label: t('undo') }, { role: 'redo', label: t('redo') }, separator,
      { role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') },
    ];
    if (process.platform === 'darwin') {
      edit.push({ role: 'pasteAndMatchStyle', label: t('pasteAndMatchStyle') },
        { role: 'delete', label: t('delete') }, { role: 'selectAll', label: t('selectAll') }, separator,
        { label: t('speech'), submenu: [
          { role: 'startSpeaking', label: t('startSpeaking') }, { role: 'stopSpeaking', label: t('stopSpeaking') },
        ] });
    } else {
      edit.push({ role: 'delete', label: t('delete') }, separator, { role: 'selectAll', label: t('selectAll') });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: title, submenu: menu },
      { label: t('edit'), role: 'editMenu', submenu: edit }]));
    tray?.setToolTip(title);
    tray?.setContextMenu(Menu.buildFromTemplate(menu));
    if (window && !window.isDestroyed()) window.setTitle(title);
  }

  const trayImage = process.platform === 'darwin'
    ? nativeImage.createFromPath(join(desktopAssets, 'pulse-tray-template.png'))
    : appIcon.resize({ width: 20, height: 20, quality: 'best' });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  refreshNativeUi();
  tray.on('click', open);
  app.on('before-quit', event => {
    if (allowExit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.allSettled([fileTask, preferences.waitForWrites()])
      .then(stop)
      .catch(error => console.error(error))
      .finally(exit);
  });
  booted = true;
  open();
}
