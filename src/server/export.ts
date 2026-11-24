import { Readable } from 'node:stream';
import type { ExportFormat } from '../shared/desktop.js';
import type { DatabaseTasks } from './database-tasks.js';
import { ApiError, type ExportScope, type Store } from './store.js';
import { reportChanges, type ReportFilters, type ReportResult } from '../shared/reports.js';
import type { Result } from '../shared/types.js';

const fields = [
  'id', 'runId', 'urlId', 'version', 'url', 'label', 'status', 'httpCode', 'durationMs',
  'finalUrl', 'redirects', 'contentType', 'contentLength', 'errorKind', 'tlsCode', 'accessHint', 'error', 'checkedAt',
  'requestProfile', 'requestRoute', 'failureStage', 'proxyHttpCode', 'requestProxy', 'requestSource',
] as const satisfies readonly (keyof Result)[];

type ExportRow = Result & Partial<Pick<ReportResult, 'change' | 'previousHttpCode' | 'previousFinalUrl'>>;
const comparisonFields = ['change', 'previousHttpCode', 'previousFinalUrl'] as const;
const comparisonHeaders = ['Изменение', 'Предыдущий HTTP-код', 'Предыдущий конечный URL'];

export function escapeCsv(value: string | number | null | undefined) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[\t\r\n]/.test(value) || /^[=+\-@]/.test(value.trimStart()) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

const excelHeaders: Record<typeof fields[number], string> = {
  id: 'ID', runId: 'Запуск', urlId: 'ID адреса', version: 'Версия адреса', url: 'URL', label: 'Название',
  status: 'Статус', httpCode: 'HTTP-код', durationMs: 'Время ответа (мс)', finalUrl: 'Конечный URL',
  redirects: 'Переходы', contentType: 'Тип содержимого', contentLength: 'Размер (байт)', errorKind: 'Тип ошибки',
  tlsCode: 'Код TLS', accessHint: 'Диагностика доступа', error: 'Ошибка', checkedAt: 'Дата проверки (ISO 8601)',
  requestProfile: 'Профиль запроса', requestRoute: 'Маршрут запроса', failureStage: 'Этап ошибки', proxyHttpCode: 'Код прокси',
  requestProxy: 'Адрес прокси', requestSource: 'Источник маршрута',
};

export function exportFormat(value: unknown): ExportFormat {
  if (value === 'csv' || value === 'json' || value === 'excel') return value;
  throw new ApiError(400, 'Выберите CSV, CSV для Excel или JSON.');
}

export function reportFile(projectName: string, format: ExportFormat, at = new Date()) {
  const extension = format === 'excel' ? 'csv' : format;
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  const prefix = `${at.getFullYear()}-${month}-${day} - `;
  const cleaned = Buffer.from(projectName).toString('utf8').normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  let remaining = 255 - Buffer.byteLength(prefix + '.' + extension);
  let title = '';
  for (const character of cleaned) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    title += character;
  }
  return { extension, name: prefix + (title.replace(/[. ]+$/u, '') || 'Проект') + '.' + extension };
}

export function downloadDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]+|["\\%]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function* encode(rows: Iterable<ExportRow> | AsyncIterable<ExportRow>, format: ExportFormat, comparison: boolean) {
  if (format !== 'json') {
    const separator = format === 'excel' ? ';' : ',';
    const columns: string[] = format === 'excel' ? fields.map(field => excelHeaders[field]) : [...fields];
    if (comparison) columns.push(...(format === 'excel' ? comparisonHeaders : comparisonFields));
    yield '\uFEFF' + columns.join(separator) + '\r\n';
    for await (const row of rows) {
      const cells = fields.map(field => escapeCsv(row[field]));
      if (comparison) cells.push(
        escapeCsv(format === 'excel' && row.change ? reportChanges[row.change] : row.change),
        escapeCsv(row.previousHttpCode), escapeCsv(row.previousFinalUrl),
      );
      yield cells.join(separator) + '\r\n';
    }
  } else {
    yield '[';
    let separator = '';
    for await (const row of rows) {
      yield separator + JSON.stringify(row);
      separator = ',\n';
    }
    yield ']\n';
  }
}

export function exportStream(rows: Iterable<ExportRow> | AsyncIterable<ExportRow>, format: ExportFormat, comparison = false) {
  return Readable.from(encode(rows, format, comparison), { objectMode: false });
}

export async function openReportRows(store: Store, project: number, scope: ExportScope, filters: ReportFilters, tasks?: DatabaseTasks) {
  const id = await (tasks?.run('beginExport', project, scope, filters) ?? store.beginExport(project, scope, filters));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(async () => {
    if (tasks) await tasks.run('endExport', id);
    else store.endExport(id);
  });
  return {
    close,
    async *[Symbol.asyncIterator]() {
      let before = Number.MAX_SAFE_INTEGER;
      try {
        for (;;) {
          const rows = await (tasks?.run('readExport', id, before) ?? store.readExport(id, before));
          if (!rows.length) return;
          yield* rows;
          before = rows.at(-1)!.id;
        }
      } finally { await close(); }
    },
  };
}

export async function openReportStream(store: Store, project: number, scope: ExportScope, filters: ReportFilters,
  format: ExportFormat, tasks?: DatabaseTasks) {
  const rows = await openReportRows(store, project, scope, filters, tasks);
  const stream = exportStream(rows, format, scope.runId !== undefined);
  // The iterator may never start if the destination closes before reading the header.
  stream.once('close', () => { void rows.close().catch(() => {}); });
  return stream;
}
