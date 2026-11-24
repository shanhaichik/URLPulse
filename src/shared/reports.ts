import type { Result, Run } from './types.js';

export const reportChanges = {
  regression: 'Новые сбои',
  recovered: 'Восстановились',
  changed: 'Изменился код или конечный URL',
} as const;

export type ReportChange = keyof typeof reportChanges;

export interface ReportFilters {
  q?: string;
  status?: 'ok' | 'error';
  httpCode?: number;
  change?: ReportChange;
}

export type ReportResult = Result & {
  change: ReportChange | null;
  previousHttpCode: number | null;
  previousFinalUrl: string | null;
};

export type RunRestart = Pick<Run, 'id' | 'total' | 'completed'> & { canRestart: boolean };
export type StoppedRunResponse = Run & { restart: RunRestart | null };

export interface RunView {
  run: Run;
  results: ReportResult[];
  nextAfter: number | null;
  previousRun: Pick<Run, 'id' | 'createdAt'> | null;
  restart: RunRestart | null;
}

export interface RunPage {
  items: Run[];
  nextBefore: number | null;
}

export function reportParams(filters: ReportFilters = {}) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.httpCode) params.set('httpCode', String(filters.httpCode));
  if (filters.change) params.set('change', filters.change);
  return params;
}
