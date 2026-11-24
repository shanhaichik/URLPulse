import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { Store } from '../src/server/store.js';
import type { CheckResult } from '../src/shared/types.js';
import { seedCompletedRun } from './fixtures/run-results.js';

function run(store: Store, project: number, ids: number[], checks: (Partial<CheckResult> | null)[]) {
  const { id } = store.enqueue(project, ids);
  const claimed = store.claim()!;
  expect(claimed.id).toBe(id);
  let index = 0;
  const partial = checks.some(result => result === null);
  for (let rows = claimed.items; rows.length;) {
    for (const row of rows) {
      const check = checks[index++];
      if (check) store.saveResult(row.id, {
        status: 'ok', httpCode: 200, durationMs: 100, finalUrl: row.url, redirects: 0, contentType: null,
        contentLength: null, errorKind: null, error: null, ...check,
      }, id);
    }
    if (partial) break;
    rows = store.pendingResults(id);
  }
  if (partial) store.stopRun(project, id);
  else store.finish(id);
  return id;
}

function addresses(store: Store, project: number, count: number) {
  store.addUrls(project, Array.from({ length: count }, (_, i) => ({ input: `example.com/row/${i}`, line: i + 1 })));
  return store.addresses(project).map(address => address.id);
}

test('compares the selected pair by historical address version and keeps overlapping diagnostics', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('Сравнение', '');
    const ids = addresses(store, id, 9);
    const baseline = run(store, id, ids, [
      {}, { status: 'error', httpCode: 503, errorKind: 'http' },
      { status: 'error', httpCode: null, errorKind: 'timeout' }, {}, { durationMs: 1000 },
      { durationMs: 600 }, { durationMs: 0 }, { durationMs: 500 }, { durationMs: 1000 },
    ]);
    run(store, id, [ids[0]], [{ status: 'error', httpCode: 401, errorKind: 'http' }]);
    store.editUrl(id, ids[3], 'example.com/new', 'Новая Версия');
    const target = run(store, id, ids, [
      { status: 'error', httpCode: 503, errorKind: 'http', finalUrl: 'https://example.com/redirected' }, {},
      { status: 'error', httpCode: null, errorKind: 'tls', tlsCode: 'CERT_EXPIRED' },
      { status: 'error', httpCode: 500, errorKind: 'http' }, { durationMs: 1299 }, { durationMs: 800 },
      { durationMs: 500 }, { durationMs: 699 }, { durationMs: 1300 },
    ]);
    const pair = { baseline, target };
    const summary = store.comparisonSummary(id, pair);
    expect(summary).toMatchObject({ baseline: { id: baseline }, target: { id: target }, total: 9,
      differences: 6, counts: { regression: 1, recovered: 1, httpChanged: 2, destinationChanged: 1,
        errorChanged: 1, slower: 2, addressChanged: 1 } });
    const page = store.comparisonPage(id, pair);
    const byFlag = new Map(page.items.map(row => [row.urlId, row]));
    expect(byFlag.get(ids[0])?.flags).toEqual(expect.arrayContaining(['regression', 'httpChanged', 'destinationChanged']));
    expect(byFlag.get(ids[2])?.flags).toEqual(['errorChanged']);
    expect(byFlag.get(ids[3])).toMatchObject({ flags: ['addressChanged'], durationDeltaMs: null,
      baseline: { state: 'checked', result: { url: 'https://example.com/row/3', version: 1 } },
      target: { state: 'checked', result: { url: 'https://example.com/new', version: 2 } } });
    expect(store.comparisonPage(id, { ...pair, kind: 'all', q: 'НОВАЯ версия' }).items.map(row => row.urlId)).toEqual([ids[3]]);
    expect(store.comparisonPage(id, { ...pair, kind: 'slower' }).items).toMatchObject([
      { urlId: ids[5], durationDeltaMs: 200 }, { urlId: ids[8], durationDeltaMs: 300 },
    ]);
    expect(store.comparisonPage(id, { ...pair, kind: 'same' }).items.map(row => row.urlId)).toEqual([ids[4], ids[6], ids[7]]);
    expect(store.comparisonPage(id, { baseline: target, target: baseline, kind: 'recovered' }).items[0])
      .toMatchObject({ urlId: ids[0], baseline: { result: { httpCode: 503 } }, target: { result: { httpCode: 200 } } });
  } finally { store.close(); }
});

