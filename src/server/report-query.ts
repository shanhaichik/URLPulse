import type { SQLInputValue } from 'node:sqlite';
import { reportChanges, type ReportChange, type ReportFilters } from '../shared/reports.js';
import { ApiError } from './store.js';

export function parseReportFilters(input: unknown): ReportFilters {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Проверьте фильтры отчёта.');
  const { q, status, httpCode, change } = input as Record<string, unknown>;
  if (q !== undefined && (typeof q !== 'string' || q.length > 512 || /[\x00-\x1f]/.test(q))) {
    throw new ApiError(400, 'Введите до 512 символов для поиска.');
  }
  if (status !== undefined && status !== 'ok' && status !== 'error') throw new ApiError(400, 'Выберите статус проверки.');
  if (httpCode !== undefined && !((typeof httpCode === 'number' || typeof httpCode === 'string')
    && /^[1-5]\d{2}$/.test(String(httpCode)))) throw new ApiError(400, 'Введите HTTP-код от 100 до 599.');
  if (change !== undefined && (typeof change !== 'string' || !Object.hasOwn(reportChanges, change))) {
    throw new ApiError(400, 'Выберите тип изменения.');
  }
  return { q: q?.trim() || undefined, status, httpCode: httpCode === undefined ? undefined : Number(httpCode),
    change: change as ReportChange | undefined };
}

const changes = {
  regression: "p.status='ok' AND r.status='error'",
  recovered: "p.status='error' AND r.status='ok'",
  changed: 'r.status=p.status AND (r.http_code IS NOT p.http_code OR r.final_url IS NOT p.final_url)',
} satisfies Record<ReportChange, string>;

export const comparisonJoin = `LEFT JOIN results p ON p.id=(
  SELECT earlier.id FROM results earlier JOIN runs history ON history.id=earlier.run_id
  WHERE earlier.url_id=r.url_id AND earlier.version=r.version AND earlier.checked_at IS NOT NULL
    AND (earlier.checked_at,earlier.id)<(r.checked_at,r.id) AND history.status='done'
  ORDER BY earlier.checked_at DESC, earlier.id DESC LIMIT 1
)`;

export const comparisonFields = `CASE WHEN ${changes.regression} THEN 'regression' WHEN ${changes.recovered} THEN 'recovered'
      WHEN ${changes.changed} THEN 'changed' END AS change,
      p.http_code AS previousHttpCode,p.final_url AS previousFinalUrl`;

export function resultFilters(filters: ReportFilters) {
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [];
  if (filters.status) { conditions.push('r.status=?'); parameters.push(filters.status); }
  if (filters.httpCode) { conditions.push('r.http_code=?'); parameters.push(filters.httpCode); }
  if (filters.q) {
    const search = filters.q.toLocaleLowerCase('ru');
    conditions.push("(instr(lower(r.url),?)>0 OR (r.label<>'' AND instr(fold_address_label(r.label),?)>0))");
    parameters.push(search, search);
  }
  if (filters.change) conditions.push('(' + changes[filters.change] + ')');
  return { conditions, parameters };
}
