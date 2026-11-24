import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { RequestAuthView, RequestHeaderView, RequestProfileView, RequestSecretInput, ResolvedRequestOptions } from '../shared/request-profiles.js';
import type { CheckResult } from '../shared/types.js';
import { normalizeUrl, withDeadline } from './checker.js';
import { isRequestSecretReference, type RequestSecrets } from './request-secrets.js';
import { ApiError, type Store } from './store.js';

type ProfileHeader = { name: string; value: string } | { name: string; ref: string };
type ProfileAuth = { kind: 'none' } | { kind: 'basic'; username: string; ref: string }
  | { kind: 'bearer'; ref: string } | { kind: 'api-key'; header: string; ref: string };
export interface ProfileConfig {
  name: string;
  origin: string;
  isDefault: boolean;
  headers: ProfileHeader[];
  auth: ProfileAuth;
  proxy: { url: string; auth?: { username: string; ref: string } } | null;
}
export type SavedRequestProfile = ProfileConfig & { id: number };

const reserved = new Set(['authorization', 'cookie', 'host', 'connection', 'content-length',
  'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection', 'keep-alive',
  'te', 'trailer', 'expect', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip']);
export const MAX_PROFILES = 100;
const HEADER_LIMIT = 24;
const VALUE_LIMIT = 4096;
const TOTAL_HEADER_BYTES = 16_384;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Проверьте профиль запроса.');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, `Проверьте поле «${label}».`);
  }
  return value.trim();
}

function origin(value: unknown, label: string) {
  const urlInput = text(value, label, 300);
  try {
    const url = new URL(urlInput);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || !/^https?:\/\//i.test(urlInput) || /[\\?#]/.test(urlInput)) throw new Error();
    return new URL(normalizeUrl(url.href)).origin;
  } catch { throw new ApiError(400, `Укажите схему, хост и порт в поле «${label}».`); }
}

function headerName(value: unknown) {
  const name = text(value, 'Имя заголовка', 128).toLowerCase();
  try { validateHeaderName(name); }
  catch { throw new ApiError(400, 'Проверьте имя заголовка.'); }
  if (reserved.has(name)) throw new ApiError(400, `Заголовок «${name}» зарезервирован.`);
  return name;
}

function headerValue(name: string, value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > VALUE_LIMIT || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(400, `Проверьте значение заголовка «${name}».`);
  }
  try { validateHeaderValue(name, value); }
  catch { throw new ApiError(400, `Проверьте значение заголовка «${name}».`); }
  return value;
}

export class RequestSecretError extends Error {}

export function profileReferences(profile: ProfileConfig): string[] {
  const refs = profile.headers.flatMap(header => 'ref' in header ? [header.ref] : []);
  if (profile.auth.kind !== 'none') refs.push(profile.auth.ref);
  if (profile.proxy?.auth) refs.push(profile.proxy.auth.ref);
  return refs;
}

