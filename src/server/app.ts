import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import Fastify, { type FastifyReply } from 'fastify';
import { defaultFilters, selectAddresses } from '../shared/addresses.js';
import type { PacPreview } from '../shared/pac.js';
import { ADDRESS_SORTS, CHECK_CONCURRENCY, type AddressFilters, type Settings, type TlsProfile } from '../shared/types.js';
import type { RequestProfileChoice } from '../shared/request-profiles.js';
import { registerCatalog } from './catalog/routes.js';
import type { CatalogService } from './catalog/service.js';
import { databaseBusy, type DatabaseTasks } from './database-tasks.js';
import { checkUrl, downloadPublicFile, normalizeUrl, parseProxyUrl } from './checker.js';
import { isScopeConfirmation } from './confirmation.js';
import { downloadDisposition, exportFormat, openReportStream, reportFile } from './export.js';
import { pacReferences, pacRequestOptions, pacSettings, parsePacFile, parsePacProxies, type StoredPac, withPacProxies } from './pac-config.js';
import { createPacRouteResolver, PacError, validatePac } from './pac.js';
import { MAX_SITEMAP_BYTES, readSitemap } from './sitemap.js';
import { parseReportFilters } from './report-query.js';
import { openComparisonStream } from './run-comparison-export.js';
import { parseComparisonInput } from './run-comparison-input.js';
import { configurationFailure, parseRequestProfile, profileReferences, releaseRequestSecrets, requestProfileView,
  resolveRequestOptions } from './request-profiles.js';
import { envRequestSecrets, type RequestSecrets } from './request-secrets.js';
import { ApiError, BATCH_LIMIT, PROJECT_URL_LIMIT, Store, type ExportScope } from './store.js';
import { webAccess } from './web-access.js';
import { isLocale, parseLocale } from '../shared/i18n/index.js';
import { diagnosticReference, translateDiagnostic } from '../shared/i18n/diagnostics.js';

interface AppOptions {
  database?: string;
  catalog?: CatalogService;
  tasks?: DatabaseTasks;
  store?: Store;
  origin?: string;
  webAccessKey?: string;
  staticRoot?: string;
  schedulesPaused?: () => boolean;
  onRunStopped?: (runId: number) => void;
  smtpConfigured?: boolean | (() => boolean);
  requestSecrets?: RequestSecrets;
  checkRequest?: typeof checkUrl;
  sitemap?: (source: Parameters<typeof readSitemap>[0], profile: TlsProfile) => ReturnType<typeof readSitemap>;
  logger?: boolean;
}

function object(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Ожидается объект JSON.');
  return body as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) {
    throw new ApiError(400, `Проверьте поле «${label}» (до ${limit.toLocaleString('ru')} символов).`);
  }
  return value.trim();
}

function id(value: string | undefined) {
  const number = Number(value);
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(number) || number <= 0) {
    throw new ApiError(400, 'Некорректный идентификатор.');
  }
  return number;
}

function ids(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > PROJECT_URL_LIMIT
    || value.some(item => !Number.isSafeInteger(item) || item < 1)) {
    throw new ApiError(400, 'Выберите адреса для операции.');
  }
  return value as number[];
}

function requestChoice(value: unknown): RequestProfileChoice {
  if (value === 'inherit' || value === null) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new ApiError(400, 'Выберите профиль запроса.');
}

function checkedHttpUrl(value: unknown) {
  const input = text(value, 'URL', 2000);
  try { return normalizeUrl(input); }
  catch { throw new ApiError(400, 'Укажите корректный HTTP(S)-адрес.'); }
}

async function pacOperation<T>(execute: (signal: AbortSignal) => Promise<T>) {
  const signal = AbortSignal.timeout(8_000);
  try { return await execute(signal); }
  catch (error) {
    if (error instanceof PacError) throw new ApiError(400, error.message);
    if (signal.aborted) throw new ApiError(503, 'Проверка PAC заняла слишком много времени. Повторите попытку.');
    throw error;
  }
}

