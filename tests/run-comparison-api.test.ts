import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const setup = () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  afters.push(async () => { await app.close(); store.close(); });
  const project = store.createProject('Сравнение API', '');
  store.addUrls(project.id, [
    { input: 'https://example.com/first', line: 1 },
    { input: 'https://example.com/second', line: 2 },
  ]);
  function finish(firstCode: number) {
    const run = store.enqueue(project.id);
    for (const item of store.claim()!.items) {
      const httpCode = item.url.endsWith('/first') ? firstCode : 200;
      store.saveResult(item.id, {
        status: httpCode === 200 ? 'ok' : 'error', httpCode, durationMs: 30,
        finalUrl: item.url, redirects: 0, contentType: null, contentLength: null,
        errorKind: httpCode === 200 ? null : 'http', error: null,
      });
    }
    store.finish(run.id);
    return run.id;
  }
  const baseline = finish(200);
  const target = finish(503);
  const root = '/api/projects/' + project.id;
  return { app, store, project, baseline, target, root, pair: 'baseline=' + baseline + '&target=' + target };
};

const afters: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of afters.splice(0)) await close();
});

describe('run comparison API', () => {
  it('lists eligible runs, returns whole-pair counts and paginates filtered comparison rows', async () => {
    const { app, store, project, root, pair, baseline, target } = setup();
    const unstarted = store.enqueue(project.id).id;
    const choices = await app.inject(root + '/runs?view=compare-options');
    expect(choices.statusCode).toBe(200);
    expect(choices.json().items.map((run: { id: number }) => run.id)).toEqual([target, baseline]);
    expect(choices.json().items.map((run: { id: number }) => run.id)).not.toContain(unstarted);

    const summary = await app.inject(root + '/run-comparison?' + pair + '&view=summary&q=second');
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      baseline: { id: baseline }, target: { id: target }, total: 2, differences: 1,
      counts: { regression: 1, httpChanged: 1 },
    });

    const changed = await app.inject(root + '/run-comparison?' + pair);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().items).toMatchObject([
      { flags: expect.arrayContaining(['regression', 'httpChanged']),
        baseline: { result: { httpCode: 200 } }, target: { result: { httpCode: 503 } } },
    ]);
    const unchanged = await app.inject(root + '/run-comparison?' + pair + '&kind=same&q=SECOND');
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toMatchObject({ items: [{ flags: [], target: { result: { httpCode: 200 } } }], nextAfter: null });
  });

  it('validates query fields and rejects runs from another project or an active pair', async () => {
    const { app, store, project, root, pair, baseline } = setup();
    const other = store.createProject('Другой проект', '');
    const queued = store.enqueue(project.id).id;
    const url = root + '/run-comparison?';
    for (const invalid of [
      'target=1', 'baseline=0&target=1', 'baseline=1&baseline=2&target=3',
      'baseline=1e2&target=2', `${pair}&kind=invalid`, `${pair}&view=export`,
      `${pair}&after=-1`, `${pair}&q=${'a'.repeat(513)}`, `baseline=${baseline}&target=${baseline}`,
    ]) expect((await app.inject(url + invalid)).statusCode, invalid).toBe(400);
    expect((await app.inject('/api/projects/' + other.id + '/run-comparison?' + pair)).statusCode).toBe(404);
    expect((await app.inject(url + `baseline=${baseline}&target=${queued}`)).statusCode).toBe(409);
  });

  it('downloads matching comparison snapshots in JSON, CSV and Excel CSV', async () => {
    const { app, root, pair, baseline, target } = setup();
    for (const format of ['json', 'csv', 'excel']) {
      const response = await app.inject(root + '/run-comparison/export?' + pair + '&kind=regression&format=' + format);
      expect(response.statusCode).toBe(200);
      const encoded = response.headers['content-disposition']!.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toMatch(new RegExp('^\\d{4}-\\d{2}-\\d{2} - Сравнение API\\.' + (format === 'json' ? 'json' : 'csv') + '$'));
      if (format === 'json') expect(response.json()).toMatchObject({
        baseline: { id: baseline }, target: { id: target }, rows: [{ target: { result: { httpCode: 503 } } }],
      });
      else {
        expect(response.body.trim().split(/\r?\n/)).toHaveLength(2);
        expect(response.body).toContain('https://example.com/first');
        expect(response.body).toContain('503');
      }
      expect(response.body).not.toContain('https://example.com/second');
    }
  });

  it('checks export availability without opening a snapshot or returning a body', async () => {
    const { app, store, project, root, baseline, pair } = setup();
    const openSnapshot = vi.spyOn(store, 'beginComparisonExport');
    const url = root + '/run-comparison/export?' + pair + '&format=json';
    const present = await app.inject({ method: 'HEAD', url });
    expect(present.statusCode).toBe(200);
    expect(present.body).toBe('');
    store.deleteRun(project.id, baseline);
    expect((await app.inject({ method: 'HEAD', url })).statusCode).toBe(404);
    expect(openSnapshot).not.toHaveBeenCalled();
  });
});
