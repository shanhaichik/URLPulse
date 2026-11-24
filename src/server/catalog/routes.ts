import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { CatalogFilter } from '../../shared/catalog.js';
import { isScopeConfirmation } from '../confirmation.js';
import { reportFile } from '../export.js';
import { ApiError, PROJECT_URL_LIMIT, type Store } from '../store.js';
import type { CatalogService } from './service.js';

export function catalogObject(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Ожидается объект JSON.');
  return body as Record<string, unknown>;
}

export function catalogId(value: unknown) {
  const id = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new ApiError(400, 'Некорректный идентификатор.');
  return id;
}

function field(value: unknown, limit: number) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f]/.test(value)) {
    throw new ApiError(400, 'Проверьте длину и формат поля.');
  }
  return value.trim() || undefined;
}

export function catalogFilter(input: unknown): CatalogFilter {
  const { sourceId, revision, domain, prefix, change, after, direction } = catalogObject(input);
  if (change !== undefined && change !== 'all' && change !== 'added' && change !== 'removed' && change !== 'changed') {
    throw new ApiError(400, 'Выберите тип изменений.');
  }
  if (direction !== undefined && direction !== 'asc' && direction !== 'desc') throw new ApiError(400, 'Выберите сортировку.');
  let path = field(prefix, 2000);
  if (path && !path.startsWith('/')) throw new ApiError(400, 'Префикс пути должен начинаться с /.');
  if (path) {
    const parsed = new URL('https://example.test');
    parsed.pathname = path;
    path = parsed.pathname;
  }
  let hostname = field(domain, 255)?.toLowerCase();
  if (hostname) {
    try {
      const host = new URL('https://' + hostname);
      if (host.pathname !== '/' || host.username || host.password || host.port || host.search || host.hash
        || /[/:?#@\\]/.test(hostname.replace(/^\[.*\]$/, ''))) throw new Error();
      hostname = host.hostname;
    } catch { throw new ApiError(400, 'Укажите домен без протокола и пути.'); }
  }
  return { sourceId: catalogId(sourceId), revision: revision === undefined ? undefined : catalogId(revision),
    domain: hostname, prefix: path, change, after: field(after, 2000), direction };
}

export function chosenUrls(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > PROJECT_URL_LIMIT
    || value.some(item => typeof item !== 'string' || !item.length || item.length > 2000)) {
    throw new ApiError(400, 'Выберите от 1 до 5 000 адресов.');
  }
  return [...new Set(value as string[])];
}

type Params = { projectId: string; jobId: string; sourceId: string };

export function registerCatalog(app: FastifyInstance, store: Store, catalog: CatalogService,
  sendDownload: (reply: FastifyReply, name: string, type: string, open: () => Readable) => Promise<FastifyReply>) {
  app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
    routes.addHook('onRequest', async request => {
      const params = request.params as Params;
      store.requireProject(catalogId(params.projectId));
    });
    routes.get<{ Params: Params }>('', async ({ params }) => {
      const id = catalogId(params.projectId);
      return { sources: catalog.db.sources(id), jobs: catalog.db.jobs(id), transfer: catalog.db.transfers.latest(id) ?? null };
    });
    routes.get<{ Params: Params }>('/clear', async ({ params }) => catalog.db.previewClear(catalogId(params.projectId)));
    routes.post<{ Params: Params }>('/clear', async ({ params, body }) => {
      const { confirmation } = catalogObject(body);
      if (!isScopeConfirmation(confirmation)) {
        throw new ApiError(400, 'Подтвердите очистку каталога.');
      }
      return catalog.clear(catalogId(params.projectId), confirmation);
    });
    routes.post<{ Params: Params }>('/transfer', async ({ params }, reply) =>
      reply.code(202).send(catalog.transfer(catalogId(params.projectId))));
    routes.post<{ Params: Params }>('/transfer/:jobId/stop', async ({ params }) =>
      catalog.stopTransfer(catalogId(params.projectId), catalogId(params.jobId)));
    routes.patch<{ Params: Params }>('/sources/:sourceId', async ({ params, body }) => {
      const url = field(catalogObject(body).url, 2000);
      if (!url) throw new ApiError(400, 'Укажите ссылку на sitemap.');
      const projectId = catalogId(params.projectId);
      catalog.assertWritable(projectId);
      return catalog.db.editSource(projectId, catalogId(params.sourceId), url);
    });
    routes.delete<{ Params: Params }>('/sources/:sourceId', async ({ params }) => {
      await catalog.deleteSource(catalogId(params.projectId), catalogId(params.sourceId));
      return { ok: true };
    });
    routes.get<{ Params: Params }>('/page', async ({ params, query }) => catalog.db.page(catalogId(params.projectId), catalogFilter(query)));
    routes.get<{ Params: Params; Querystring: { before?: string } }>('/imports/history', async ({ params, query }) =>
      catalog.db.jobHistory(catalogId(params.projectId), query.before === undefined ? undefined : catalogId(query.before)));
    routes.post<{ Params: Params }>('/imports', async ({ params, body }, reply) => {
      const { url, fileName, sourceId } = catalogObject(body);
      const name = field(fileName, 255);
      const link = field(url, 2000);
      if (link && (name || sourceId !== undefined)) throw new ApiError(400, 'Укажите ссылку или выберите источник.');
      const source = sourceId === undefined ? undefined : catalogId(sourceId);
      const project = catalogId(params.projectId);
      const job = name ? catalog.create(project, { fileName: name, sourceId: source })
        : link ? catalog.create(project, { url: link })
          : catalog.create(project, { sourceId: catalogId(source) });
      return reply.code(202).send(job);
    });
    routes.put<{ Params: Params }>('/imports/:jobId/file', async (request, reply) => {
      if (request.headers['content-type'] !== 'application/octet-stream') throw new ApiError(415, 'Ожидается файл sitemap.');
      const { params, body } = request;
      const result = await catalog.upload(catalogId(params.projectId), catalogId(params.jobId), () => body as Readable);
      return reply.code(202).send(result);
    });
    routes.post<{ Params: Params }>('/imports/:jobId/control', async ({ params, body }) => {
      const { action } = catalogObject(body);
      if (action !== 'pause' && action !== 'resume' && action !== 'cancel') throw new ApiError(400, 'Неизвестное действие.');
      return catalog.control(catalogId(params.projectId), catalogId(params.jobId), action);
    });
    routes.post<{ Params: Params }>('/actions', { bodyLimit: 12_010_000 }, async ({ params, body }, reply) => {
      const filter = catalogFilter(body);
      const { selected, limit, action } = catalogObject(body);
      const ids = chosenUrls(selected);
      const projectId = catalogId(params.projectId);
      catalog.assertWritable(projectId);
      if (!filter.revision || (ids !== undefined) === (limit !== undefined)) throw new ApiError(400, 'Укажите выборку каталога.');
      const size = limit === undefined ? 0 : catalogId(limit);
      if (size > PROJECT_URL_LIMIT) throw new ApiError(400, 'За раз можно обработать до 5 000 адресов.');
      const urls = ids ? catalog.db.selection(projectId, filter, ids)
        : catalog.db.page(projectId, { ...filter, after: undefined }, size).items.map(row => row.url);
      if (!urls.length) throw new ApiError(400, 'В выборке нет адресов.');
      if (action === 'check') return reply.code(202).send(store.enqueueCatalog(projectId, urls));
      if (action !== 'add') throw new ApiError(400, 'Выберите действие с адресами.');
      return store.addUrls(projectId, urls.map((input, line) => ({ input, line: line + 1 })), '', true);
    });
    routes.get<{ Params: Params }>('/export', async ({ params, query }, reply) => {
      const projectId = catalogId(params.projectId);
      return sendDownload(reply, reportFile(store.project(projectId).name, 'csv').name, 'text/csv; charset=utf-8',
        () => catalog.csv(projectId, catalogFilter(query)));
    });
    routes.post<{ Params: Params }>('/export', { bodyLimit: 12_010_000 }, async ({ params, body }, reply) => {
      const projectId = catalogId(params.projectId);
      return sendDownload(reply, reportFile(store.project(projectId).name, 'csv').name, 'text/csv; charset=utf-8',
        () => catalog.csv(projectId, catalogFilter(body), chosenUrls(catalogObject(body).selected)));
    });
  }, { prefix: '/api/projects/:projectId/catalog' });
}
