import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { runImport } from '../src/server/catalog/importer.js';
import { CatalogService } from '../src/server/catalog/service.js';
import { Store } from '../src/server/store.js';
import type { CatalogJob, CatalogPage } from '../src/shared/catalog.js';

const host = 'https://example.test';
const sitemap = (paths: string[]) => `<urlset>${paths.map(path => `<url><loc>${host}${path}</loc></url>`).join('')}</urlset>`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-catalog-api-'));
  const file = join(directory, 'main.sqlite3');
  const store = new Store(file);
  const service = new CatalogService(file);
  const app = createApp({ store, catalog: service });
  const project = store.createProject('Catalog API', '');
  const root = `/api/projects/${project.id}/catalog`;
  const db = service.db;

  return {
    app, root, file, store, service, project, db,
    async publish(paths: string[], sourceId?: number) {
      const job = db.create(project.id, sourceId === undefined ? { url: host + '/sitemap.xml' } : { sourceId });
      await runImport(db, job.id, { open: async () => Readable.from([Buffer.from(sitemap(paths))]) });
      expect(db.job(project.id, job.id).state).toBe('done');
      return job;
    },
    async close() {
      await app.close();
      await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('queues and publishes an octet-stream upload for its owning project', async () => {
  const { app, root, file, store, project, db, close } = await fixture();
  try {
    const created = await app.inject({ method: 'POST', url: root + '/imports', payload: { fileName: '  catalog.xml  ' } });
    expect(created.statusCode).toBe(202);
    const job = created.json<CatalogJob>();
    expect(job).toMatchObject({ state: 'upload', needsFile: true });
    expect((await app.inject(root)).json()).toMatchObject({
      sources: [{ id: job.sourceId, name: 'catalog.xml', currentId: null }], jobs: [{ id: job.id }], transfer: null,
    });
    expect((await app.inject(root + `/page?sourceId=${job.sourceId}`)).json()).toEqual({ revision: 0, items: [], next: null });

    const uploadPath = `/imports/${job.id}/file`;
    const binary = { method: 'PUT' as const, headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(sitemap(['/one', '/two'])) };
    const other = store.createProject('Other catalog', '');
    expect((await app.inject({ ...binary, url: `/api/projects/${other.id}/catalog` + uploadPath })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: root + uploadPath, payload: { xml: 'wrong content type' } })).statusCode).toBe(415);
    expect(db.job(project.id, job.id).state).toBe('upload');

    const uploaded = await app.inject({ ...binary, url: root + uploadPath });
    expect(uploaded.statusCode).toBe(202);
    expect(uploaded.json()).toMatchObject({ id: job.id, state: 'queued' });
    await vi.waitFor(() => expect(db.job(project.id, job.id)).toMatchObject({ state: 'done', uniqueUrls: 2, documentsDone: 1 }));
    const page = (await app.inject(root + `/page?sourceId=${job.sourceId}`)).json<CatalogPage>();
    expect(page.items.map(item => item.url)).toEqual([host + '/one', host + '/two']);
    expect((await app.inject({ ...binary, url: root + uploadPath })).statusCode).toBe(409);

    const staged = join(file + '.catalog', db.fileKey(job.id) + '.bin');
    await vi.waitFor(async () => await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' }));
    await expect(stat(staged + '.partial')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await close(); }
});

test('rejects simultaneous uploads and removes an unfinished upload when cancelled', async () => {
  const { app, root, file, project, db, service, close } = await fixture();
  const stream = new PassThrough();
  try {
    const job = service.create(project.id, { fileName: 'interrupted.xml' });
    const staged = join(file + '.catalog', db.fileKey(job.id) + '.bin');
    const uploading = service.upload(project.id, job.id, () => stream).catch(error => error);
    stream.write('<urlset>');
    await vi.waitFor(async () => expect((await stat(staged + '.partial')).isFile()).toBe(true));
    await expect(service.upload(project.id, job.id, () => Readable.from([Buffer.from('<urlset/>')]))).rejects
      .toMatchObject({ statusCode: 409 });

    const control = (action: string) => app.inject({ method: 'POST', url: root + `/imports/${job.id}/control`, payload: { action } });
    const cancelled = await control('cancel');
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: job.id, state: 'cancelled' });
    expect(await uploading).toMatchObject({ statusCode: 409 });
    expect(stream.destroyed).toBe(true);
    expect((await control('resume')).statusCode).toBe(409);
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(staged + '.partial')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    stream.destroy();
    await close();
  }
});

