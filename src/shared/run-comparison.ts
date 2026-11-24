import type { Result, Run } from './types.js';

export const comparisonFlags = {
  regression: 'Новые сбои',
  recovered: 'Восстановления',
  httpChanged: 'Изменился HTTP-код',
  destinationChanged: 'Изменился конечный URL',
  errorChanged: 'Изменилась причина ошибки',
  slower: 'Замедления',
  addressChanged: 'Адрес изменён',
  baselineOnly: 'Только в первом прогоне',
  targetOnly: 'Только во втором прогоне',
  unchecked: 'Не проверен',
  unknownCoverage: 'Нет данных о составе',
} as const;

export type ComparisonFlag = keyof typeof comparisonFlags;
export type ComparisonKind = 'differences' | 'all' | 'same' | ComparisonFlag;

export interface ComparisonPair { baseline: number; target: number }
export interface ComparisonFilters { q?: string; kind?: ComparisonKind }
export type ComparisonInput = ComparisonPair & ComparisonFilters;

export type ComparisonSide =
  | { state: 'checked'; result: Result }
  | { state: 'unchecked'; url: string; label: string; version: number }
  | { state: 'absent' | 'unknown' };

export interface ComparisonRow {
  urlId: number;
  baseline: ComparisonSide;
  target: ComparisonSide;
  flags: ComparisonFlag[];
  durationDeltaMs: number | null;
}

export interface ComparisonSummary {
  baseline: Run;
  target: Run;
  total: number;
  differences: number;
  counts: Record<ComparisonFlag, number>;
}

export interface ComparisonPage {
  items: ComparisonRow[];
  nextAfter: number | null;
}

export function isComparisonKind(value: unknown): value is ComparisonKind {
  return value === 'differences' || value === 'all' || value === 'same'
    || (typeof value === 'string' && Object.hasOwn(comparisonFlags, value));
}

export function comparisonParams(input: Partial<ComparisonInput>) {
  const params = new URLSearchParams();
  if (input.baseline !== undefined) params.set('baseline', String(input.baseline));
  if (input.target !== undefined) params.set('target', String(input.target));
  if (input.kind && input.kind !== 'differences') params.set('kind', input.kind);
  if (input.q) params.set('q', input.q);
  return params;
}

export function canCompareRun(run: Pick<Run, 'status' | 'completed'>) {
  return (run.status === 'done' || run.status === 'cancelled') && run.completed > 0;
}