function settings(body: unknown): Settings {
  const input = object(body);
  const notify = input.notify;
  const tlsProfile = input.tlsProfile;
  const checkConcurrency = input.checkConcurrency;
  if (tlsProfile !== undefined && tlsProfile !== 'default' && tlsProfile !== 'russian-ca') {
    throw new ApiError(400, 'Выберите допустимый профиль HTTPS.');
  }
  if (notify !== 'all' && notify !== 'errors' && notify !== 'off') {
    throw new ApiError(400, 'Выберите режим уведомлений.');
  }
  if (checkConcurrency !== undefined && (typeof checkConcurrency !== 'number' || !Number.isInteger(checkConcurrency)
    || checkConcurrency < CHECK_CONCURRENCY.min || checkConcurrency > CHECK_CONCURRENCY.max)) {
    throw new ApiError(400, `Укажите целое число одновременных проверок от ${CHECK_CONCURRENCY.min} до ${CHECK_CONCURRENCY.max}.`);
  }
  const email = input.email == null ? '' : text(input.email, 'Email', 254, true);
  if (email && !/^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(email)) {
    throw new ApiError(400, 'Укажите один email получателя.');
  }

  const schedule = input.schedule === null ? null : object(input.schedule);
  if (schedule === null) return { schedule, notify, tlsProfile, checkConcurrency, email: email || null };
  const { weekdays, time, timezone } = schedule;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7
    || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    || typeof timezone !== 'string' || !/^[a-z][a-z0-9_+/-]{0,79}$/i.test(timezone)) {
    throw new ApiError(400, 'Укажите дни недели, время в формате ЧЧ:ММ и часовой пояс.');
  }
  try { new Intl.DateTimeFormat('ru', { timeZone: timezone }); }
  catch { throw new ApiError(400, 'Выберите действительный часовой пояс.'); }
  return { schedule: { weekdays: [...new Set(weekdays)].sort((a, b) => a - b), time, timezone },
    notify, tlsProfile, checkConcurrency, email: email || null };
}

