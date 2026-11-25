import { Readable } from 'node:stream';
import type { ExportFormat } from '../shared/desktop.js';
import type { ComparisonInput, ComparisonRow, ComparisonSide } from '../shared/run-comparison.js';
import type { Run } from '../shared/types.js';
import type { DatabaseTasks } from './database-tasks.js';
import { escapeCsv } from './export.js';
import type { Store } from './store.js';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { createTranslator, defaultLocale, type AppLocale } from '../shared/i18n/index.js';
import { exportMessages } from '../shared/i18n/locales/export.js';

const sideFields = [
  'RunId', 'RunDate', 'RunFinishedAt', 'RunStatus', 'RunGroup', 'TlsProfile',
  'State', 'Version', 'Url', 'Label', 'Status', 'HttpCode',
  'DurationMs', 'CheckedAt', 'FinalUrl', 'Redirects', 'ContentType', 'ContentLength',
  'ErrorKind', 'TlsCode', 'AccessHint', 'Error', 'RequestProfile', 'RequestRoute',
  'FailureStage', 'ProxyHttpCode', 'RequestProxy', 'RequestSource',
] as const;
type SideField = typeof sideFields[number];
const textForExport = (locale: AppLocale) => createTranslator(locale, 'export', exportMessages);

function sideCells(run: Run, side: ComparisonSide, locale: AppLocale | undefined, t: ReturnType<typeof textForExport>) {
  const check = side.state === 'checked' ? side.result : undefined;
  const address = side.state === 'unchecked' ? side : check;
  const cells: Record<SideField, string | number | null | undefined> = {
    RunId: run.id,
    RunDate: run.createdAt,
    RunFinishedAt: run.finishedAt,
    RunStatus: locale ? t(`run_${run.status}`) : run.status,
    RunGroup: run.group?.name,
    TlsProfile: run.tlsProfile,
    State: locale ? t(`state_${side.state}`) : side.state,
    Version: address?.version,
    Url: address?.url,
    Label: address?.label,
    Status: locale && check ? t(`result_${check.status}`) : check?.status,
    HttpCode: check?.httpCode,
    DurationMs: check?.durationMs,
    CheckedAt: check?.checkedAt,
    FinalUrl: check?.finalUrl,
    Redirects: check?.redirects,
    ContentType: check?.contentType,
    ContentLength: check?.contentLength,
    ErrorKind: check?.errorKind,
    TlsCode: check?.tlsCode,
    AccessHint: check?.accessHint,
    Error: locale && check?.error ? translateDiagnostic(check.error, locale) : check?.error,
    RequestProfile: check?.requestProfile,
    RequestRoute: check?.requestRoute,
    FailureStage: check?.failureStage,
    ProxyHttpCode: check?.proxyHttpCode,
    RequestProxy: check?.requestProxy,
    RequestSource: check?.requestSource,
  };
  return sideFields.map(field => cells[field]);
}

async function* encode(rows: AsyncIterable<ComparisonRow>, baseline: Run, target: Run, format: ExportFormat, locale: AppLocale) {
  if (format === 'json') {
    yield `{"baseline":${JSON.stringify(baseline)},"target":${JSON.stringify(target)},"rows":[`;
    let separator = '';
    for await (const row of rows) {
      yield separator + JSON.stringify(row);
      separator = ',\n';
    }
    yield ']}\n';
    return;
  }

  const t = textForExport(locale);
  const excel = format === 'excel';
  const excelLocale = excel ? locale : undefined;
  const separator = excel ? ';' : ',';
  const columns = excel
    ? [t('field_urlId'), t('changes'), t('durationDelta'),
      ...sideFields.map(field => t('baselineHeader', { field: t(`side_${field}`) })),
      ...sideFields.map(field => t('comparisonHeader', { field: t(`side_${field}`) }))]
    : ['urlId', 'flags', 'durationDeltaMs',
      ...sideFields.map(field => 'baseline' + field), ...sideFields.map(field => 'target' + field)];
  yield '\uFEFF' + columns.join(separator) + '\r\n';
  for await (const row of rows) {
    const flags = row.flags.map(flag => excel ? t(`flag_${flag}`) : flag).join(' | ');
    const cells = [row.urlId, flags, row.durationDeltaMs,
      ...sideCells(baseline, row.baseline, excelLocale, t), ...sideCells(target, row.target, excelLocale, t)];
    yield cells.map(escapeCsv).join(separator) + '\r\n';
  }
}

export async function openComparisonStream(store: Store, projectId: number, input: ComparisonInput,
  format: ExportFormat, tasks?: DatabaseTasks, locale: AppLocale = defaultLocale) {
  const { id, baseline, target } = await (tasks?.run('beginComparisonExport', projectId, input)
    ?? store.beginComparisonExport(projectId, input));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(async () => {
    if (tasks) await tasks.run('endComparisonExport', id);
    else store.endComparisonExport(id);
  });

  async function* rows() {
    let after = 0;
    try {
      for (;;) {
        const batch = await (tasks?.run('readComparisonExport', id, after) ?? store.readComparisonExport(id, after));
        if (!batch.length) return;
        yield* batch;
        after = batch.at(-1)!.urlId;
      }
    } finally { await close(); }
  }

  const stream = Readable.from(encode(rows(), baseline, target, format, locale), { objectMode: false });
  // A destination can close before the first row or even the header is requested.
  stream.once('close', () => { void close().catch(() => {}); });
  return stream;
}
