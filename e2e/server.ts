import { DatabaseTasks } from '../src/server/database-tasks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { CatalogService } from '../src/server/catalog/service.js';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { readSitemap } from '../src/server/sitemap.js';
import { Store } from '../src/server/store.js';
import { startBackground } from '../src/server/worker.js';

const port = 8732;
const directory = await mkdtemp(join(tmpdir(), 'pulse-browser-test-'));
const db = join(directory, 'pulse.sqlite3');
const store = new Store(db);
const catalog = new CatalogService(db);
const tasks = new DatabaseTasks(db);
catalog.start();
const app = createApp({
  store, catalog, tasks, origin: `http://127.0.0.1:${port}`, staticRoot: resolve(process.env.PULSE_E2E_STATIC_ROOT || 'dist/client'),
  onRunStopped: runId => stop.cancelRun(runId),
  checkRequest: async (url, options) => {
    if (url !== 'https://example.com/proxy-failure' || options?.requestOptions?.proxy?.url !== 'https://proxy.example.com:8443') {
      throw new Error('Unexpected test request');
    }
    return {
      status: 'error', httpCode: null, durationMs: 24, finalUrl: url, redirects: 0, contentType: null, contentLength: null,
      errorKind: 'connection', error: 'Прокси отклонил запрос.', requestProfile: options.requestOptions.profileName,
      requestRoute: 'proxy', failureStage: 'proxy', proxyHttpCode: 407,
    };
  },
  sitemap: input => readSitemap(input, async url => Buffer.from(url.endsWith('sitemap.xml')
    ? '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>'
    : '<urlset><url><loc>https://example.com/from-sitemap-link</loc></url></urlset>')),
});
await app.listen({ host: '127.0.0.1', port });
const stop = startBackground(store, { tasks,
  check: async (url, _profile, signal) => {
    if (url.endsWith('/wait-for-stop')) await wait(12_000, undefined, { signal });
    const curator = url.endsWith('/curator');
    const failing = curator || url.endsWith('/unavailable');
    return {
      status: failing ? 'error' : 'ok', httpCode: curator ? 401 : failing ? 503 : 200, redirects: 0,
      durationMs: 94, finalUrl: url, contentType: 'text/html', contentLength: '1024',
      errorKind: failing ? 'http' : null, error: curator ? 'HTTP 401' : failing ? 'HTTP 503' : null,
      accessHint: curator ? 'curator-challenge' : null,
    };
  },
});
process.once('SIGTERM', async () => { await Promise.all([stop(), app.close(), catalog.close()]); await tasks.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
