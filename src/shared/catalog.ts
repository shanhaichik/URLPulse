export const CATALOG_URL_LIMIT = 1_000_000;
export const CATALOG_FILE_LIMIT = 256 * 1024 * 1024;
export const CATALOG_IMPORT_LIMIT = 2 * 1024 * 1024 * 1024;
export const CATALOG_DOCUMENT_LIMIT = 1000;

export type ImportState = 'upload' | 'queued' | 'running' | 'paused' | 'failed' | 'cancelled' | 'done';
export type CatalogChange = 'all' | 'added' | 'removed' | 'changed';

export interface CatalogSource {
  id: number;
  name: string;
  url: string | null;
  currentId: number | null;
  previousId: number | null;
  count: number;
  added: number;
  changed: number;
  removed: number;
}

export interface CatalogJob {
  id: number;
  sourceId: number;
  createdAt: string;
  state: ImportState;
  records: number;
  uniqueUrls: number;
  duplicates: number;
  invalid: number;
  documentsDone: number;
  documentsTotal: number;
  bytes: number;
  warning: boolean;
  needsFile: boolean;
  error: string | null;
  problemFile: string | null;
}

export interface CatalogJobPage {
  jobs: CatalogJob[];
  next: number | null;
}

export interface CatalogClearPreview {
  projectName: string;
  sources: number;
  publishedUrls: number;
  imports: number;
  activeImports: number;
  transferActive: boolean;
  confirmation: string;
}

export interface CatalogFilter {
  sourceId: number;
  revision?: number;
  domain?: string;
  prefix?: string;
  change?: CatalogChange;
  after?: string;
  direction?: 'asc' | 'desc';
}

export interface CatalogPage {
  revision: number;
  items: { url: string; lastmod: string | null; change: Exclude<CatalogChange, 'all'> | null }[];
  next: string | null;
}

export type CatalogAction = CatalogFilter & { selected?: string[]; limit?: number; action: 'check' | 'add' };

export interface CatalogTransfer {
  id: number;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  processed: number;
  added: number;
  existing: number;
  total: number | null;
  error: string | null;
}
