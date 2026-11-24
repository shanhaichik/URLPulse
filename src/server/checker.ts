import { lookup } from 'node:dns/promises';
import { request as httpRequest, validateHeaderValue, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import ipaddr from 'ipaddr.js';
import type { PacRoute, PacRouteResolver } from '../shared/pac.js';
import type { ResolvedRequestOptions } from '../shared/request-profiles.js';
import type { CheckResult, TlsProfile } from '../shared/types.js';
import { PacError } from './pac.js';
import { connectTargetTls, openProxyTunnel, pinnedLookup, ProxyRequestError, type Endpoint } from './request-proxy.js';
import { russianTrustRoots, TlsProfileError } from './tls-profile.js';

type ErrorKind = NonNullable<CheckResult['errorKind']>;
class RequestError extends Error {
  constructor(readonly kind: ErrorKind, message: string) { super(message); }
}

interface HttpResult { code: number; headers: IncomingHttpHeaders; body?: Buffer; stream?: IncomingMessage }
type Resolve = (hostname: string) => Promise<Endpoint[]>;
type Request = (url: URL, addresses: Endpoint[], signal: AbortSignal, maxBytes: number, ca: string[] | undefined,
  stream: boolean | undefined, headers: Record<string, string>) => Promise<HttpResult>;
interface Options {
  resolve?: Resolve;
  request?: Request;
  timeoutMs?: number;
  tlsProfile?: TlsProfile;
  signal?: AbortSignal;
  stream?: boolean;
  requestOptions?: ResolvedRequestOptions;
  pac?: PacRouteResolver;
}

const redirectCodes = new Set([301, 302, 303, 307, 308]);
const retryableProxyCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
]);
const bareHost = (value: string) => value.replace(/^\[|\]$/g, '');
const globalIPv6 = ipaddr.parse('2000::');

function publicIp(value: string) {
  const address = ipaddr.process(value);
  if (address.range() !== 'unicast') return false;
  if (address.kind() === 'ipv4') return true;
  return (address as ipaddr.IPv6).match(globalIPv6 as ipaddr.IPv6, 3)
    && !(address as ipaddr.IPv6).match(ipaddr.IPv6.parse('3fff::'), 20);
}

export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 2000 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new RequestError('blocked', 'Некорректный адрес. Уберите пробелы и проверьте длину.');
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new RequestError('blocked', 'Некорректный формат URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RequestError('blocked', 'Допустимы только HTTP и HTTPS.');
  }
  if (url.username || url.password || url.port === '0') {
    throw new RequestError('blocked', 'Проверьте порт и уберите учётные данные из URL.');
  }
  const host = bareHost(url.hostname).replace(/\.$/, '');
  if (isIP(host) ? !publicIp(host) : !host.includes('.') || !/^[a-z\d.-]+$/i.test(host)) {
    throw new RequestError('blocked', 'Укажите публичное доменное имя или IP-адрес.');
  }
  if (!isIP(host)) url.hostname = host;
  url.hash = '';
  if (url.href.length > 2000) throw new RequestError('blocked', 'URL после нормализации превышает 2 000 символов.');
  return url.href;
}

export function withDeadline<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const defaultResolve: Resolve = host => lookup(host, { all: true, order: 'ipv4first' });

const defaultHeaders = { 'user-agent': 'URL-Pulse/1.0', accept: '*/*', connection: 'close' };