test('distinguishes known absence, unchecked targets and incomplete legacy coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-comparison-'));
  const file = join(dir, 'pulse.sqlite3');
  const store = new Store(file);
  try {
    const { id } = store.createProject('Остановленные проверки', '');
    const ids = addresses(store, id, 5);
    const baseline = run(store, id, ids.slice(0, 3), [{}, null, null]);
    const target = run(store, id, [ids[0], ids[1], ids[3]], [{}, {}, {}]);
    const pair = { baseline, target };
    const before = store.comparisonPage(id, { ...pair, kind: 'all' });
    expect(before.items).toMatchObject([
      { urlId: ids[0], flags: [] },
      { urlId: ids[1], baseline: { state: 'unchecked' }, flags: ['unchecked'] },
      { urlId: ids[2], baseline: { state: 'unchecked' }, target: { state: 'absent' }, flags: expect.arrayContaining(['baselineOnly', 'unchecked']) },
      { urlId: ids[3], baseline: { state: 'absent' }, flags: ['targetOnly'] },
    ]);
    const legacy = new DatabaseSync(file);
    try { legacy.prepare('DELETE FROM stopped_run_targets WHERE run_id=? AND url_id=?').run(baseline, ids[1]); }
    finally { legacy.close(); }
    const after = store.comparisonPage(id, { ...pair, kind: 'unknownCoverage' });
    expect(after.items.map(row => row.urlId)).toEqual([ids[1], ids[3]]);
    expect(after.items.every(row => row.baseline.state === 'unknown' && !row.flags.includes('targetOnly'))).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('limits run options to eligible project runs and rejects invalid pairs', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('Первый', '');
    const other = store.createProject('Второй', '').id;
    const ids = addresses(store, id, 1);
    const foreign = run(store, other, addresses(store, other, 1), [{}]);
    const complete = Array.from({ length: 26 }, () => run(store, id, ids, [{}]));
    const stopped = run(store, id, ids, [null]);
    const queued = store.enqueue(id, ids).id;
    const options = store.comparisonOptions(id);
    expect(options.items.map(row => row.id)).toEqual(complete.slice(1).reverse());
    expect(store.comparisonOptions(id, options.nextBefore!).items.map(row => row.id)).toEqual([complete[0]]);
    expect(() => store.comparisonSummary(id, { baseline: complete[0], target: foreign })).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => store.comparisonSummary(id, { baseline: 0, target: complete[0] })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => store.comparisonSummary(id, { baseline: complete[0], target: complete[0] })).toThrow(expect.objectContaining({ statusCode: 400 }));
    for (const target of [stopped, queued]) {
      expect(() => store.comparisonSummary(id, { baseline: complete[0], target })).toThrow(expect.objectContaining({ statusCode: 409 }));
    }
  } finally { store.close(); }
});

test('skips an empty historical run when proposing the previous comparison baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-comparison-history-'));
  const file = join(dir, 'pulse.sqlite3');
  const date = '2026-11-23T13:00:00.000Z';
  const store = new Store(file, () => Date.parse(date));
  try {
    const { id } = store.createProject('История', '');
    const ids = addresses(store, id, 1);
    const baseline = run(store, id, ids, [{}]);
    const legacy = new DatabaseSync(file);
    try {
      legacy.prepare("UPDATE id_sequences SET last_id=last_id+1 WHERE entity='run'").run();
      legacy.prepare(`INSERT INTO runs(id,project_id,source,status,created_at,finished_at)
        VALUES (?,?,'manual','done',?,?)`).run(baseline + 1, id, date, date);
    } finally { legacy.close(); }
    const target = run(store, id, ids, [{}]);
    expect(store.report(id, target, {}).previousRun?.id).toBe(baseline);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pages by address id and keeps one export snapshot during deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-comparison-export-'));
  const file = join(dir, 'pulse.sqlite3');
  const store = new Store(file);
  const fixture = new DatabaseSync(file);
  try {
    const { id } = store.createProject('Снимок сравнения', '');
    const ids = addresses(store, id, 510);
    const complete = (httpCode: number) => {
      const runId = store.enqueue(id, ids).id;
      expect(store.claim()?.id).toBe(runId);
      seedCompletedRun(fixture, runId, httpCode, new Date().toISOString());
      store.finish(runId);
      return runId;
    };
    const baseline = complete(200);
    const target = complete(204);
    const pair = { baseline, target, kind: 'httpChanged' as const };
    const page = store.comparisonPage(id, pair);
    expect(page.items.map(row => row.urlId)).toEqual(ids.slice(0, 100));
    expect(store.comparisonPage(id, pair, page.nextAfter!).items.map(row => row.urlId)).toEqual(ids.slice(100, 200));
    const snapshot = await store.beginComparisonExport(id, pair);
    const head = store.readComparisonExport(snapshot.id, 0);
    expect(head.map(row => row.urlId)).toEqual(ids.slice(0, 500));
    store.deleteRun(id, baseline);
    expect(() => store.comparisonPage(id, pair)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(store.readComparisonExport(snapshot.id, head.at(-1)!.urlId).map(row => row.urlId)).toEqual(ids.slice(500));
    store.endComparisonExport(snapshot.id);
    expect(() => store.readComparisonExport(snapshot.id, 0)).toThrow('Снимок сравнения закрыт');
  } finally { fixture.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
