import { Readable } from 'node:stream';
import type { ExportFormat } from '../shared/desktop.js';
import { comparisonFlags, type ComparisonInput, type ComparisonRow, type ComparisonSide } from '../shared/run-comparison.js';
import type { Run } from '../shared/types.js';
import type { DatabaseTasks } from './database-tasks.js';
import { escapeCsv } from './export.js';
import type { Store } from './store.js';

const sideHeaders = {
  RunId: 'ID прогона',
  RunDate: 'Дата запуска (ISO 8601)',
  RunFinishedAt: 'Дата завершения (ISO 8601)',
  RunStatus: 'Статус прогона',
  RunGroup: 'Рабочая группа',
  TlsProfile: 'Профиль HTTPS',
  State: 'Наличие результата',
  Version: 'Версия адреса',
  Url: 'URL',
  Label: 'Название',
  Status: 'Доступность',
  HttpCode: 'HTTP-код',
  DurationMs: 'Время ответа (мс)',
  CheckedAt: 'Дата проверки (ISO 8601)',
  FinalUrl: 'Конечный URL',
  Redirects: 'Перенаправления',
  ContentType: 'Тип содержимого',
  ContentLength: 'Размер (байт)',
  ErrorKind: 'Тип ошибки',
  TlsCode: 'Код TLS',
  AccessHint: 'Диагностика доступа',
  Error: 'Ошибка',
  RequestProfile: 'Профиль запроса',
  RequestRoute: 'Маршрут запроса',
  FailureStage: 'Этап ошибки',
  ProxyHttpCode: 'Код прокси',
  RequestProxy: 'Адрес прокси',
  RequestSource: 'Источник маршрута',
};
const sideFields = Object.keys(sideHeaders) as (keyof typeof sideHeaders)[];
const sideLabels = { checked: 'Проверен', unchecked: 'Не проверен', absent: 'Вне прогона', unknown: 'Нет данных о составе' };
const statusLabels = { ok: 'Доступен', error: 'Ошибка', pending: 'Не проверен' };
const runStatusLabels = { done: 'Завершён', cancelled: 'Остановлен', running: 'Выполняется', queued: 'В очереди' };

function sideCells(run: Run, side: ComparisonSide, excel: boolean) {
  const check = side.state === 'checked' ? side.result : undefined;
  const address = side.state === 'unchecked' ? side : check;
  const cells: Record<keyof typeof sideHeaders, string | number | null | undefined> = {
    RunId: run.id,
    RunDate: run.createdAt,
    RunFinishedAt: run.finishedAt,
    RunStatus: excel ? runStatusLabels[run.status] : run.status,
    RunGroup: run.group?.name,
    TlsProfile: run.tlsProfile,
    State: excel ? sideLabels[side.state] : side.state,
    Version: address?.version,
    Url: address?.url,
    Label: address?.label,
    Status: excel && check ? statusLabels[check.status] : check?.status,
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
    Error: check?.error,
    RequestProfile: check?.requestProfile,
    RequestRoute: check?.requestRoute,
    FailureStage: check?.failureStage,
    ProxyHttpCode: check?.proxyHttpCode,
    RequestProxy: check?.requestProxy,
    RequestSource: check?.requestSource,
  };
  return sideFields.map(field => cells[field]);
}

async function* encode(rows: AsyncIterable<ComparisonRow>, baseline: Run, target: Run, format: ExportFormat) {
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

  const excel = format === 'excel';
  const separator = excel ? ';' : ',';
  const columns = excel
    ? ['ID адреса', 'Изменения', 'Разница времени ответа (мс)',
      ...sideFields.map(field => 'Было · ' + sideHeaders[field]), ...sideFields.map(field => 'Стало · ' + sideHeaders[field])]
    : ['urlId', 'flags', 'durationDeltaMs',
      ...sideFields.map(field => 'baseline' + field), ...sideFields.map(field => 'target' + field)];
  yield '\uFEFF' + columns.join(separator) + '\r\n';
  for await (const row of rows) {
    const flags = row.flags.map(flag => excel ? comparisonFlags[flag] : flag).join(' | ');
    const cells = [row.urlId, flags, row.durationDeltaMs,
      ...sideCells(baseline, row.baseline, excel), ...sideCells(target, row.target, excel)];
    yield cells.map(escapeCsv).join(separator) + '\r\n';
  }
}

export async function openComparisonStream(store: Store, projectId: number, input: ComparisonInput,
  format: ExportFormat, tasks?: DatabaseTasks) {
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

  const stream = Readable.from(encode(rows(), baseline, target, format), { objectMode: false });
  // A destination can close before the first row or even the header is requested.
  stream.once('close', () => { void close().catch(() => {}); });
  return stream;
}