const assets = new Map([['.js', 'text/javascript'], ['.css', 'text/css'], ['.woff2', 'font/woff2']]);
const extractExtension = (file: string) => file.slice(file.lastIndexOf('.'));

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new Store(options.database ?? ':memory:');
  const secrets = options.requestSecrets ?? envRequestSecrets();
  const app = Fastify({ logger: options.logger ? { level: 'warn' } : false, bodyLimit: 2_100_000 });

  async function withProjectPac<T>(config: StoredPac | undefined, execute: (requestOptions: ReturnType<typeof pacRequestOptions>) => Promise<T>) {
    const refs = pacReferences(config);
    const release = store.retainRequestSecrets(refs);
    try { return await execute(pacRequestOptions(config, ref => secrets.read(ref))); }
    finally {
      release();
      await releaseRequestSecrets(store, secrets, refs);
    }
  }

  async function saveProfile(projectId: number, body: unknown, profileId?: number) {
    const previous = profileId === undefined ? undefined : store.requestProfile(projectId, profileId);
    const staged: string[] = [];
    try {
      const parsed = await parseRequestProfile(body, previous, secrets, staged);
      return requestProfileView(store.saveRequestProfile(projectId, parsed, previous), secrets.mode);
    } finally {
      await releaseRequestSecrets(store, secrets, [...staged, ...(previous ? profileReferences(previous) : [])]);
    }
  }
  const activeExports = new Map<FastifyReply['raw'], Promise<void>>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    const downloads = [...activeExports];
    for (const [response] of downloads) response.destroy();
    await Promise.all(downloads.map(([, done]) => done));
  });

  async function sendDownload(reply: FastifyReply, name: string, type: string, open: () => Readable | Promise<Readable>) {
    if (closing) throw new ApiError(503, 'Приложение завершает работу.');
    const response = reply.raw;
    let release!: () => void;
    activeExports.set(response, new Promise<void>(resolve => { release = resolve; }));
    const responseDone = new Promise<void>(resolve => {
      response.once('close', resolve);
      response.once('finish', resolve);
    });
    const forget = () => {
      activeExports.delete(response);
      release();
    };
    try {
      const stream = await open();
      const streamDone = finished(stream, { cleanup: true }).catch(() => {});
      void Promise.all([responseDone, streamDone]).then(forget);
      if (response.destroyed) {
        stream.destroy();
        return reply;
      }
      response.once('close', () => stream.destroy());
      return reply.header('Content-Disposition', downloadDisposition(name)).type(type).send(stream);
    } catch (error) {
      forget();
      throw error;
    }
  }

  function sendExport(reply: FastifyReply, projectId: number, query: Record<string, unknown>,
    scope: ExportScope = {}) {
    const kind = exportFormat(query.format ?? 'csv');
    const locale = kind === 'excel' && isLocale(query.locale) ? query.locale : undefined;
    const filters = parseReportFilters(query);
    return sendDownload(reply, reportFile(store.project(projectId).name, kind, undefined, locale).name,
      kind === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      () => openReportStream(store, projectId, scope, filters, kind, options.tasks, locale));
  }
  const origin = options.origin ?? 'http://127.0.0.1:8731';
  const hosts = [new URL(origin).host, new URL(origin.replace('127.0.0.1', 'localhost')).host];
  const access = options.webAccessKey === undefined ? undefined : webAccess(options.webAccessKey);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      .header('Referrer-Policy', 'no-referrer');
    if (options.origin && !hosts.includes(request.headers.host ?? '')) {
      throw new ApiError(403, 'Используйте локальный адрес приложения.');
    }
    const apiRoute = request.routeOptions.url?.startsWith('/api/') === true;
    const secured = access && apiRoute && request.routeOptions.url !== '/api/session';
    if (request.method !== 'GET' && request.method !== 'HEAD' &&
      ((access && apiRoute) || request.headers.origin) && !hosts.some(host => request.headers.origin === `http://${host}`)) {
      throw new ApiError(403, 'Запрос должен исходить из приложения.');
    }
    if (secured && !access.acceptsSession(request.headers.cookie)) {
      throw new ApiError(401, 'Откройте ссылку доступа из терминала, в котором запущен Пульс URL.');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const requested = request.query as { format?: unknown; locale?: unknown } | undefined;
    const structured = request.headers['x-urlpulse-i18n'] === '1';
    const localizedDownload = !structured && requested?.format === 'excel' && request.routeOptions.url?.endsWith('/export');
    const sendError = (status: number, message: string) => reply.code(status).send({
      error: localizedDownload ? translateDiagnostic(message, parseLocale(requested.locale)) : message,
      ...(structured ? diagnosticReference(message) : undefined),
    });
    if (databaseBusy(error)) return sendError(503, 'База занята. Повторите действие через несколько секунд.');
    if (error instanceof ApiError) return sendError(error.statusCode, error.message);
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return sendError(status, status === 413
      ? 'Превышен допустимый размер запроса.' : 'Некорректный запрос.');
    app.log.error(error);
    return sendError(500, 'Внутренняя ошибка приложения.');
  });
  if (!options.store) app.addHook('onClose', async () => store.close());
  if (access) app.post('/api/session', async (request, reply) => {
    const data = object(request.body);
    if (!access.acceptsKey(data.key)) throw new ApiError(401, 'Ключ доступа недействителен. Возьмите актуальную ссылку из терминала.');
    return reply.header('Set-Cookie', access.setCookie).code(204).send();
  });

  app.get('/api/projects', async () => ({
    projects: store.projects(), unread: store.unread(), schedulesPaused: options.schedulesPaused?.(), smtpConfigured: typeof options.smtpConfigured === 'function' ? options.smtpConfigured() : !!options.smtpConfigured,
  }));
  app.post('/api/projects', async (request, reply) => {
    const data = object(request.body);
    return reply.code(201).send(store.createProject(text(data.name, 'Название', 70), text(data.description, 'Описание', 200, true)));
  });

  type ProjectParams = { projectId: string };
  type UrlParams = ProjectParams & { urlId: string };
  type RunParams = ProjectParams & { runId: string };
  type GroupParams = ProjectParams & { groupId: string };
  type ProfileParams = ProjectParams & { profileId: string };
  type Query = Record<string, string | undefined>;

  app.register(async projects => {
    projects.addHook('preHandler', async request => {
      store.requireProject(id((request.params as ProjectParams).projectId));
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('', async ({ params, query }) => {
      const projectId = id(params.projectId);
      const revision = store.revision(projectId);
      if (query.since === revision) return { unchanged: true };
      if (query.view === 'summary') {
        const { viewRevision, ...overview } = await (options.tasks?.run('overview', projectId) ?? store.overview(projectId));
        return { revision: store.revision(projectId, viewRevision), ...overview };
      }
      return store.projectWithAddresses(projectId, query.view === 'table');
    });
    projects.patch<{ Params: ProjectParams }>('', async ({ params, body }) => {
      const input = object(body);
      const description = input.description === undefined ? undefined : text(input.description, 'Описание', 200, true);
      return store.editProject(id(params.projectId), text(input.name, 'Название', 70), description);
    });
    projects.delete<{ Params: ProjectParams }>('', async ({ params }) => {
      const project = id(params.projectId);
      const refs = secrets.mode === 'desktop' ? store.activeProjectRequestSecrets(project) : [];
      const result = await (options.tasks?.run('deleteProject', project) ?? store.deleteProject(project));
      await releaseRequestSecrets(store, secrets, refs);
      return result;
    });
    projects.patch<{ Params: ProjectParams }>('/settings', async request => store.saveSettings(
      id(request.params.projectId), settings(request.body),
    ));
    projects.get<{ Params: ProjectParams }>('/proxy-pac', async ({ params }) =>
      pacSettings(store.projectPac(id(params.projectId)), secrets.mode));
    projects.put<{ Params: ProjectParams }>('/proxy-pac', async ({ params, body }) => {
      const input = object(body);
      let config;
      try { config = parsePacFile(input.filename, input.source); }
      catch (error) { throw new ApiError(400, (error as Error).message); }
      await pacOperation(signal => validatePac(config.source, signal));
      const projectId = id(params.projectId);
      const updated = withPacProxies(config, store.projectPac(projectId)?.proxies);
      return pacSettings(store.savePac(projectId, updated), secrets.mode);
    });
    projects.patch<{ Params: ProjectParams }>('/proxy-pac', async ({ params, body }) => {
      const projectId = id(params.projectId);
      const previous = store.projectPac(projectId);
      if (!previous) throw new ApiError(404, 'Загрузите PAC-файл для проекта.');
      const input = object(body);
      if (input.revision !== previous.revision) throw new ApiError(409, 'Настройки PAC изменились. Обновите данные и повторите действие.');
      const staged: string[] = [];
      try {
        const config = await parsePacProxies(input.proxies, previous, secrets, staged);
        return pacSettings(store.savePac(projectId, config, previous.revision), secrets.mode);
      } finally {
        await releaseRequestSecrets(store, secrets, [...staged, ...pacReferences(previous)]);
      }
    });
    projects.delete<{ Params: ProjectParams }>('/proxy-pac', async ({ params }) => {
      const projectId = id(params.projectId);
      const refs = pacReferences(store.projectPac(projectId));
      store.savePac(projectId);
      await releaseRequestSecrets(store, secrets, refs);
      return pacSettings();
    });
    projects.post<{ Params: ProjectParams }>('/proxy-pac/test', async ({ params, body }): Promise<PacPreview> => {
      const projectId = id(params.projectId);
      const config = store.projectPac(projectId);
      if (!config) throw new ApiError(404, 'Загрузите PAC-файл для проекта.');
      const url = new URL(checkedHttpUrl(object(body).url));
      const choice = store.requestChoiceForUrl(projectId, url.href);
      if (choice === null) return { routes: [{ kind: 'direct' }], source: 'direct' };
      const profile = typeof choice === 'number' ? store.requestProfile(projectId, choice)
        : store.requestProfiles(projectId).find(entry => entry.isDefault && entry.origin === url.origin);
      if (profile?.proxy) return { routes: [{ kind: 'proxy', url: profile.proxy.url }], source: 'profile' };
      const resolve = createPacRouteResolver(config.source);
      const routes = await pacOperation(signal => resolve(url, signal));
      const first = routes[0];
      if (first?.kind === 'proxy') {
        if (url.protocol === 'http:') {
          throw new ApiError(400, 'PAC выбрал прокси. В Пульсе URL этот маршрут доступен для HTTPS-адресов.');
        }
        const rule = config.proxies?.find(proxy => proxy.url === first.url);
        try { parseProxyUrl({ url: first.url }, rule); }
        catch {
          throw new ApiError(400, rule ? 'Адрес доверенного прокси недоступен или запрещён.'
            : 'Первый маршрут PAC должен указывать на публичный прокси.');
        }
      }
      return { routes, source: 'pac' };
    });
    projects.get<{ Params: ProjectParams }>('/request-profiles', async ({ params }) => ({
      profiles: store.requestProfiles(id(params.projectId)).map(profile => requestProfileView(profile, secrets.mode)),
      secretMode: secrets.mode,
    }));
    projects.post<{ Params: ProjectParams }>('/request-profiles', async ({ params, body }, reply) =>
      reply.code(201).send(await saveProfile(id(params.projectId), body)));
    projects.patch<{ Params: ProfileParams }>('/request-profiles/:profileId', async ({ params, body }) =>
      saveProfile(id(params.projectId), body, id(params.profileId)));
    projects.delete<{ Params: ProfileParams }>('/request-profiles/:profileId', async ({ params }) => {
      const removed = store.deleteRequestProfile(id(params.projectId), id(params.profileId));
      await releaseRequestSecrets(store, secrets, profileReferences(removed));
      return { deleted: true };
    });
    projects.post<{ Params: ProfileParams }>('/request-profiles/:profileId/test', async ({ params, body }) => {
      const projectId = id(params.projectId);
      const profile = store.requestProfile(projectId, id(params.profileId));
      const url = checkedHttpUrl(object(body).url);
      if (new URL(url).origin !== profile.origin) throw new ApiError(400, 'Профиль настроен для другого сервера.');
      const requestOptions = await resolveRequestOptions(profile, secrets).catch(() => undefined);
      if (!requestOptions) return configurationFailure(url, profile);
      const projectPac = requestOptions.proxy ? undefined : store.projectPac(projectId);
      return withProjectPac(projectPac, pacOptions => (options.checkRequest ?? checkUrl)(url,
        { tlsProfile: store.project(projectId).tlsProfile, requestOptions, ...pacOptions }));
    });
    projects.get<{ Params: ProjectParams }>('/groups', async ({ params }) => {
      const project = id(params.projectId);
      return options.tasks?.run('groups', project) ?? store.groups(project);
    });
    projects.post<{ Params: ProjectParams }>('/groups', async ({ params, body }, reply) =>
      reply.code(201).send(store.saveGroup(id(params.projectId), text(object(body).name, 'Название группы', 70))));
    projects.patch<{ Params: GroupParams }>('/groups/:groupId', async ({ params, body }) =>
      store.saveGroup(id(params.projectId), text(object(body).name, 'Название группы', 70), id(params.groupId)));
    projects.delete<{ Params: GroupParams }>('/groups/:groupId', async ({ params }) => {
      const project = id(params.projectId);
      const group = id(params.groupId);
      return options.tasks?.run('deleteGroup', project, group) ?? store.deleteGroup(project, group);
    });
    projects.patch<{ Params: GroupParams }>('/groups/:groupId/members', async ({ params, body }) => {
      const input = object(body);
      if (input.operation !== 'add' && input.operation !== 'remove') throw new ApiError(400, 'Укажите действие с адресами группы.');
      return store.changeGroupMembers(id(params.projectId), id(params.groupId), input.operation, ids(input.ids));
    });
    projects.get<{ Params: GroupParams; Querystring: Query }>('/groups/:groupId/runs', async ({ params, query }) =>
      store.runPage(id(params.projectId), query.before ? id(query.before) : undefined, id(params.groupId)));
    projects.post<{ Params: GroupParams }>('/groups/:groupId/runs', async ({ params }, reply) => {
      const project = id(params.projectId);
      const group = id(params.groupId);
      const run = await (options.tasks?.run('enqueueGroup', project, group) ?? store.enqueueGroup(project, group));
      return reply.code(202).send(run);
    });
    projects.get<{ Params: GroupParams; Querystring: Query }>('/groups/:groupId/export', async ({ params, query }, reply) =>
      sendExport(reply, id(params.projectId), query, { groupId: id(params.groupId) }));
    function addressFilters(query: Query): AddressFilters {
      return {
        groupId: query.group === undefined ? undefined : id(query.group),
        q: text(query.q, 'Поиск по адресам', 2000, true),
        status: query.status === 'ok' || query.status === 'error' || query.status === 'unchecked' ? query.status : 'all',
        sort: ADDRESS_SORTS.find(sort => sort === query.sort) ?? defaultFilters.sort,
        direction: query.direction === 'desc' ? 'desc' : 'asc',
      };
    }
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/urls', async ({ params, query }) => {
      const project = id(params.projectId);
      if (store.project(project).urlCount > PROJECT_URL_LIMIT) throw new ApiError(413, 'Для большого списка используйте GET /urls/page.');
      const filters = addressFilters(query);
      return selectAddresses(store.addresses(project, filters.groupId), filters);
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/urls/page', async ({ params, query }) => {
      const project = id(params.projectId);
      const filters = addressFilters(query);
      const page = query.page ? id(query.page) : 1;
      return options.tasks?.run('page', project, filters, page) ?? store.worklist.page(project, filters, page);
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/urls/selection', async ({ params, query }) => {
      const project = id(params.projectId);
      const filters = addressFilters(query);
      return options.tasks?.run('selection', project, filters) ?? store.worklist.selection(project, filters, PROJECT_URL_LIMIT);
    });
    projects.post<{ Params: ProjectParams }>('/urls', { bodyLimit: 12_010_000 }, async (request, reply) => {
      const data = object(request.body);
      const input = data.input;
      if (typeof input !== 'string' || input.length > 2_001_000 || !input.trim()) {
        throw new ApiError(400, 'Вставьте непустой список адресов длиной до 2 001 000 символов.');
      }
      const candidates = input.split(/\r\n|\r|\n/).map((value, index) => ({ input: value, line: index + 1 }))
        .filter(entry => entry.input.trim());
      if (candidates.length > BATCH_LIMIT) throw new ApiError(400, 'Можно добавить до 1 000 адресов за раз.');
      return reply.code(201).send(store.addUrls(id(request.params.projectId), candidates,
        candidates.length === 1 ? text(data.label, 'Название адреса', 100, true) : ''));
    });
    projects.post<{ Params: ProjectParams }>('/urls/sitemap', {
      bodyLimit: Math.ceil(MAX_SITEMAP_BYTES / 3) * 4 + 1024,
    }, async (request, reply) => {
      const data = object(request.body);
      if ((typeof data.file === 'string') === (typeof data.url === 'string')) {
        throw new ApiError(400, 'Выберите файл или ссылку на sitemap.');
      }
      let source: { file: Buffer } | { url: string };
      if (typeof data.file === 'string') {
        if (!data.file || data.file.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data.file)) {
          throw new ApiError(400, 'Некорректный файл sitemap.');
        }
        source = { file: Buffer.from(data.file, 'base64') };
      } else {
        source = { url: text(data.url, 'Ссылка на sitemap', 2000) };
      }
      let found: Awaited<ReturnType<typeof readSitemap>>;
      const projectId = id(request.params.projectId);
      const { tlsProfile } = store.project(projectId);
      try {
        found = options.sitemap ? await options.sitemap(source, tlsProfile)
          : await withProjectPac(store.projectPac(projectId), network =>
            readSitemap(source, (url, size, timeout) => downloadPublicFile(url, size, timeout, tlsProfile, network)));
      }
      catch (error) { throw new ApiError(422, (error as Error).message.slice(0, 250)); }
      const imported = store.addUrls(projectId,
        found.urls.map((input, index) => ({ input, line: index + 1 })), '', true);
      return reply.code(201).send({ ...imported, documents: found.documents });
    });
    projects.post<{ Params: ProjectParams; Querystring: Query }>('/urls/delete/preview', async ({ params, query, body }) =>
      store.previewDeletion(id(params.projectId), ids(object(body).ids), addressFilters(query)));
    projects.post<{ Params: ProjectParams }>('/urls/delete', async ({ params, body }) => {
      const input = object(body);
      return store.deleteUrls(id(params.projectId), ids(input.ids), input.versions === undefined ? undefined : ids(input.versions));
    });
    projects.get<{ Params: ProjectParams }>('/urls/delete/all', async ({ params }) => {
      const project = id(params.projectId);
      return options.tasks?.run('previewDeleteAll', project) ?? store.previewDeleteAll(project);
    });
    projects.post<{ Params: ProjectParams }>('/urls/delete/all', async ({ params, body }) => {
      const project = id(params.projectId);
      const { confirmation } = object(body);
      if (!isScopeConfirmation(confirmation)) {
        throw new ApiError(400, 'Подтвердите область удаления адресов.');
      }
      const refs = secrets.mode === 'desktop' ? store.activeProjectRequestSecrets(project) : [];
      const { deleted, stopped, runningIds } = await (options.tasks?.run('deleteAllUrls', project, confirmation)
        ?? store.deleteAllUrls(project, confirmation));
      for (const run of runningIds) options.onRunStopped?.(run);
      await releaseRequestSecrets(store, secrets, refs);
      return { deleted, stopped };
    });
    projects.get<{ Params: UrlParams; Querystring: Query }>('/urls/:urlId', async ({ params, query }) => {
      const projectId = id(params.projectId);
      const urlId = id(params.urlId);
      const before = query.before === undefined ? undefined : id(query.before);
      const beforeAt = query.beforeAt;
      if (beforeAt !== undefined && (before === undefined
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(beforeAt) || !Number.isFinite(Date.parse(beforeAt)))) {
        throw new ApiError(400, 'Некорректная дата страницы истории.');
      }
      const address = store.address(projectId, urlId);
      return { address: { ...address, latest: store.latestAddressResult(urlId, address.version) }, versions: store.versions(urlId),
        history: store.history(urlId, before, beforeAt) };
    });
    projects.patch<{ Params: UrlParams }>('/urls/:urlId', async ({ params, body }) => {
      const input = object(body);
      return store.editUrl(id(params.projectId), id(params.urlId), text(input.url, 'URL', 2000),
        text(input.label, 'Название адреса', 100, true), input.profileId === undefined ? undefined : requestChoice(input.profileId));
    });
    projects.get<{ Params: UrlParams }>('/urls/:urlId/request-profile', async ({ params }) => ({
      profileId: store.requestChoice(id(params.projectId), id(params.urlId)),
    }));
    projects.patch<{ Params: UrlParams }>('/urls/:urlId/request-profile', async ({ params, body }) =>
      store.saveRequestChoice(id(params.projectId), id(params.urlId), requestChoice(object(body).profileId)));
    projects.post<{ Params: UrlParams }>('/urls/:urlId/restore', async ({ params }) =>
      store.restoreUrl(id(params.projectId), id(params.urlId)));
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/runs', async ({ params, query }) => {
      const projectId = id(params.projectId);
      if (query.view === 'queue') return store.queuedRuns(projectId);
      const before = query.before ? id(query.before) : undefined;
      if (query.view === 'compare-options') {
        return options.tasks?.run('comparisonOptions', projectId, before) ?? store.comparisonOptions(projectId, before);
      }
      return query.view === 'page' ? store.runPage(projectId, before) : store.runs(projectId, before);
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/run-comparison', async ({ params, query }) => {
      const projectId = id(params.projectId);
      const input = parseComparisonInput(query);
      const after = query.after === undefined ? 0 : id(query.after);
      if (query.view === 'summary') {
        return options.tasks?.run('comparisonSummary', projectId, input) ?? store.comparisonSummary(projectId, input);
      }
      if (query.view !== undefined) throw new ApiError(400, 'Выберите сводку или страницу сравнения.');
      return options.tasks?.run('comparisonPage', projectId, input, after) ?? store.comparisonPage(projectId, input, after);
    });
    projects.head<{ Params: ProjectParams; Querystring: Query }>('/run-comparison/export', async ({ params, query }, reply) => {
      const projectId = id(params.projectId);
      const input = parseComparisonInput(query);
      exportFormat(query.format ?? 'csv');
      store.comparisonPair(projectId, input);
      return reply.send('');
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/run-comparison/export', { exposeHeadRoute: false }, async ({ params, query }, reply) => {
      const projectId = id(params.projectId);
      const input = parseComparisonInput(query);
      const format = exportFormat(query.format ?? 'csv');
      const locale = parseLocale(format === 'excel' ? query.locale : undefined);
      return sendDownload(reply, reportFile(store.project(projectId).name, format, undefined, locale).name,
        format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        () => openComparisonStream(store, projectId, input, format, options.tasks, locale));
    });
    projects.post<{ Params: ProjectParams }>('/runs', async (request, reply) => {
      const input = object(request.body);
      const project = id(request.params.projectId);
      const run = input.ids === undefined ? await (options.tasks?.run('enqueue', project) ?? store.enqueue(project))
        : store.enqueue(project, ids(input.ids));
      return reply.code(202).send(run);
    });
    projects.get<{ Params: RunParams; Querystring: Query }>('/runs/:runId', async ({ params, query }) => {
      const runId = id(params.runId);
      const projectId = id(params.projectId);
      const filters = parseReportFilters(query);
      const after = query.after ? id(query.after) : 0;
      return options.tasks?.run('report', projectId, runId, filters, after) ?? store.report(projectId, runId, filters, after);
    });
    projects.post<{ Params: RunParams }>('/runs/:runId/stop', async ({ params }) => {
      const project = id(params.projectId);
      const run = id(params.runId);
      const result = await (options.tasks?.run('stopRun', project, run) ?? store.stopRun(project, run));
      if (result.status === 'cancelled') {
        options.onRunStopped?.(run);
        if (secrets.mode === 'desktop') await releaseRequestSecrets(store, secrets,
          [...store.requestSnapshot(run).flatMap(profileReferences), ...pacReferences(store.pacSnapshot(run))]);
      }
      return result;
    });
    projects.post<{ Params: RunParams }>('/runs/:runId/restart', async ({ params }, reply) => {
      const project = id(params.projectId);
      const run = id(params.runId);
      const restarted = await (options.tasks?.run('restartRun', project, run) ?? store.restartRun(project, run));
      return reply.code(202).send(restarted);
    });
    projects.delete<{ Params: RunParams }>('/runs/:runId', async ({ params }) => {
      const project = id(params.projectId);
      const run = id(params.runId);
      return options.tasks?.run('deleteRun', project, run) ?? store.deleteRun(project, run);
    });
    projects.get<{ Params: ProjectParams; Querystring: Query }>('/export', async ({ params, query }, reply) =>
      sendExport(reply, id(params.projectId), query));
    projects.get<{ Params: UrlParams; Querystring: Query }>('/urls/:urlId/export', async ({ params, query }, reply) => {
      const scope = { urlId: id(params.urlId) };
      return sendExport(reply, id(params.projectId), query, scope);
    });
    projects.get<{ Params: RunParams; Querystring: Query }>('/runs/:runId/export', async ({ params, query }, reply) => {
      const scope = { runId: id(params.runId) };
      return sendExport(reply, id(params.projectId), query, scope);
    });
  }, { prefix: '/api/projects/:projectId' });

  if (options.catalog) registerCatalog(app, store, options.catalog, sendDownload);

  app.get<{ Querystring: Query }>('/api/notifications', async ({ query }) => {
    const before = query.before ? id(query.before) : undefined;
    return query.view === 'page' ? store.notificationPage(before) : store.notifications(before);
  });
  app.post('/api/notifications/clear', async () => store.clearNotifications());
  app.post('/api/notifications/read', async () => {
    store.markRead();
    return { ok: true };
  });
  app.post<{ Params: { notificationId: string } }>('/api/notifications/:notificationId/read', async ({ params }) => {
    store.markRead(id(params.notificationId));
    return { ok: true };
  });

  if (options.staticRoot) {
    const root = options.staticRoot;
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(join(root, 'index.html'))));
    app.get('/pulse-icon.png', async (_request, reply) => reply.type('image/png').send(await readFile(join(root, 'pulse-icon.png'))));
    app.get<{ Params: { file: string } }>('/assets/:file', async ({ params }, reply) => {
      const { file } = params;
      const type = assets.get(extractExtension(file));
      if (!type || !/^[a-z0-9._-]+$/i.test(file)) throw new ApiError(404, 'Файл не найден.');
      const content = await readFile(join(root, 'assets', file)).catch(() => { throw new ApiError(404, 'Файл не найден.'); });
      return reply.type(type).header('Cache-Control', 'public, max-age=31536000, immutable').send(content);
    });
  }
  return app;
}
