import { Readable } from 'node:stream';
import type { ExportFormat } from '../shared/desktop.js';
import type { DatabaseTasks } from './database-tasks.js';
import { ApiError, type ExportScope, type Store } from './store.js';
import type { ReportFilters, ReportResult } from '../shared/reports.js';
import type { Result } from '../shared/types.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createTranslator, defaultLocale, type AppLocale } from '../shared/i18n/index.js';
import { exportMessages } from '../shared/i18n/locales/export.js';

const fields = [
  'id', 'runId', 'urlId', 'version', 'url', 'label', 'status', 'httpCode', 'durationMs',
  'finalUrl', 'redirects', 'contentType', 'contentLength', 'errorKind', 'tlsCode', 'accessHint', 'error', 'checkedAt',
  'requestProfile', 'requestRoute', 'failureStage', 'proxyHttpCode', 'requestProxy', 'requestSource',
] as const satisfies readonly (keyof Result)[];

type ExportRow = Result & Partial<Pick<ReportResult, 'change' | 'previousHttpCode' | 'previousFinalUrl'>>;
const comparisonFields = ['change', 'previousHttpCode', 'previousFinalUrl'] as const;

export function escapeCsv(value: string | number | null | undefined) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[\t\r\n]/.test(value) || /^[=+\-@]/.test(value.trimStart()) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function exportFormat(value: unknown): ExportFormat {
  if (value === 'csv' || value === 'json' || value === 'excel') return value;
  throw new ApiError(400, 'Выберите CSV, CSV для Excel или JSON.');
}

export function reportFile(projectName: string, format: ExportFormat, at = new Date(), locale: AppLocale = defaultLocale) {
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
  const filenameLocale = format === 'excel' ? locale : defaultLocale;
  const name = title.replace(/[. ]+$/u, '') || createTranslator(filenameLocale, 'export', exportMessages)('project');
  return { extension, name: prefix + name + '.' + extension };
}

export function downloadDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]+|["\\%]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function* encode(rows: Iterable<ExportRow> | AsyncIterable<ExportRow>, format: ExportFormat, comparison: boolean, locale?: AppLocale) {
  if (format !== 'json') {
    const excel = format === 'excel';
    const excelLocale = excel ? locale : undefined;
    const t = createTranslator(excelLocale ?? defaultLocale, 'export', exportMessages);
    const separator = excel ? ';' : ',';
    const columns: string[] = excel ? fields.map(field => t(`field_${field}`)) : [...fields];
    if (comparison) columns.push(...(excel ? [t('change'), t('previousHttp'), t('previousUrl')] : comparisonFields));
    yield '\uFEFF' + columns.join(separator) + '\r\n';
    for await (const row of rows) {
      const cells = fields.map(field => {
        if (excelLocale && field === 'status') return escapeCsv(t(`result_${row.status}`));
        if (excelLocale && field === 'error' && row.error) return escapeCsv(translateDiagnostic(row.error, excelLocale));
        return escapeCsv(row[field]);
      });
      if (comparison) cells.push(
        escapeCsv(excel && row.change ? t(`change_${row.change}`) : row.change),
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

export function exportStream(rows: Iterable<ExportRow> | AsyncIterable<ExportRow>, format: ExportFormat, comparison = false, locale?: AppLocale) {
  return Readable.from(encode(rows, format, comparison, locale), { objectMode: false });
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
  format: ExportFormat, tasks?: DatabaseTasks, locale?: AppLocale) {
  const rows = await openReportRows(store, project, scope, filters, tasks);
  const stream = exportStream(rows, format, scope.runId !== undefined, locale);
  // The iterator may never start if the destination closes before reading the header.
  stream.once('close', () => { void rows.close().catch(() => {}); });
  return stream;
}
