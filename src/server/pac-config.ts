import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MAX_PAC_BYTES, type PacProxyRule, type PacSettings } from '../shared/pac.js';
import type { PacRequestOptions } from './checker.js';
import { createPacRouteResolver, normalizePacProxyUrl } from './pac.js';
import { requestSecretView, saveRequestSecret } from './request-profiles.js';
import { isRequestSecretReference, type RequestSecrets } from './request-secrets.js';
import { ApiError } from './store.js';

export interface StoredPacProxy extends PacProxyRule { auth?: { username: string; ref: string } }
export interface StoredPac { filename: string; revision: string; source: string; proxies?: StoredPacProxy[] }
export type PacVersionRow = Omit<StoredPac, 'proxies'> & { proxy_rules: string };

export const unreferencedPacVersion = `pac.active=0 AND NOT EXISTS (
  SELECT 1 FROM runs r WHERE r.project_id=pac.project_id AND r.pac_revision=pac.revision
) AND NOT EXISTS (
  SELECT 1 FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
  WHERE s.project_id=pac.project_id AND i.pac_revision=pac.revision
)`;

export function withPacProxies(config: StoredPac, proxies: StoredPacProxy[] = []): StoredPac {
  const { filename, source } = config;
  const hash = createHash('sha256').update(filename).update('\0').update(source);
  if (proxies.length) hash.update('\0').update(JSON.stringify(proxies));
  return { filename, source, revision: hash.digest('hex'), ...(proxies.length ? { proxies } : {}) };
}

export function parsePacFile(filename: unknown, source: unknown): StoredPac {
  if (typeof filename !== 'string' || !/^[^/\\\x00-\x1f\x7f]{1,180}\.pac$/i.test(filename)) {
    throw new Error('Выберите файл с расширением .pac.');
  }
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') || Buffer.byteLength(source) > MAX_PAC_BYTES) {
    throw new Error(`PAC-файл должен содержать текст UTF-8 и занимать до ${MAX_PAC_BYTES / 1024} КиБ.`);
  }
  return withPacProxies({ filename, source, revision: '' });
}

function proxyObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Проверьте настройки доверенного прокси.');
  return input as Record<string, unknown>;
}

function proxyRule(input: Record<string, unknown>): PacProxyRule {
  if (typeof input.allowPrivate !== 'boolean' || typeof input.connectByHostname !== 'boolean') {
    throw new ApiError(400, 'Проверьте настройки доверенного прокси.');
  }
  let url: string;
  try { url = normalizePacProxyUrl(input.url); }
  catch { throw new ApiError(400, 'Укажите схему, хост и порт доверенного прокси.'); }
  return { url, allowPrivate: input.allowPrivate, connectByHostname: input.connectByHostname };
}

function proxyUsername(url: string, auth: Record<string, unknown>) {
  if (!url.startsWith('https:')) throw new ApiError(400, 'Для авторизации прокси требуется HTTPS-подключение к нему.');
  const username = auth.username;
  if (typeof username !== 'string' || !username.trim() || username.length > 200 || /[:\x00-\x1f\x7f]/.test(username)) {
    throw new ApiError(400, 'Проверьте логин доверенного прокси. Двоеточия недопустимы.');
  }
  return username.trim();
}

export async function parsePacProxies(input: unknown, previous: StoredPac, secrets: RequestSecrets, staged: string[]) {
  if (!Array.isArray(input)) throw new ApiError(400, 'Проверьте список доверенных прокси.');
  const urls = new Set<string>();
  const proxies: StoredPacProxy[] = [];
  for (const value of input) {
    const data = proxyObject(value);
    const proxy: StoredPacProxy = proxyRule(data);
    if (urls.has(proxy.url)) throw new ApiError(400, 'Доверенный прокси с таким адресом уже добавлен.');
    urls.add(proxy.url);
    if (data.auth !== undefined) {
      const auth = proxyObject(data.auth);
      const username = proxyUsername(proxy.url, auth);
      const old = previous.proxies?.find(entry => entry.url === proxy.url)?.auth;
      const ref = await saveRequestSecret(auth.secret, old?.username === username ? old.ref : undefined, secrets, staged);
      proxy.auth = { username, ref };
    }
    proxies.push(proxy);
  }
  return withPacProxies(previous, proxies);
}

export function storedPac({ filename, revision, source, proxy_rules }: PacVersionRow): StoredPac {
  const proxies: unknown = JSON.parse(proxy_rules);
  if (!Array.isArray(proxies)) throw new Error('Invalid PAC proxy rules');
  return { filename, revision, source, ...(proxies.length ? { proxies } : {}) };
}

export function validatePacVersion(row: PacVersionRow) {
  const file = parsePacFile(row.filename, row.source);
  const config = storedPac(row);
  const urls = new Set<string>();
  for (const value of config.proxies ?? []) {
    const rule = proxyRule(proxyObject(value));
    if (rule.url !== value.url || urls.has(rule.url)) throw new Error('Invalid proxy origin');
    urls.add(rule.url);
    const canonical: StoredPacProxy = rule;
    if (value.auth !== undefined) {
      const auth = proxyObject(value.auth);
      const username = proxyUsername(rule.url, auth);
      if (typeof auth.ref !== 'string' || !isRequestSecretReference(auth.ref)) throw new Error('Invalid proxy credential reference');
      canonical.auth = { username, ref: auth.ref };
    }
    if (!isDeepStrictEqual(canonical, value)) throw new Error('Invalid PAC proxy rule');
  }
  if (withPacProxies(file, config.proxies).revision !== row.revision) throw new Error('Invalid PAC revision');
}

export function pacReferences(config?: StoredPac): string[] {
  return config?.proxies?.flatMap(proxy => proxy.auth ? [proxy.auth.ref] : []) ?? [];
}

export function pacRequestOptions(config?: StoredPac, readSecret: RequestSecrets['read'] = async () => undefined): PacRequestOptions {
  if (!config) return {};
  const pac = createPacRouteResolver(config.source);
  if (!config.proxies?.length) return { pac };
  const rules = new Map(config.proxies.map(rule => [rule.url, rule]));
  const reads = new Map<string, ReturnType<RequestSecrets['read']>>();
  return { pac, pacProxy: { rules, readSecret(ref) {
    const existing = reads.get(ref);
    if (existing) return existing;
    const pending = readSecret(ref);
    reads.set(ref, pending);
    return pending;
  } } };
}

export function pacSettings(config?: StoredPac, mode: RequestSecrets['mode'] = 'desktop'): { pac: PacSettings | null } {
  if (!config) return { pac: null };
  const proxies = config.proxies?.map(({ url, allowPrivate, connectByHostname, auth }) => ({
    url, allowPrivate, connectByHostname, ...(auth ? { auth: { username: auth.username, ...requestSecretView(auth.ref, mode) } } : {}),
  }));
  return { pac: { filename: config.filename, revision: config.revision, ...(proxies?.length ? { proxies } : {}) } };
}