test('recovers a running import and removes abandoned staging files on startup', async () => {
  const { file, project, db, service, close } = await fixture();
  try {
    const running = db.create(project.id, { fileName: 'running.xml' });
    db.uploaded(project.id, running.id);
    expect(db.start(running.id)).toBe(true);
    const interrupted = db.create(project.id, { fileName: 'interrupted.xml' });
    const directory = file + '.catalog';
    const completedUpload = join(directory, db.fileKey(running.id) + '.bin');
    const incompleteUpload = join(directory, db.fileKey(interrupted.id) + '.bin.partial');
    const orphan = join(directory, '11111111-2222-3333-4444-555555555555.bin');
    const unrelated = join(directory, 'keep.xml');
    await mkdir(directory);
    await writeFile(completedUpload, sitemap(['/recovered']));
    await writeFile(incompleteUpload, '<urlset>');
    await writeFile(orphan, 'Stale file from an old import');
    await writeFile(unrelated, 'Other local file');

    service.start();
    expect(db.job(project.id, interrupted.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('прервалась') });
    await vi.waitFor(() => expect(db.job(project.id, running.id)).toMatchObject({ state: 'done', uniqueUrls: 1 }));
    expect(db.page(project.id, { sourceId: running.sourceId }).items.map(item => item.url)).toEqual([host + '/recovered']);
    await vi.waitFor(async () => {
      for (const path of [completedUpload, incompleteUpload, orphan]) {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
    expect((await stat(unrelated)).isFile()).toBe(true);
  } finally { await close(); }
});

test('queues a published catalog transfer through the API and completes it in the worker', async () => {
  const { app, root, store, project, db, close, publish } = await fixture();
  try {
    await publish(['/existing', '/new']);
    store.addUrls(project.id, [{ input: host + '/existing', line: 1 }]);
    const response = await app.inject({ method: 'POST', url: root + '/transfer' });
    expect(response.statusCode).toBe(202);
    const { id } = response.json<{ id: number }>();
    expect(response.json()).toMatchObject({ id, state: 'queued', total: 2 });
    await vi.waitFor(() => expect(db.transfers.latest(project.id)).toMatchObject({
      id, state: 'done', total: 2, added: 1, existing: 1, processed: 2,
    }));
    expect(store.addresses(project.id).map(entry => entry.url)).toEqual([host + '/existing', host + '/new']);
    expect((await app.inject({ method: 'POST', url: root + `/transfer/${id}/stop` })).statusCode).toBe(409);
  } finally { await close(); }
});

test('rejects invalid catalog requests without creating jobs or queuing checks', async () => {
  const { app, root, store, project, db, close, publish } = await fixture();
  try {
    const job = await publish(['/one']);
    const { sourceId, id: revision } = job;
    const base = { sourceId, revision, action: 'check' };
    const invalid = [
      { url: root + '/imports', payload: [] },
      { url: root + '/imports', payload: { fileName: 'sitemap.xml', url: host + '/other.xml' } },
      { url: root + '/imports', payload: { fileName: 'x'.repeat(256) } },
      { url: root + '/imports', payload: { fileName: 'line\nbreak.xml' } },
      { url: root + '/imports', payload: {} },
      { url: root + '/clear', payload: { confirmation: 'expired' } },
      { url: root + `/imports/${revision}/control`, payload: { action: 'restart' } },
      { url: root + '/actions', payload: { ...base, revision: undefined, limit: 1 } },
      { url: root + '/actions', payload: { ...base, selected: [host + '/one'], limit: 1 } },
      { url: root + '/actions', payload: { ...base, selected: [] } },
      { url: root + '/actions', payload: { ...base, selected: [''] } },
      { url: root + '/actions', payload: { ...base, selected: ['x'.repeat(2001)] } },
      { url: root + '/actions', payload: { ...base, selected: Array(5001).fill(host + '/one') } },
      { url: root + '/actions', payload: { ...base, limit: 5001 } },
      { url: root + '/actions', payload: { ...base, limit: 0 } },
      { url: root + '/actions', payload: { ...base, limit: 1, prefix: '/missing' } },
      { url: root + '/actions', payload: { ...base, limit: 1, action: 'archive' } },
    ];
    for (const { url, payload } of invalid) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode, `${url} ${response.body}`).toBe(400);
    }
    for (const query of ['sourceId=0', 'sourceId=9007199254740992', `sourceId=${sourceId}&change=latest`,
      `sourceId=${sourceId}&direction=forward`, `sourceId=${sourceId}&prefix=relative`,
      `sourceId=${sourceId}&domain=${encodeURIComponent(host + '/one')}`]) {
      expect((await app.inject(root + '/page?' + query)).statusCode, query).toBe(400);
    }
    expect((await app.inject(`/api/projects/${project.id + 1}/catalog`)).statusCode).toBe(404);
    expect(db.jobs(project.id).map(entry => entry.id)).toEqual([revision]);
    expect(store.queuedRuns(project.id)).toEqual([]);
  } finally { await close(); }
});

test('queues only the selected catalog URLs and refuses stale selections', async () => {
  const { app, root, store, project, close, publish } = await fixture();
  try {
    const first = await publish(['/one', '/two']);
    const current = await publish(['/one', '/three'], first.sourceId);
    const actions = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: root + '/actions',
      payload: { sourceId: current.sourceId, revision: current.id, action: 'check', ...payload } });

    expect((await actions({ revision: first.id, selected: [host + '/one'] })).statusCode).toBe(409);
    expect((await actions({ selected: [host + '/two'] })).statusCode).toBe(409);
    expect(store.queuedRuns(project.id)).toEqual([]);

    const queued = await actions({ selected: [host + '/three', host + '/one', ...Array(4998).fill(host + '/three')] });
    expect(queued.statusCode).toBe(202);
    const run = store.run(queued.json<{ id: number }>().id, project.id);
    expect(run).toMatchObject({ status: 'queued', total: 2 });
    expect(store.claim()?.items.map(item => item.url)).toEqual([host + '/three', host + '/one']);
    expect(store.addresses(project.id)).toEqual([]);
  } finally { await close(); }
});

