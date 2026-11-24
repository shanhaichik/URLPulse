import { contextBridge, ipcRenderer } from 'electron';
import type { BackupPhase, DesktopBridge } from '../shared/desktop.js';

const bridge: DesktopBridge = {
  request: input => ipcRenderer.invoke('pulse:request', input),
  onNavigate(listener) {
    const navigate = (_event: Electron.IpcRendererEvent, path: string) => listener(path);
    ipcRenderer.on('pulse:navigate', navigate);
    void ipcRenderer.invoke('pulse:navigation-ready').catch(() => {});
    return () => { ipcRenderer.removeListener('pulse:navigate', navigate); };
  },
  openAddress: (projectId, addressId) => ipcRenderer.invoke('pulse:open-address', projectId, addressId),
  exportReport: (path, format, filters) => ipcRenderer.invoke('pulse:export-report', path, format, filters),
  exportComparison: (projectId, input, format) => ipcRenderer.invoke('pulse:export-comparison', projectId, input, format),
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
};
contextBridge.exposeInMainWorld('pulseDesktop', bridge);
