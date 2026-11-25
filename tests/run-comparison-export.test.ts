import { once } from 'node:events';
import { buffer, text } from 'node:stream/consumers';
import { expect, test, vi } from 'vitest';
import { openComparisonStream } from '../src/server/run-comparison-export.js';
import { Store } from '../src/server/store.js';

function fixture(failure = 'HTTP 503') {
  let now = Date.parse('2026-01-01T12:00:00.000Z');
  const store = new Store(':memory:', () => now);
  const { id: projectId } = store.createProject('Сравнение экспорта', '');
  store.addUrls(projectId, [{ input: 'https://example.com/changed', line: 1 }], '=FORMULA("unsafe")');
  store.addUrls(projectId, [{ input: 'https://example.com/quiet', line: 1 }]);
  const complete = (failed: boolean) => {
    const { id } = store.enqueue(projectId);
    for (const item of store.claim()!.items) {
      const regression = failed && item.url.endsWith('/changed');
      store.saveResult(item.id, {
        status: regression ? 'error' : 'ok', httpCode: regression ? 503 : 200, finalUrl: item.url,
        durationMs: regression ? 440 : 120, redirects: 0, errorKind: regression ? 'http' : null,
        error: regression ? failure : null, contentType: 'text/html', contentLength: '123',
      });
    }
    store.finish(id, false);
    now += 3600_000;
    return id;
  };
  return { store, projectId, baseline: complete(false), target: complete(true) };
}

test('streams JSON with the selected pair and only the matching comparisons', async () => {
  const { store, projectId, baseline, target } = fixture();
  try {
    const input = { baseline, target, kind: 'regression' } as const;
    const body = JSON.parse(await text(await openComparisonStream(store, projectId, input, 'json')));
    expect(body).toMatchObject({
      baseline: { id: baseline, createdAt: '2026-01-01T12:00:00.000Z' },
      target: { id: target, createdAt: '2026-01-01T13:00:00.000Z' },
      rows: [{ flags: expect.arrayContaining(['regression', 'httpChanged']),
        baseline: { state: 'checked', result: { url: 'https://example.com/changed', httpCode: 200 } },
        target: { state: 'checked', result: { url: 'https://example.com/changed', httpCode: 503, error: 'HTTP 503' } } }],
    });
    const empty = await text(await openComparisonStream(store, projectId, { ...input, q: 'missing' }, 'json'));
    expect(JSON.parse(empty)).toMatchObject({ baseline: { id: baseline }, target: { id: target }, rows: [] });
  } finally { store.close(); }
});

test.each(['csv', 'excel'] as const)('streams %s with both run dates and neutralizes formula-like labels', async format => {
  const { store, projectId, baseline, target } = fixture();
  try {
    const input = { baseline, target, q: '/changed', kind: 'all' } as const;
    const file = (await buffer(await openComparisonStream(store, projectId, input, format))).toString('utf8');
    const [header, data, trailing] = file.split('\r\n');
    expect(trailing).toBe('');
    expect(file[0]).toBe('\uFEFF');
    expect(header).toContain(format === 'excel' ? 'Было · HTTP-код' : 'baselineHttpCode');
    expect(header).toContain(format === 'excel' ? 'Стало · HTTP-код' : 'targetHttpCode');
    expect(data).toContain('2026-01-01T12:00:00.000Z');
    expect(data).toContain('2026-01-01T13:00:00.000Z');
    expect(data).toContain(format === 'excel' ? 'Новые сбои' : 'regression');
    expect(data).toContain(`"'=FORMULA(""unsafe"")"`);
    expect(file).not.toContain('/quiet');
  } finally { store.close(); }
});

test('closes the comparison snapshot if the destination aborts before reading', async () => {
  const { store, projectId, baseline, target } = fixture();
  try {
    const end = vi.spyOn(store, 'endComparisonExport');
    const stream = await openComparisonStream(store, projectId, { baseline, target }, 'csv');
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
  } finally { store.close(); }
});

test('localizes known diagnostics in English Excel comparisons and preserves raw diagnostics in CSV', async () => {
  const diagnostic = 'Истекло время ожидания ответа.';
  const { store, projectId, baseline, target } = fixture(diagnostic);
  try {
    const input = { baseline, target };
    const excel = async (locale: 'en-US' | 'ru-RU') =>
      (await buffer(await openComparisonStream(store, projectId, input, 'excel', undefined, locale))).toString('utf8');
    const english = await excel('en-US');
    expect(english).toContain('Comparison · HTTP status');
    expect(english).toContain('The request timed out while waiting for a response.');
    expect(english).not.toContain(diagnostic);
    expect(await excel('ru-RU')).toContain(diagnostic);
    expect(await text(await openComparisonStream(store, projectId, input, 'csv', undefined, 'en-US')))
      .toContain(diagnostic);
  } finally { store.close(); }
});