export async function parseRequestProfile(input: unknown, previous: SavedRequestProfile | undefined, secrets: RequestSecrets,
  staged: string[]): Promise<ProfileConfig> {
  const value = object(input);
  const name = text(value.name, 'Название профиля', 80);
  const site = origin(value.origin, 'Адрес сайта');
  if (typeof value.isDefault !== 'boolean' || !Array.isArray(value.headers) || value.headers.length > HEADER_LIMIT) {
    throw new ApiError(400, `Укажите до ${HEADER_LIMIT} заголовков и правило назначения профиля.`);
  }
  const sameSite = previous?.origin === site ? previous : undefined;
  const names = new Set<string>();
  async function saveSecret(secret: unknown, retained?: string): Promise<string> {
    if (secret === undefined && retained) return retained;
    if (secret === undefined) throw new ApiError(400, 'Задайте секрет для авторизации или заголовка.');
    const data = object(secret);
    if (typeof data.value === 'string' && data.value.length > 0 && Buffer.byteLength(data.value) <= VALUE_LIMIT
      && !/[\x00-\x1f\x7f]/.test(data.value) && data.environment === undefined) {
      return record({ value: data.value });
    }
    if (typeof data.environment === 'string' && data.value === undefined) return record({ environment: data.environment.trim() });
    throw new ApiError(400, 'Задайте секрет для авторизации или заголовка.');
  }
  async function record(input: RequestSecretInput) {
    try {
      const ref = await secrets.save(input);
      if (secrets.mode === 'desktop') staged.push(ref);
      return ref;
    } catch { throw new ApiError(400, secrets.mode === 'desktop'
      ? 'Не удалось сохранить секрет в хранилище системы.' : 'Укажите настроенную переменную PULSE_REQUEST_SECRET_…'); }
  }

  const headers: ProfileHeader[] = [];
  for (const entry of value.headers) {
    const inputHeader = object(entry);
    const key = headerName(inputHeader.name);
    if (names.has(key)) throw new ApiError(400, `Заголовок «${key}» уже добавлен.`);
    names.add(key);
    if (inputHeader.secret === true) {
      if (!site.startsWith('https:')) throw new ApiError(400, 'Для секретных заголовков сайта требуется HTTPS.');
      const old = sameSite?.headers.find(header => header.name === key);
      const next = inputHeader.value !== undefined || inputHeader.environment !== undefined
        ? { value: inputHeader.value, environment: inputHeader.environment } : undefined;
      headers.push({ name: key, ref: await saveSecret(next, old && 'ref' in old ? old.ref : undefined) });
    } else if (inputHeader.secret === false && inputHeader.environment === undefined) {
      headers.push({ name: key, value: headerValue(key, inputHeader.value) });
    } else throw new ApiError(400, 'Проверьте параметры заголовка.');
  }
  const authInput = object(value.auth);
  const previousAuth = sameSite?.auth;
  let auth: ProfileAuth = { kind: 'none' };
  if (authInput.kind !== 'none') {
    if (!site.startsWith('https:')) throw new ApiError(400, 'Для авторизации сайта требуется HTTPS.');
    if (authInput.kind === 'basic') {
      const username = text(authInput.username, 'Логин сайта', 200);
      if (username.includes(':')) throw new ApiError(400, 'Логин Basic не может содержать двоеточие.');
      auth = { kind: 'basic', username, ref: await saveSecret(authInput.secret,
        previousAuth?.kind === 'basic' && previousAuth.username === username ? previousAuth.ref : undefined) };
    } else if (authInput.kind === 'bearer') {
      auth = { kind: 'bearer', ref: await saveSecret(authInput.secret, previousAuth?.kind === 'bearer' ? previousAuth.ref : undefined) };
    } else if (authInput.kind === 'api-key') {
      const header = headerName(authInput.header);
      if (names.has(header)) throw new ApiError(400, 'Имя заголовка API-ключа уже используется.');
      auth = { kind: 'api-key', header, ref: await saveSecret(authInput.secret,
        previousAuth?.kind === 'api-key' && previousAuth.header === header ? previousAuth.ref : undefined) };
    } else throw new ApiError(400, 'Выберите способ авторизации сайта.');
  }
  let proxy: ProfileConfig['proxy'] = null;
  if (value.proxy !== null) {
    const inputProxy = object(value.proxy);
    const url = origin(inputProxy.url, 'Адрес прокси');
    if (!site.startsWith('https:')) throw new ApiError(400, 'Проверка через прокси доступна для HTTPS-адресов.');
    proxy = { url };
    if (inputProxy.auth !== undefined) {
      if (!url.startsWith('https:')) throw new ApiError(400, 'Для авторизации прокси требуется HTTPS-подключение к нему.');
      const inputAuth = object(inputProxy.auth);
      const username = text(inputAuth.username, 'Логин прокси', 200);
      if (username.includes(':')) throw new ApiError(400, 'Логин прокси не может содержать двоеточие.');
      const old = sameSite?.proxy?.url === url ? sameSite.proxy.auth : undefined;
      proxy.auth = { username, ref: await saveSecret(inputAuth.secret, old?.username === username ? old.ref : undefined) };
    }
  }
  if (headers.reduce((sum, entry) => sum + Buffer.byteLength(entry.name) + ('value' in entry ? Buffer.byteLength(entry.value) : 0), 0) > TOTAL_HEADER_BYTES) {
    throw new ApiError(400, 'Общий размер заголовков не должен превышать 16 КиБ.');
  }
  return { name, origin: site, isDefault: value.isDefault, headers, auth, proxy };
}

