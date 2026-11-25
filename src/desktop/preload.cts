import { contextBridge, ipcRenderer } from 'electron';
import type { BackupPhase, DesktopBridge } from '../shared/desktop.js';
import type { AppLocale } from '../shared/i18n/index.js';

const bridge: DesktopBridge = {
  request: input => ipcRenderer.invoke('pulse:request', input),
  onNavigate(listener) {
    const navigate = (_event: Electron.IpcRendererEvent, path: string) => listener(path);
    ipcRenderer.on('pulse:navigate', navigate);
    void ipcRenderer.invoke('pulse:navigation-ready').catch(() => {});
    return () => { ipcRenderer.removeListener('pulse:navigate', navigate); };
  },
  openAddress: (projectId, addressId) => ipcRenderer.invoke('pulse:open-address', projectId, addressId),
  exportReport: (path, format, filters, locale) => ipcRenderer.invoke('pulse:export-report', path, format, filters, locale),
  exportComparison: (projectId, input, format, locale) => ipcRenderer.invoke('pulse:export-comparison', projectId, input, format, locale),
  pickCatalogFile: (projectId, sourceId) => ipcRenderer.invoke('pulse:pick-catalog', projectId, sourceId),
  exportCatalog: (projectId, filter, selected) => ipcRenderer.invoke('pulse:export-catalog', projectId, filter, selected),
  exportBackup: () => ipcRenderer.invoke('pulse:export-backup'),
  importBackup: () => ipcRenderer.invoke('pulse:import-backup'),
  onBackupProgress(listener) {
    const progress = (_event: Electron.IpcRendererEvent, phase: BackupPhase | null) => listener(phase);
    ipcRenderer.on('pulse:backup-progress', progress);
    return () => { ipcRenderer.removeListener('pulse:backup-progress', progress); };
  },
  getPreferences: () => ipcRenderer.invoke('pulse:get-preferences'),
  savePreferences: input => ipcRenderer.invoke('pulse:save-preferences', input),
  getLocale: () => ipcRenderer.invoke('pulse:get-locale'),
  setLocale: locale => ipcRenderer.invoke('pulse:set-locale', locale),
  onLocaleChanged(listener) {
    const change = (_event: Electron.IpcRendererEvent, locale: AppLocale) => listener(locale);
    ipcRenderer.on('pulse:locale-changed', change);
    return () => { ipcRenderer.removeListener('pulse:locale-changed', change); };
  },
};
contextBridge.exposeInMainWorld('pulseDesktop', bridge);