function sendTargetRequest(url: URL, addresses: Endpoint[], signal: AbortSignal, maxBytes: number,
  ca: string[] | undefined, stream: boolean | undefined, headers: Record<string, string>, tunnel?: Duplex) {
  return new Promise<HttpResult>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const host = bareHost(url.hostname);
    const request = send({
      hostname: host,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'GET',
      ...(tunnel ? { createConnection: () => connectTargetTls(tunnel, host, ca) } : {
        agent: false,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
        ...(ca ? { ca } : {}),
        lookup: pinnedLookup(addresses),
      }),
      signal,
      headers,
    }, response => {
      const code = response.statusCode ?? 0;
      const result: HttpResult = { code, headers: response.headers };
      if (stream && code >= 200 && code < 300) {
        resolve({ ...result, stream: response });
        return;
      }
      if (!maxBytes || code < 200 || code >= 300) {
        resolve(result);
        response.destroy();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new RequestError('connection', 'Sitemap превышает допустимый размер.');
          reject(error);
          response.destroy(error);
        } else {
          chunks.push(chunk);
        }
      });
      response.on('error', reject);
      response.on('end', () => resolve({ ...result, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function resolvePublicHost(host: string, resolve: Resolve, signal: AbortSignal): Promise<Endpoint[]> {
  const family = isIP(host);
  let addresses: Endpoint[];
  try {
    addresses = family ? [{ address: host, family }] : await withDeadline(resolve(host), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RequestError) throw error;
    throw new RequestError('dns', 'Не удалось разрешить имя хоста (DNS).');
  }
  if (!addresses.length) throw new RequestError('dns', 'DNS не вернул IP-адрес.');
  if (addresses.some(({ address, family }) => !family || isIP(address) !== family || !publicIp(address))) {
    throw new RequestError('blocked', 'Хост разрешается в непубличный IP-адрес.');
  }
  return addresses;
}

function parseProxyUrl(config: NonNullable<ResolvedRequestOptions['proxy']>) {
  try {
    if (!/^https?:\/\/[^/?#@\\]+\/?$/i.test(config.url)) throw new Error();
    const url = new URL(normalizeUrl(config.url));
    if (config.authorization !== undefined) {
      if (url.protocol !== 'https:') throw new Error();
      validateHeaderValue('proxy-authorization', config.authorization);
    }
    return url;
  } catch {
    throw new RequestError('configuration', 'Проверьте адрес прокси. Для авторизации прокси требуется HTTPS.');
  }
}

function headersForHop(url: URL, profile?: ResolvedRequestOptions) {
  const headers: Record<string, string> = Object.assign(Object.create(null), defaultHeaders);
  if (!profile || url.origin !== profile.origin) return headers;
  for (const [name, value] of Object.entries(profile.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'proxy-authorization' || lower === 'host' || lower === 'connection') continue;
    if (url.protocol !== 'https:' && (lower === 'authorization' || profile.protectedValues.includes(value))) {
      throw new RequestError('configuration', 'Для секретных заголовков сайта требуется HTTPS.');
    }
    headers[lower] = value;
  }
  return headers;
}

interface RequestProgress {
  finalUrl: string;
  redirects: number;
  response?: HttpResult;
  stage?: 'pac' | 'proxy' | 'target';
  route?: NonNullable<CheckResult['requestRoute']>;
  proxy?: string;
}

async function proxyTunnel(proxy: URL, authorization: string | undefined, target: URL, targetAddress: Endpoint,
  resolve: Resolve, signal: AbortSignal) {
  let addresses: Endpoint[];
  try {
    addresses = await resolvePublicHost(bareHost(proxy.hostname), resolve, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ProxyRequestError('Прокси должен разрешаться в публичный IP-адрес.', null, error);
  }
  return openProxyTunnel(proxy, addresses, authorization, target, targetAddress, signal);
}

const pacSelectionError = () => new RequestError('configuration', 'Не удалось выбрать маршрут по PAC.');

async function resolvePacRoutes(pac: PacRouteResolver, url: URL, signal: AbortSignal) {
  try {
    signal.throwIfAborted();
    const routes = await withDeadline(pac(new URL(url), signal), signal);
    if (routes.length) return routes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PacError) throw new RequestError('configuration', error.message);
  }
  throw pacSelectionError();
}

function canRetryProxy(error: unknown) {
  if (error instanceof RequestError) return error.kind === 'timeout';
  if (!(error instanceof ProxyRequestError) || error.httpCode !== null) return false;
  const cause = error.cause;
  if (cause instanceof RequestError) return cause.kind === 'dns';
  return retryableProxyCodes.has((cause as NodeJS.ErrnoException | undefined)?.code ?? '');
}

async function openPacRoute(routes: PacRoute[], target: URL, targetAddress: Endpoint, resolve: Resolve,
  signal: AbortSignal, deadline: number, progress: RequestProgress) {
  for (const [index, route] of routes.entries()) {
    signal.throwIfAborted();
    if (route.kind === 'direct') {
      progress.route = 'direct';
      progress.proxy = undefined;
      return undefined;
    }

    progress.stage = 'pac';
    progress.route = undefined;
    progress.proxy = undefined;
    const proxy = parseProxyUrl({ url: route.url });
    progress.route = 'proxy';
    progress.proxy = proxy.origin;
    if (target.protocol !== 'https:') {
      throw new RequestError('configuration', 'Прокси поддерживает только адреса HTTPS.');
    }
    progress.stage = 'proxy';
    const remaining = routes.length - index;
    if (remaining === 1) return proxyTunnel(proxy, undefined, target, targetAddress, resolve, signal);

    // Reserve time for the remaining routes if this proxy's DNS or CONNECT stalls.
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(new RequestError('timeout', 'Истекло время подключения к прокси.')),
      (deadline - performance.now()) / remaining);
    try {
      return await proxyTunnel(proxy, undefined, target, targetAddress, resolve, AbortSignal.any([signal, attempt.signal]));
    } catch (error) {
      signal.throwIfAborted();
      if (!canRetryProxy(error)) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw pacSelectionError();
}

async function follow(input: string, progress: RequestProgress, maxBytes: number, options: Options) {
  const timeout = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => timeout.abort(new RequestError('timeout', 'Истекло время ожидания ответа.')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
  try {
    let url = new URL(normalizeUrl(input));
    const profile = options.requestOptions;
    const proxy = profile?.proxy ? parseProxyUrl(profile.proxy) : undefined;
    const pac = proxy ? undefined : options.pac;
    progress.proxy = proxy?.origin;
    const resolve = options.resolve ?? defaultResolve;
    let additionalCa: string[] | undefined;
    while (true) {
      progress.finalUrl = url.href;
      progress.response = undefined;
      progress.stage = 'target';
      if (proxy && url.protocol !== 'https:') {
        throw new RequestError(progress.redirects ? 'blocked' : 'configuration', 'Прокси поддерживает только адреса HTTPS.');
      }
      let routes: PacRoute[] | undefined;
      if (pac) {
        progress.stage = 'pac';
        routes = await resolvePacRoutes(pac, url, signal);
        progress.stage = 'target';
      }
      const headers = headersForHop(url, profile);
      const addresses = await resolvePublicHost(bareHost(url.hostname), resolve, signal);
      const ca = url.protocol === 'https:' && options.tlsProfile === 'russian-ca'
        ? additionalCa ??= russianTrustRoots() : undefined;
      let tunnel: Duplex | undefined;
      if (proxy) {
        progress.stage = 'proxy';
        tunnel = await proxyTunnel(proxy, profile?.proxy?.authorization, url, addresses[0], resolve, signal);
      } else if (routes) tunnel = await openPacRoute(routes, url, addresses[0], resolve, signal, deadline, progress);
      progress.stage = 'target';
      let response: HttpResult;
      try {
        signal.throwIfAborted();
        response = await withDeadline(
          (tunnel ? sendTargetRequest : options.request ?? sendTargetRequest)(
            url, addresses, signal, maxBytes, ca, options.stream, headers, tunnel),
          signal,
        );
      } catch (error) {
        tunnel?.destroy();
        throw error;
      }
      progress.response = response;
      const location = response.headers.location;
      if (!redirectCodes.has(response.code) || !location) return response;
      if (progress.redirects >= 5) throw new RequestError('redirect', 'Превышен лимит из пяти перенаправлений.');
      progress.redirects++;
      let next: URL;
      try { next = new URL(location, url); }
      catch { throw new RequestError('redirect', 'Некорректный адрес перенаправления.'); }
      progress.finalUrl = next.href;
      if (pac) {
        progress.route = undefined;
        progress.proxy = undefined;
      }
      url = new URL(normalizeUrl(next.href));
    }
  } finally {
    clearTimeout(timer);
  }
}

function classify(error: unknown): { errorKind: ErrorKind; error: string; tlsCode?: string; proxyHttpCode?: number | null } {
  if (error instanceof ProxyRequestError) {
    const tlsCode = error.cause ? classify(error.cause).tlsCode : undefined;
    return { errorKind: 'proxy', error: error.message, tlsCode, proxyHttpCode: error.httpCode };
  }
  if (error instanceof TlsProfileError) return { errorKind: 'tls', tlsCode: error.code, error: error.message };
  if (error instanceof RequestError) return { errorKind: error.kind, error: error.message };
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (/^EAI_|^(ENOTFOUND|ENODATA)$/.test(code)) {
    return { errorKind: 'dns', error: 'Не удалось разрешить имя хоста (DNS).' };
  }
  if (/^(ERR_TLS|ERR_SSL|CERT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO)/.test(code)) {
    const messages: Record<string, string> = {
      CERT_HAS_EXPIRED: 'Срок действия сертификата истёк.',
      CERT_NOT_YET_VALID: 'Срок действия сертификата ещё не начался.',
      CERT_REVOKED: 'Сертификат отозван.',
      ERR_TLS_CERT_ALTNAME_INVALID: 'Имя хоста не совпадает с сертификатом.',
      SELF_SIGNED_CERT_IN_CHAIN: 'Цепочка сертификатов не ведёт к доверенному CA.',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'Сервер предъявил недоверенный самоподписанный сертификат.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Не удалось проверить цепочку сертификатов.',
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Не удалось найти доверенного издателя сертификата.',
    };
    return { errorKind: 'tls', tlsCode: code, error: messages[code] ?? 'Ошибка TLS или проверки сертификата.' };
  }
  if (code === 'ETIMEDOUT') return { errorKind: 'timeout', error: 'Истекло время ожидания ответа.' };
  return { errorKind: 'connection', error: 'Ошибка сетевого соединения' + (code ? ` (${code}).` : '.') };
}

function redactResultText(profile?: ResolvedRequestOptions) {
  const sensitive = [...(profile?.protectedValues ?? []), profile?.proxy?.authorization ?? ''].filter(Boolean);
  const variants = new Set<string>();
  for (const value of sensitive) {
    variants.add(value);
    try {
      const encoded = encodeURIComponent(value);
      variants.add(encoded);
      variants.add(encoded.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
      variants.add(new URLSearchParams({ value }).toString().slice('value='.length));
    } catch { /* A value with an invalid Unicode surrogate can only be matched as raw text. */ }
  }
  const critical = [...variants].sort((a, b) => b.length - a.length);
  return (value: string) => {
    for (const secret of critical) value = value.replaceAll(secret, '[скрыто]');
    if (sensitive.length && /[%+]/.test(value)) {
      const escaped = value.replaceAll('&', '%26');
      const decoded = new URLSearchParams('value=' + escaped).get('value') ?? '';
      const decodedPreservingPlus = new URLSearchParams('value=' + escaped.replaceAll('+', '%2B')).get('value') ?? '';
      if (sensitive.some(secret => decoded.includes(secret) || decodedPreservingPlus.includes(secret))) return '[скрыто]';
    }
    return value;
  };
}

function removeUrlCredentials(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.href;
    }
  } catch { /* Invalid input is returned for reporting with any known secret values removed. */ }
  return value;
}

export async function checkUrl(input: string, options: Options = {}): Promise<CheckResult> {
  const start = performance.now();
  const profile = options.requestOptions;
  const source = options.pac && !profile?.proxy ? 'pac' : profile ? 'profile' : null;
  const progress: RequestProgress = {
    finalUrl: input,
    redirects: 0,
    route: profile?.proxy ? 'proxy' : source === 'profile' ? 'direct' : undefined,
  };
  let failure: ReturnType<typeof classify> | undefined;
  try {
    const response = await follow(input, progress, 0, options);
    if (response.code < 200 || response.code >= 300) {
      failure = { errorKind: 'http', error: `HTTP ${response.code}` };
    }
  } catch (error) {
    failure = classify(error);
  }
  const response = progress.response;
  const redact = redactResultText(profile);
  const contentType = response?.headers['content-type'];
  const contentLength = response?.headers['content-length'];
  return {
    status: failure ? 'error' : 'ok',
    httpCode: response?.code ?? null,
    accessHint: response?.code === 401 && response.headers['www-authenticate'] === undefined
      && /^(qrator|curator)(?:[\s/]|$)/i.test(String(response.headers.server ?? '')) ? 'curator-challenge' : null,
    durationMs: Math.round(performance.now() - start),
    finalUrl: redact(source ? removeUrlCredentials(progress.finalUrl) : progress.finalUrl),
    redirects: progress.redirects,
    contentType: contentType === undefined ? null : redact(contentType).slice(0, 512),
    contentLength: contentLength === undefined ? null : redact(contentLength).slice(0, 40),
    errorKind: failure?.errorKind ?? null,
    tlsCode: failure?.tlsCode ? redact(failure.tlsCode) : null,
    error: failure ? redact(failure.error) : null,
    ...(source ? {
      requestProfile: profile ? redact(profile.profileName) : null,
      requestSource: source,
      requestRoute: progress.route ?? null,
      requestProxy: progress.proxy ? redact(progress.proxy) : null,
      failureStage: failure ? progress.stage === 'pac' ? 'pac'
        : failure.errorKind === 'configuration' ? 'configuration' : progress.stage ?? 'target' : null,
      proxyHttpCode: failure?.proxyHttpCode ?? null,
    } : {}),
  };
}

export async function downloadPublicFile(input: string, maxBytes: number, timeoutMs: number, tlsProfile?: TlsProfile): Promise<Buffer> {
  const progress: RequestProgress = { finalUrl: input, redirects: 0 };
  let response: HttpResult;
  try {
    response = await follow(input, progress, maxBytes, { timeoutMs, tlsProfile });
  } catch (error) {
    const failure = classify(error);
    throw new Error(failure.error + (failure.tlsCode ? ` (${failure.tlsCode})` : ''), { cause: error });
  }
  if (response.code < 200 || response.code >= 300) throw new Error(`Sitemap вернул HTTP ${response.code}.`);
  return response.body ?? Buffer.alloc(0);
}

export async function openSitemapStream(input: string, tlsProfile: TlsProfile, signal: AbortSignal) {
  const progress: RequestProgress = { finalUrl: input, redirects: 0 };
  let response: HttpResult;
  try {
    response = await follow(input, progress, 0, { tlsProfile, signal, stream: true });
  } catch (error) {
    const failure = classify(error);
    throw new Error(failure.error + (failure.tlsCode ? ` (${failure.tlsCode})` : ''), { cause: error });
  }
  if (!response.stream) throw new Error(`Sitemap вернул HTTP ${response.code}.`);
  return response.stream;
}
