import type { ReportFilters } from './reports.js';
import type { CatalogFilter } from './catalog.js';
import type { ComparisonInput } from './run-comparison.js';
import type { AppLocale } from './i18n/index.js';

export type DesktopMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ExportFormat = 'csv' | 'json' | 'excel';

export const DESKTOP_SHUTDOWN = {
  status: 503,
  data: { code: 'desktop-shutdown', error: 'Приложение завершает работу.' },
} as const;

export interface DesktopRequest {
  path: string;
  method: DesktopMethod;
  body?: string;
  i18n?: true;
}

export interface SmtpFields {
  host: string;
  port: number;
  tlsMode: 'starttls' | 'tls';
  from: string;
  user: string;
}

export interface DesktopPreferences {
  smtp: SmtpFields & { hasPassword: boolean; state: 'empty' | 'configured' | 'unavailable' };
  openAtLogin: boolean | null;
  schedulesEnabled: boolean;
  emailLocale?: AppLocale;
}

export type SaveDesktopPreferences =
  | { section: 'background'; openAtLogin: boolean | null; schedulesEnabled: boolean }
  | { section: 'email-language'; emailLocale: AppLocale }
  | { section: 'smtp'; smtp: (SmtpFields & { password: string }) | null; emailLocale?: AppLocale };

export interface DesktopPreferencesResult {
  preferences: DesktopPreferences;
  loginError?: string;
}

export type DesktopSaveResult = { saved: true } | { saved: false; error?: string };
export type BackupPhase = 'copy' | 'validate' | 'prepare' | 'replace';
export const BACKUP_RUN_INTEGRITY_PREFIX = 'В резервной копии не совпадают счётчики или цели прогона №';
export const BACKUP_RUN_INTEGRITY_PREFIX_EN = 'The backup contains inconsistent counts or targets for run #';

export interface DesktopBridge {
  request(input: DesktopRequest): Promise<{ status: number; data: unknown }>;
  onNavigate(listener: (path: string) => void): () => void;
  openAddress(projectId: number, addressId: number): Promise<void>;
  exportReport(path: string, format: ExportFormat, filters?: ReportFilters, locale?: AppLocale): Promise<DesktopSaveResult>;
  exportComparison(projectId: number, input: ComparisonInput, format: ExportFormat, locale?: AppLocale): Promise<DesktopSaveResult>;
  pickCatalogFile(projectId: number, sourceId?: number): Promise<{ sourceId: number } | null>;
  exportCatalog(projectId: number, filter: CatalogFilter, selected?: string[]): Promise<DesktopSaveResult>;
  exportBackup(): Promise<DesktopSaveResult>;
  importBackup(): Promise<boolean>;
  onBackupProgress(listener: (phase: BackupPhase | null) => void): () => void;
  getPreferences(): Promise<DesktopPreferences>;
  savePreferences(input: SaveDesktopPreferences): Promise<DesktopPreferencesResult>;
  getLocale?(): Promise<AppLocale>;
  setLocale?(locale: AppLocale): Promise<AppLocale>;
  onLocaleChanged?(listener: (locale: AppLocale) => void): () => void;
}

declare global {
  interface Window { pulseDesktop?: DesktopBridge }
}