test('exports selected removed URLs from the previous revision in selection order', async () => {
  const { app, root, close, publish } = await fixture();
  try {
    const first = await publish(['/kept', '/first', '/second']);
    const current = await publish(['/kept'], first.sourceId);
    const filter = { sourceId: current.sourceId, revision: current.id, change: 'removed' };
    const exported = await app.inject({ method: 'POST', url: root + '/export',
      payload: { ...filter, selected: [host + '/second', host + '/first', host + '/second'] } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="\d{4}-\d{2}-\d{2} - Catalog API\.csv"; filename\*=UTF-8''/);
    expect(exported.body).toBe('\uFEFFurl,lastmod,change\r\n' +
      '"https://example.test/second","","removed"\r\n"https://example.test/first","","removed"\r\n');
    const stale = await app.inject({ method: 'POST', url: root + '/export',
      payload: { ...filter, revision: first.id, selected: [host + '/first'] } });
    expect(stale.statusCode).toBe(409);
  } finally { await close(); }
});

test('exports every URL when a filtered CSV spans more than one page', async () => {
  const { app, root, close, publish } = await fixture();
  try {
    const paths = Array.from({ length: 1001 }, (_, index) => '/same?p=' + String(index).padStart(4, '0'));
    const job = await publish([...paths, '/other']);
    const query = new URLSearchParams({ sourceId: String(job.sourceId), revision: String(job.id), prefix: '/same', direction: 'desc' });
    const exported = await app.inject(root + '/export?' + query);
    expect(exported.statusCode).toBe(200);
    expect(exported.body.trimEnd().split('\r\n')).toEqual(['\uFEFFurl,lastmod,change',
      ...paths.reverse().map(path => `"${host}${path}","","added"`)]);
  } finally { await close(); }
});

test.each([false, true])('paginates descending without losing same-path URLs (prefix filter %s)', async usePrefix => {
  const { app, root, close, publish } = await fixture();
  try {
    const paths = Array.from({ length: 101 }, (_, index) => '/same?p=' + String(index).padStart(3, '0'));
    const job = await publish(paths);
    const query = new URLSearchParams({ sourceId: String(job.sourceId), direction: 'desc', domain: ' EXAMPLE.TEST ' });
    if (usePrefix) query.set('prefix', '/same');
    const first = (await app.inject(root + '/page?' + query)).json<CatalogPage>();
    expect(first).toMatchObject({ revision: job.id, next: host + '/same?p=001' });
    expect(first.items.map(item => item.url)).toEqual(paths.slice(1).reverse().map(path => host + path));
    query.set('revision', String(first.revision));
    query.set('after', first.next!);
    const second = (await app.inject(root + '/page?' + query)).json<CatalogPage>();
    expect(second).toEqual({ revision: job.id, next: null, items: [{ url: host + '/same?p=000', lastmod: null, change: 'added' }] });
  } finally { await close(); }
});
