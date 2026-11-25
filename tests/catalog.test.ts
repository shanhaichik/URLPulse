import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { Catalog } from '../src/server/catalog/database.js';
import { runImport } from '../src/server/catalog/importer.js';
import { CatalogService } from '../src/server/catalog/service.js';
import { Store } from '../src/server/store.js';
import * as checker from '../src/server/checker.js';
import { parsePacFile, withPacProxies } from '../src/server/pac-config.js';

const doc = (rows: string) => '<urlset>' + rows + '</urlset>';
const item = (path: string, lastmod = '') =>
  '<url><loc>https://sample.test/' + path + '</loc><lastmod>' + lastmod + '</lastmod></url>';
const input = (body: string | Buffer) => Readable.from([Buffer.from(body)]);

test('uses a queued catalog job’s PAC password reference after changing settings and restarting', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-pac-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  const url = 'https://public.example/sitemap.xml';
  const seen: unknown[] = [];
  const download = vi.spyOn(checker, 'openSitemapStream').mockImplementation(async (location, _tls, signal, network) => {
    const route = (await network?.pac?.(new URL(location), signal))?.[0];
    const ref = route?.kind === 'proxy' ? network?.pacProxy?.rules.get(route.url)?.auth?.ref : undefined;
    seen.push({ route, ref });
    return input(doc(item('from-pac'))) as Awaited<ReturnType<typeof checker.openSitemapStream>>;
  });
  try {
    const { id } = store.createProject('Catalog PAC', '');
    const legacy = parsePacFile('office.pac', "function FindProxyForURL() { return 'HTTPS proxy.office.test:9443'; }");
    const ref = 'PULSE_REQUEST_SECRET_INITIAL';
    const proxy = { url: 'https://proxy.office.test:9443', allowPrivate: true, connectByHostname: true };
    const first = withPacProxies(legacy, [{ ...proxy, auth: { username: 'alice', ref } }]);
    store.savePac(id, first);
    const job = catalog.create(id, { url });
    catalog.control(id, job.id, 'pause');
    store.savePac(id, withPacProxies(legacy, [{ ...proxy, auth: { username: 'bob', ref: 'PULSE_REQUEST_SECRET_ROTATED' } }]));
    const reopened = new Catalog(file);
    try {
      reopened.recover();
      reopened.control(id, job.id, 'resume');
      await runImport(reopened, job.id);
      expect(reopened.job(id, job.id).state).toBe('done');
    } finally { reopened.close(); }
    expect(seen).toEqual([{ route: { kind: 'proxy', url: proxy.url }, ref }]);
  } finally { download.mockRestore(); catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test.each(['source', 'catalog'])('drops the disabled PAC revision when deleting its last catalog %s', async scope => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-pac-history-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  const db = new DatabaseSync(file);
  try {
    const { id } = store.createProject('PAC cleanup', '');
    const config = parsePacFile('office.pac', "function FindProxyForURL() { return 'DIRECT'; }");
    store.savePac(id, config);
    const job = catalog.create(id, { url: 'https://sample.test/sitemap.xml' });
    await runImport(catalog, job.id, { open: async () => input(doc(item('one'))) });
    store.savePac(id);
    const revisions = () => db.prepare('SELECT revision FROM project_pac_versions WHERE project_id=?').all(id).map(row => row.revision);
    expect(revisions()).toEqual([config.revision]);
    if (scope === 'source') catalog.deleteSource(id, job.sourceId);
    else catalog.clearProject(id, catalog.previewClear(id).confirmation);
    expect(revisions()).toEqual([]);
  } finally { db.close(); catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('requests the snapshotted secret from the catalog worker and releases it when cancelling a failed job', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-pac-worker-'));
  const file = join(folder, 'main.sqlite3');
  const guard = `import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns/promises';
    import { syncBuiltinESMExports } from 'node:module';
    http.request = https.request = () => { throw new Error('No sockets allowed in this catalog fixture.'); };
    dns.lookup = async () => [{ address: '8.8.4.4', family: 4 }]; syncBuiltinESMExports();`;
  const workerScenario = `
    (async () => {
    const { setTimeout } = await import('node:timers/promises');
    const { Store } = await import('./src/server/store.ts');
    const { CatalogService } = await import('./src/server/catalog/service.ts');
    const { parsePacFile, withPacProxies } = await import('./src/server/pac-config.ts');
    const store = new Store(process.argv[1]);
    const read = [];
    const removed = [];
    const errors = [];
    const service = new CatalogService(process.argv[1], error => errors.push(String(error)), { store, secrets: {
      mode: 'desktop',
      async save() { throw new Error('No new secret required'); },
      async read(ref) { read.push(ref); return undefined; },
      async remove(ref) { removed.push(ref); },
    } });
    try {
      const { id } = store.createProject('PAC worker', '');
      const pac = parsePacFile('office.pac', "function FindProxyForURL() { return 'HTTPS proxy.example:8443'; }");
      store.savePac(id, withPacProxies(pac, [{ url: 'https://proxy.example:8443', allowPrivate: false, connectByHostname: true,
        auth: { username: 'fixture', ref: 'desktop-00000000-0000-4000-8000-000000000123' } }]));
      const job = service.db.create(id, { url: 'https://target.example/sitemap.xml' });
      store.savePac(id);
      service.start();
      let current = service.db.job(id, job.id);
      for (let attempt = 0; attempt < 160 && current.state !== 'failed'; attempt++) {
        await setTimeout(25);
        current = service.db.job(id, job.id);
      }
      const pendingRemoval = removed.slice();
      await service.control(id, job.id, 'cancel');
      await service.close();
      console.log(JSON.stringify({ state: current.state, error: current.error, read, pendingRemoval, removed, errors }));
    } finally { await service.close(); store.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--import',
      'data:text/javascript,' + encodeURIComponent(guard), '-e', workerScenario, file], { timeout: 8_000 });
    const ref = 'desktop-00000000-0000-4000-8000-000000000123';
    expect(JSON.parse(stdout)).toEqual({ state: 'failed', error: 'Секрет доверенного прокси недоступен или не настроен.',
      read: [ref], pendingRemoval: [], removed: [ref], errors: [] });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 10_000);

test('rejects a stale catalog clear preview when the same source gets a new version or transfer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-clear-scope-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new CatalogService(file);
  const app = createApp({ store, catalog });
  try {
    const { id } = store.createProject('Предпросмотр каталога', '');
    const path = `/api/projects/${id}/catalog/clear`;
    const read = async () => (await app.inject(path)).json();
    const clear = (confirmation: string) => app.inject({ method: 'POST', url: path, payload: { confirmation } });
    const first = catalog.db.create(id, { url: 'https://sample.test/sitemap.xml' });
    await runImport(catalog.db, first.id, { open: async () => input(doc(item('one'))) });
    const preview = await read();
    const revision = catalog.db.create(id, { sourceId: catalog.db.sources(id)[0].id });
    await runImport(catalog.db, revision.id, { open: async () => input(doc(item('one') + item('two'))) });
    expect((await clear(preview.confirmation)).statusCode).toBe(409);
    expect(catalog.db.sources(id)).toMatchObject([{ count: 2 }]);
    const second = await read();
    const transfer = catalog.db.transfers.enqueue(id);
    expect(() => catalog.db.clearProject(id, second.confirmation)).toThrow(/операции каталога изменились/);
    expect(catalog.db.previewClear(id).transferActive).toBe(true);
    expect(catalog.db.transfers.latest(id)).toMatchObject({ id: transfer.id, state: 'queued' });
    catalog.db.transfers.stop(id, transfer.id);
    expect((await clear((await read()).confirmation)).json()).toEqual({ deleted: 1 });
    expect(catalog.db.sources(id)).toEqual([]);
  } finally { await app.close(); await catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('publishes gzip and nested sitemap data once and compares the next snapshot', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-test-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Каталог', '');
    const first = catalog.create(id, { url: 'https://sample.test/index.xml' });
    await runImport(catalog, first.id, { open: async file => {
      if (file.location.endsWith('index.xml')) {
        return input('<sitemapindex><sitemap><loc>https://sample.test/a.xml.gz</loc></sitemap><sitemap><loc>https://sample.test/b.xml</loc></sitemap></sitemapindex>');
      }
      return file.location.endsWith('.gz') ? input(gzipSync(docXml())) : input(doc(item('one') + item('old')));
    } });
    expect(catalog.job(id, first.id)).toMatchObject({ state: 'done', uniqueUrls: 3, duplicates: 1, documentsDone: 3 });
    const initial = catalog.sources(id)[0];
    const second = catalog.create(id, { sourceId: initial.id });
    await runImport(catalog, second.id, { open: async () => input(doc(item('one', '2026-02-02') + item('two') + item('new'))) });
    const added = catalog.page(id, { sourceId: initial.id, change: 'added' });
    expect(added.items.map(row => row.url)).toEqual(['https://sample.test/new']);
    expect(catalog.page(id, { sourceId: initial.id, change: 'removed' }).items.map(row => row.url))
      .toEqual(['https://sample.test/old']);
    expect(catalog.page(id, { sourceId: initial.id, change: 'changed' }).items.map(row => row.url))
      .toEqual(['https://sample.test/one']);
    expect(catalog.page(id, { sourceId: initial.id, domain: 'sample.test', prefix: '/tw' }).items[0].url)
      .toBe('https://sample.test/two');

    const failed = catalog.create(id, { sourceId: initial.id });
    await runImport(catalog, failed.id, { open: async () => input('<urlset><url>') });
    expect(catalog.job(id, failed.id).state).toBe('failed');
    expect(catalog.sources(id)[0].currentId).toBe(second.id);
    catalog.control(id, failed.id, 'resume');
    await runImport(catalog, failed.id, { open: async () => input(doc(item('recover'))) });
    expect(catalog.job(id, failed.id).state).toBe('done');
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

function docXml() { return doc(item('one', '2026-02-01') + item('two')); }

test('preserves a published sitemap on an all-invalid update and accepts a genuinely empty version', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-empty-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Empty updates', '');
    const first = catalog.create(id, { url: 'https://sample.test/source.xml' });
    await runImport(catalog, first.id, { open: async () => input(doc(item('previous'))) });
    const invalid = catalog.create(id, { sourceId: first.sourceId });
    await runImport(catalog, invalid.id, { open: async () => input(doc('<url><loc>/relative</loc></url>')) });
    expect(catalog.job(id, invalid.id)).toMatchObject({ state: 'failed', invalid: 1 });
    expect(catalog.sources(id)[0]).toMatchObject({ currentId: first.id, count: 1, removed: 0 });
    expect(catalog.page(id, { sourceId: first.sourceId }).items.map(row => row.url)).toEqual(['https://sample.test/previous']);

    const empty = catalog.create(id, { sourceId: first.sourceId });
    await runImport(catalog, empty.id, { open: async () => input(doc('')) });
    expect(catalog.job(id, empty.id).state).toBe('done');
    expect(catalog.sources(id)[0]).toMatchObject({ currentId: empty.id, count: 0, removed: 1 });
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test.each(['remote', 'file'])('rereads a %s sitemap after every entry in the completed import was invalid', async kind => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-reread-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Retry all-invalid import', '');
    const job = catalog.create(id, kind === 'remote' ? { url: 'https://sample.test/root.xml' } : { fileName: 'root.xml' });
    if (kind === 'file') catalog.uploaded(id, job.id);
    const root = catalog.document(job.id)!;
    const invalid = 'https://sample.test/invalid.xml';
    await runImport(catalog, job.id, { open: async entry => input(entry.id === root.id
      ? '<sitemapindex><sitemap><loc>' + invalid + '</loc></sitemap></sitemapindex>'
      : doc('<url><loc>/relative</loc></url>')) });
    expect(catalog.job(id, job.id)).toMatchObject({ state: 'failed', invalid: 1, documentsDone: 2 });

    catalog.control(id, job.id, 'resume');
    const reread: string[] = [];
    await runImport(catalog, job.id, { open: async entry => {
      reread.push(entry.location);
      return input(doc(item('corrected')));
    } });
    expect(reread).toEqual([root.location]);
    expect(catalog.job(id, job.id)).toMatchObject({ state: 'done', documentsDone: 1, invalid: 0 });
    expect(catalog.page(id, { sourceId: job.sourceId }).items.map(row => row.url)).toEqual(['https://sample.test/corrected']);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('keeps an old paused job visible and rejects retrying an obsolete failed import', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-jobs-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Jobs', '');
    const paused = catalog.create(id, { url: 'https://sample.test/paused.xml' });
    catalog.control(id, paused.id, 'pause');
    const failed = catalog.create(id, { url: 'https://sample.test/latest.xml' });
    await runImport(catalog, failed.id, { open: async () => input('<bad>') });
    let last = failed;
    for (let i = 0; i < 21; i++) {
      last = catalog.create(id, { sourceId: failed.sourceId });
      await runImport(catalog, last.id, { open: async () => input(doc(item(String(i)))) });
    }
    expect(catalog.sources(id).find(source => source.id === last.sourceId)?.currentId).toBe(last.id);
    expect(() => catalog.control(id, failed.id, 'resume')).toThrow('уже опубликована');
    expect(catalog.jobs(id)).toContainEqual(expect.objectContaining({ id: paused.id, state: 'paused' }));
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('finds and reclaims cancelled staging and obsolete revisions while keeping the two published versions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-gc-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('GC', '');
    const cancelled = catalog.create(id, { url: 'https://sample.test/cancel.xml' });
    catalog.start(cancelled.id);
    catalog.insertEntries(cancelled.id, catalog.document(cancelled.id)!.id, [{ loc: 'https://sample.test/draft', lastmod: null }], 50);
    catalog.control(id, cancelled.id, 'cancel');
    expect(catalog.nextCleanup()).toBe(cancelled.id);
    catalog.discardRows(cancelled.id);
    expect(catalog.nextCleanup()).toBeUndefined();

    const first = catalog.create(id, { url: 'https://sample.test/gc.xml' });
    await runImport(catalog, first.id, { open: async () => input(doc(item('old'))) });
    for (const name of ['previous', 'current']) {
      const next = catalog.create(id, { sourceId: first.sourceId });
      await runImport(catalog, next.id, { open: async () => input(doc(item(name))) });
    }
    expect(catalog.nextCleanup()).toBe(first.id);
    catalog.discardRows(first.id);
    expect(catalog.nextCleanup()).toBeUndefined();
    expect(catalog.page(id, { sourceId: first.sourceId, change: 'removed' }).items.map(row => row.url))
      .toEqual(['https://sample.test/previous']);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('bounds an unterminated XML token even when its contents contain delimiters', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-token-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('XML', '');
    const job = catalog.create(id, { url: 'https://sample.test/long.xml' });
    const chunks = Readable.from((function* () {
      yield Buffer.from('<urlset><!--');
      for (let i = 0; i < 80; i++) yield Buffer.alloc(16_384, 0x3e);
      yield Buffer.from('-->' + item('valid') + '</urlset>');
    })());
    await runImport(catalog, job.id, { open: async () => chunks });
    expect(catalog.job(id, job.id)).toMatchObject({ state: 'failed', error: 'Слишком длинный XML-элемент.' });
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('restarts the unfinished sitemap document without reading completed documents again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-resume-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Resume', '');
    const job = catalog.create(id, { url: 'https://sample.test/index.xml' });
    catalog.start(job.id);
    const root = catalog.document(job.id)!;
    catalog.completeDocument(job.id, root.id, 45, ['https://sample.test/first.xml', 'https://sample.test/unfinished.xml']);
    const first = catalog.document(job.id)!;
    catalog.insertEntries(job.id, first.id, [{ loc: 'https://sample.test/completed', lastmod: null }], 100);
    catalog.completeDocument(job.id, first.id, 100, []);
    const unfinished = catalog.document(job.id)!;
    catalog.insertEntries(job.id, unfinished.id, [{ loc: 'https://sample.test/discard', lastmod: null }], 100);
    catalog.recover();
    await runImport(catalog, job.id, { open: async entry => {
      expect(entry.location).toBe('https://sample.test/unfinished.xml');
      return input(doc(item('retried')));
    } });
    expect(catalog.job(id, job.id)).toMatchObject({ state: 'done', documentsDone: 3, uniqueUrls: 2 });
    expect(catalog.page(id, { sourceId: job.sourceId }).items.map(row => row.url))
      .toEqual(['https://sample.test/completed', 'https://sample.test/retried']);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('moves more than 5000 distinct URLs from every published source and resumes without touching existing entries', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-transfer-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const project = store.createProject('Перенос', '').id;
    const saved = 'https://sample.test/catalog/00000';
    store.addUrls(project, [{ input: saved, line: 1 }], 'Главная страница');
    const savedId = store.addresses(project)[0].id;
    const first = catalog.create(project, { url: 'https://sample.test/sitemap-a.xml' });
    const second = catalog.create(project, { url: 'https://sample.test/sitemap-b.xml' });
    const address = (i: number) => item('catalog/' + String(i).padStart(5, '0'));
    await runImport(catalog, first.id, { open: async () => input(doc(Array.from({ length: 5001 }, (_, i) => address(i)).join(''))) });
    await runImport(catalog, second.id, { open: async () => input(doc(address(0) + address(5001))) });
    expect(catalog.transfers.enqueue(project)).toMatchObject({ state: 'queued' });
    const transfer = catalog.transfers.latest(project)!;
    expect(catalog.transfers.enqueue(project)?.id).toBe(transfer.id);
    catalog.transfers.batch(transfer.id, 1000);
    expect(catalog.transfers.latest(project)).toMatchObject({ state: 'running', added: 999, existing: 1 });
    catalog.recover();
    while (catalog.transfers.batch(transfer.id, 1000)) { /* Resume using checkpointed position. */ }
    expect(catalog.transfers.latest(project)).toMatchObject({ state: 'done', added: 5001, existing: 1, processed: 5002, total: 5002 });
    expect(store.project(project).urlCount).toBe(5002);
    expect(store.address(project, savedId).label).toBe('Главная страница');
    expect(store.versions(savedId)).toHaveLength(1);
    expect(store.runs(project)).toEqual([]);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('pins the catalog revision, then allows the due schedule to snapshot the completed transfer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-pin-'));
  const file = join(folder, 'main.sqlite3');
  let now = Date.parse('2026-11-18T10:00:00Z');
  const store = new Store(file, () => now);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Pinned', '');
    const first = catalog.create(id, { url: 'https://sample.test/pinned.xml' });
    await runImport(catalog, first.id, { open: async () => input(doc(item('at-click'))) });
    const transfer = catalog.transfers.enqueue(id);
    for (const name of ['second', 'third']) {
      const refresh = catalog.create(id, { sourceId: first.sourceId });
      await runImport(catalog, refresh.id, { open: async () => input(doc(item(name))) });
    }
    expect(catalog.nextCleanup()).toBeUndefined();
    const schedule = store.saveSettings(id, {
      schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], time: '10:02', timezone: 'UTC' }, notify: 'off', email: null,
    });
    now = Date.parse(schedule.nextAt!);
    store.enqueueDue();
    expect(store.runs(id)).toEqual([]);
    expect(() => store.enqueue(id)).toThrow('Дождитесь завершения переноса');
    while (catalog.transfers.batch(transfer.id, 512)) { /* Process the pinned revision. */ }
    expect(catalog.nextCleanup()).toBe(first.id);
    expect(store.addresses(id).map(row => row.url)).toEqual(['https://sample.test/at-click']);
    store.enqueueDue();
    expect(store.runs(id)).toMatchObject([{ source: 'schedule', total: 1 }]);
    expect(store.claim()!.items).toMatchObject([{ url: 'https://sample.test/at-click' }]);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('stops a running transfer at its last committed batch and permits a duplicate-free retry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-stop-transfer-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const catalog = service.db;
  const app = createApp({ store, catalog: service });
  try {
    const { id } = store.createProject('Stopped transfer', '');
    const source = catalog.create(id, { url: 'https://sample.test/transfer.xml' });
    await runImport(catalog, source.id, { open: async () => input(doc(item('a') + item('b'))) });
    store.addUrls(id, [{ input: 'https://sample.test/a', line: 1 }], 'Saved title');
    const archived = store.addresses(id)[0];
    const originalRun = store.enqueue(id);
    store.saveResult(store.claim()!.items[0].id, {
      status: 'ok', httpCode: 204, durationMs: 12, finalUrl: archived.url,
      redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null,
    });
    store.finish(originalRun.id, false);
    store.deleteUrls(id, [archived.id]);
    const transfer = catalog.transfers.enqueue(id);
    expect(catalog.transfers.batch(transfer.id, 1)).toBe(true);
    expect(() => store.enqueue(id)).toThrow('Дождитесь завершения переноса');
    expect(() => store.deleteProject(id)).toThrow('Дождитесь завершения переноса');

    const path = `/api/projects/${id}/catalog/transfer/${transfer.id}/stop`;
    const stopped = await app.inject({ method: 'POST', url: path });
    expect(stopped.statusCode).toBe(200);
    expect(desktopRequest({ method: 'POST', path }).path).toBe(path);
    expect(stopped.json()).toMatchObject({ state: 'cancelled', added: 1, processed: 1 });
    catalog.recover();
    expect(catalog.transfers.batch(transfer.id, 1)).toBe(false);
    expect(store.addresses(id)).toMatchObject([{ id: archived.id, url: archived.url, label: 'Saved title', latest: { httpCode: 204 } }]);
    const run = store.enqueue(id);
    expect(store.run(run.id, id).total).toBe(1);

    const retried = catalog.transfers.enqueue(id);
    while (catalog.transfers.batch(retried.id, 1)) { /* Transfer every remaining row. */ }
    expect(catalog.transfers.latest(id)).toMatchObject({ state: 'done', added: 1, existing: 1, total: 2 });
    expect(store.addresses(id).map(row => row.url)).toEqual(['https://sample.test/a', 'https://sample.test/b']);

    const queued = catalog.transfers.enqueue(id);
    const stoppedQueued = await app.inject({ method: 'POST', url: `/api/projects/${id}/catalog/transfer/${queued.id}/stop` });
    expect(stoppedQueued.json()).toMatchObject({ state: 'cancelled', added: 0, processed: 0 });
    store.deleteProject(id);
    expect(store.projects()).toEqual([]);
  } finally {
    await app.close();
    await service.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('transfers a URL through its original worklist identity when a legacy catalog-only duplicate exists', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-transfer-legacy-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Restore old worklist identity', '');
    const url = 'https://sample.test/history';
    const check = (run: number, code: number) => {
      store.saveResult(store.claim()!.items[0].id, {
        status: code === 204 ? 'ok' : 'error', httpCode: code, durationMs: 12, finalUrl: url,
        redirects: 0, contentType: null, contentLength: null, errorKind: code === 204 ? null : 'http', error: null,
      });
      store.finish(run, false);
    };
    store.addUrls(id, [{ input: url, line: 1 }], 'Original label');
    const original = store.addresses(id)[0];
    check(store.enqueue(id).id, 204);
    store.deleteUrls(id, [original.id]);

    const shadowRun = store.enqueueCatalog(id, [url]);
    const db = new DatabaseSync(file);
    let shadow: number;
    try {
      shadow = Number(db.prepare("INSERT INTO urls(project_id,url,label,worklist) VALUES (?,?,'',0)").run(id, url).lastInsertRowid);
      db.prepare("INSERT INTO url_versions VALUES (?,1,?,?)").run(shadow, url, '2026-11-19T01:00:00.000Z');
      db.prepare("UPDATE results SET url_id=?,label='' WHERE run_id=?").run(shadow, shadowRun.id);
    } finally { db.close(); }
    check(shadowRun.id, 503);

    const source = catalog.create(id, { url: 'https://sample.test/transfer.xml' });
    await runImport(catalog, source.id, { open: async () => input(doc(item('history'))) });
    const transfer = catalog.transfers.enqueue(id);
    while (catalog.transfers.batch(transfer.id, 1)) { /* Transfer the published URL. */ }
    expect(store.addresses(id)).toMatchObject([{ id: original.id, label: 'Original label', latest: { httpCode: 204 } }]);
    expect(store.address(id, shadow).removedAt).toEqual(expect.any(String));
    expect(store.history(shadow)).toMatchObject([{ httpCode: 503, urlId: shadow }]);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('corrects a remote source link without replacing its published revision', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-edit-source-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const catalog = service.db;
  const app = createApp({ store, catalog: service });
  try {
    const { id } = store.createProject('Source correction', '');
    const first = catalog.create(id, { url: 'https://sample.test/first.xml' });
    await runImport(catalog, first.id, { open: async () => input(doc(item('original'))) });
    const failed = catalog.create(id, { sourceId: first.sourceId });
    await runImport(catalog, failed.id, { open: async () => input('<wrong-root/>') });
    const path = `/api/projects/${id}/catalog/sources/${first.sourceId}`;
    const correctedUrl = 'https://sample.test/corrected.xml';
    const patch = (url: string) => app.inject({ method: 'PATCH', url: path, payload: { url } });
    const corrected = await patch(correctedUrl);
    expect(corrected.statusCode).toBe(200);
    expect(desktopRequest({ method: 'PATCH', path, body: JSON.stringify({ url: correctedUrl }) }).path).toBe(path);
    expect(corrected.json()).toMatchObject({ id: first.sourceId, url: correctedUrl, currentId: first.id, count: 1 });
    expect(catalog.page(id, { sourceId: first.sourceId }).items[0]?.url).toBe('https://sample.test/original');
    expect(() => catalog.control(id, failed.id, 'resume')).toThrow('Ссылка на sitemap изменилась');

    catalog.create(id, { url: 'https://sample.test/duplicate.xml' });
    expect((await patch('https://sample.test/duplicate.xml')).statusCode).toBe(409);
    const next = catalog.create(id, { sourceId: first.sourceId });
    expect((await patch('https://sample.test/third.xml')).statusCode).toBe(409);
    expect(catalog.document(next.id)?.location).toBe(correctedUrl);
    await runImport(catalog, next.id, { open: async () => input(doc(item('corrected'))) });
    expect(catalog.sources(id).find(source => source.id === first.sourceId)).toMatchObject({
      currentId: next.id, previousId: first.id, count: 1, added: 1, removed: 1,
    });
  } finally {
    await app.close();
    await service.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('removes a source from future transfers only after its last active operation releases it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-delete-source-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const catalog = service.db;
  const app = createApp({ store, catalog: service });
  try {
    const { id } = store.createProject('Remove a source', '');
    const obsolete = catalog.create(id, { url: 'https://sample.test/obsolete.xml' });
    const path = `/api/projects/${id}/catalog/sources/${obsolete.sourceId}`;
    const remove = () => app.inject({ method: 'DELETE', url: path });
    expect((await remove()).statusCode).toBe(409);
    await runImport(catalog, obsolete.id, { open: async () => input(doc(item('obsolete'))) });
    const transfer = catalog.transfers.enqueue(id);
    const newer = catalog.create(id, { sourceId: obsolete.sourceId });
    await runImport(catalog, newer.id, { open: async () => input(doc(item('unneeded'))) });
    expect((await remove()).statusCode).toBe(409);
    catalog.transfers.stop(id, transfer.id);

    store.addUrls(id, [{ input: 'https://sample.test/obsolete', line: 1 }]);
    expect((await remove()).statusCode).toBe(200);
    expect(desktopRequest({ method: 'DELETE', path }).path).toBe(path);
    expect(catalog.sources(id)).toEqual([]);
    expect(() => catalog.transfers.enqueue(id)).toThrow('нет адресов');
    const retained = catalog.create(id, { url: 'https://sample.test/retained.xml' });
    await runImport(catalog, retained.id, { open: async () => input(doc(item('retained'))) });
    const next = catalog.transfers.enqueue(id);
    while (catalog.transfers.batch(next.id, 512)) { /* Transfer the remaining source. */ }
    expect(catalog.transfers.latest(id)).toMatchObject({ state: 'done', total: 1, added: 1 });
    expect(store.addresses(id).map(row => row.url)).toEqual(['https://sample.test/obsolete', 'https://sample.test/retained']);
  } finally {
    await app.close();
    await service.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('paginates old import failures while retaining their checkpoints for resume', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-history-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const catalog = service.db;
  const app = createApp({ store, catalog: service });
  try {
    const { id } = store.createProject('Import history', '');
    const first = catalog.create(id, { url: 'https://sample.test/history.xml' });
    await runImport(catalog, first.id, { open: async () => input('<urlset>') });
    for (let i = 0; i < 20; i++) {
      const newer = catalog.create(id, { fileName: `newer-${i}.xml` });
      catalog.control(id, newer.id, 'cancel');
    }
    const other = store.createProject('Other import history', '');
    catalog.create(other.id, { url: 'https://sample.test/other.xml' });

    const path = `/api/projects/${id}/catalog/imports/history`;
    const firstPage = await app.inject({ method: 'GET', url: path });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().jobs).toHaveLength(20);
    expect(firstPage.json().jobs.every((job: { id: number }) => job.id > first.id && job.id <= first.id + 20)).toBe(true);
    const oldPath = path + '?before=' + firstPage.json().next;
    expect(desktopRequest({ method: 'GET', path: oldPath }).path).toBe(oldPath);
    const older = await app.inject({ method: 'GET', url: oldPath });
    expect(older.json()).toEqual({
      jobs: [expect.objectContaining({ id: first.id, sourceId: first.sourceId, state: 'failed' })], next: null,
    });
    expect(catalog.control(id, first.id, 'resume').state).toBe('queued');
  } finally {
    await app.close();
    await service.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('applies literal and percent-encoded Cyrillic prefixes identically to catalog pages, exports and actions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-unicode-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const catalog = service.db;
  const app = createApp({ store, catalog: service });
  try {
    const { id } = store.createProject('Cyrillic prefix', '');
    const job = catalog.create(id, { url: 'https://sample.test/source.xml' });
    await runImport(catalog, job.id, { open: async () => input(doc(item('каталог/item') + item('other'))) });
    const path = `/api/projects/${id}/catalog`;
    const encoded = '%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3';
    const matching = `https://sample.test/${encoded}/item`;
    for (const [prefix, added] of [['/каталог/', 1], [`/${encoded}/`, 0]] as const) {
      const filter = { sourceId: job.sourceId, revision: job.id, prefix };
      const query = new URLSearchParams({ sourceId: String(job.sourceId), revision: String(job.id), prefix });
      const page = await app.inject({ method: 'GET', url: path + '/page?' + query });
      expect(page.json().items.map((row: { url: string }) => row.url)).toEqual([matching]);
      const exported = await app.inject({ method: 'GET', url: path + '/export?' + query });
      expect(exported.body).toContain(matching);
      expect(exported.body).not.toContain('/other');
      const action = await app.inject({ method: 'POST', url: path + '/actions', payload: { ...filter, action: 'add', limit: 100 } });
      expect(action.statusCode).toBe(200);
      expect(action.json()).toMatchObject({ added, duplicates: 1 - added });
    }
    expect(store.addresses(id).map(row => row.url)).toEqual([matching]);
  } finally {
    await app.close();
    await service.close();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('streams gzip whose header crosses chunks and records only valid last-modified dates', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-gzip-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Streamed catalog', '');
    const job = catalog.create(id, { fileName: 'stream.xml.gz' });
    catalog.uploaded(id, job.id);
    const xml = doc('<url><loc><![CDATA[https://sample.test/café?x=1&y=2]]></loc><lastmod> 2024-02-29 </lastmod></url>' +
      item('invalid-date', '2025-02-29') + item('valid-offset', '2026-01-01T12:00:00+03:00'));
    const gzip = gzipSync(xml);
    await runImport(catalog, job.id, { open: async () => Readable.from([gzip.subarray(0, 1), gzip.subarray(1)]) });
    expect(catalog.job(id, job.id)).toMatchObject({ state: 'done', uniqueUrls: 3, bytes: Buffer.byteLength(xml) });
    const { items } = catalog.page(id, { sourceId: job.sourceId });
    expect(items.map(row => [row.url, row.lastmod])).toEqual([
      ['https://sample.test/caf%C3%A9?x=1&y=2', '2024-02-29'],
      ['https://sample.test/invalid-date', null],
      ['https://sample.test/valid-offset', '2026-01-01T12:00:00+03:00'],
    ]);
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('rejects a document beyond the remaining import budget and retains the published revision', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-catalog-byte-budget-'));
  const file = join(folder, 'main.sqlite3');
  const store = new Store(file);
  const catalog = new Catalog(file);
  try {
    const { id } = store.createProject('Import byte budget', '');
    const root = 'https://sample.test/index.xml';
    const childUrl = 'https://sample.test/child.xml';
    const initial = catalog.create(id, { url: root });
    const index = `<sitemapindex><sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`;
    const child = doc(item('published'));
    const combined = Buffer.byteLength(index) + Buffer.byteLength(child);
    await runImport(catalog, initial.id, { importLimit: combined,
      open: async entry => input(gzipSync(entry.location === root ? index : child)) });
    expect(catalog.job(id, initial.id)).toMatchObject({ state: 'done', bytes: combined, documentsDone: 2 });

    const replacement = catalog.create(id, { sourceId: initial.sourceId });
    await runImport(catalog, replacement.id, { importLimit: combined,
      open: async entry => input(gzipSync(entry.location === root ? index : child + ' ')) });
    expect(catalog.job(id, replacement.id)).toMatchObject({ state: 'failed', documentsDone: 1, problemFile: childUrl,
      error: expect.stringContaining('Превышен лимит размера') });
    expect(catalog.page(id, { sourceId: initial.sourceId })).toMatchObject({ revision: initial.id,
      items: [{ url: 'https://sample.test/published' }] });
  } finally { catalog.close(); store.close(); rmSync(folder, { recursive: true, force: true }); }
});