export function requestProfileView(profile: SavedRequestProfile, mode: RequestSecrets['mode']): RequestProfileView {
  const secret = (ref: string) => mode === 'environment' ? { configured: true, environment: ref } : { configured: true };
  const headers: RequestHeaderView[] = profile.headers.map(header => 'ref' in header
    ? { name: header.name, secret: true, ...secret(header.ref) }
    : { name: header.name, secret: false, value: header.value });
  const { auth, proxy, ...info } = profile;
  const viewAuth: RequestAuthView = auth.kind === 'none' ? auth
    : auth.kind === 'basic' ? { kind: auth.kind, username: auth.username, ...secret(auth.ref) }
      : auth.kind === 'api-key' ? { kind: auth.kind, header: auth.header, ...secret(auth.ref) }
        : { kind: auth.kind, ...secret(auth.ref) };
  return { ...info, headers, auth: viewAuth, proxy: proxy && { url: proxy.url, auth: proxy.auth
    ? { username: proxy.auth.username, ...secret(proxy.auth.ref) } : undefined } };
}

const unavailableSecrets: RequestSecrets = {
  mode: 'desktop',
  async save() { throw new RequestSecretError(); },
  async read() { return undefined; },
  async remove() {},
};

export async function validateStoredRequestProfile(profile: ProfileConfig) {
  const parsed = await parseRequestProfile({
    ...profile,
    headers: profile.headers.map(entry => 'ref' in entry ? { name: entry.name, secret: true }
      : { name: entry.name, value: entry.value, secret: false }),
  }, { ...profile, id: 0 }, unavailableSecrets, []);
  if (!isDeepStrictEqual(profile, parsed) || !profileReferences(profile).every(isRequestSecretReference)) throw new RequestSecretError();
}

export async function resolveRequestOptions(profile: SavedRequestProfile, secrets: RequestSecrets,
  signal?: AbortSignal): Promise<ResolvedRequestOptions> {
  const headers: Record<string, string> = Object.create(null);
  const protectedValues = new Set<string>();
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function read(ref: string) {
    deadline.throwIfAborted();
    const value = await withDeadline(secrets.read(ref), deadline);
    if (!value || Buffer.byteLength(value) > VALUE_LIMIT || /[\x00-\x1f\x7f]/.test(value)) throw new RequestSecretError();
    protectedValues.add(value);
    return value;
  }
  const basic = (username: string, password: string) => {
    const encoded = Buffer.from(username + ':' + password).toString('base64');
    protectedValues.add(encoded);
    return 'Basic ' + encoded;
  };
  const { auth, proxy } = profile;
  try {
    if ((!profile.origin.startsWith('https:') && (profileReferences(profile).length || proxy))
      || (proxy?.auth && !proxy.url.startsWith('https:'))) throw new RequestSecretError();
    for (const entry of profile.headers) {
      const name = headerName(entry.name);
      const value = 'ref' in entry ? await read(entry.ref) : entry.value;
      headers[name] = headerValue(name, value);
    }
    if (auth.kind === 'api-key') {
      const name = headerName(auth.header);
      headers[name] = headerValue(name, await read(auth.ref));
    } else if (auth.kind !== 'none') {
      const password = await read(auth.ref);
      headers.authorization = headerValue('authorization', auth.kind === 'basic'
        ? basic(auth.username, password) : 'Bearer ' + password);
    }
    if (Object.entries(headers).reduce((sum, [name, value]) => sum + Buffer.byteLength(name + value), 0) > TOTAL_HEADER_BYTES) throw new RequestSecretError();
    const proxyOptions = proxy ? { url: proxy.url, authorization: proxy.auth ? basic(proxy.auth.username, await read(proxy.auth.ref)) : undefined } : undefined;
    return { profileName: profile.name, origin: profile.origin, headers, protectedValues: [...protectedValues], proxy: proxyOptions };
  } catch { throw new RequestSecretError(); }
}

export function configurationFailure(url: string, profile?: SavedRequestProfile, error = 'Секрет профиля недоступен или не настроен.'): CheckResult {
  return {
    status: 'error', httpCode: null, durationMs: 0, finalUrl: url, redirects: 0,
    contentType: null, contentLength: null, errorKind: 'configuration', error,
    requestProfile: profile?.name, requestRoute: profile?.proxy ? 'proxy' : 'direct', failureStage: 'configuration',
  };
}

export async function releaseRequestSecrets(store: Store, secrets: RequestSecrets, refs: readonly string[]) {
  if (secrets.mode !== 'desktop' || refs.length === 0) return;
  await Promise.allSettled(store.unusedRequestSecrets(refs).map(ref => secrets.remove(ref)));
}
