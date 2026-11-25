import { DESKTOP_SHUTDOWN, type DesktopMethod } from '../shared/desktop.js';
import type { RunRestart } from '../shared/reports.js';
import { useCallback, useEffect, useState } from 'react';
import type { Address, Project, Result, Run, Version } from '../shared/types.js';
import { createTranslator, type AppLocale } from '../shared/i18n/index.js';
import { isDiagnosticReference, translateDiagnostic, translateReference } from '../shared/i18n/diagnostics.js';
import { commonMessages } from '../shared/i18n/locales/common.js';
import { LocalizedError, useLanguage } from './i18n.js';

export interface Workspace {
  projects: Project[];
  unread: number;
  smtpConfigured: boolean;
  schedulesPaused?: boolean;
}

export interface ProjectView {
  project: Project;
  revision: string;
  transferActive: boolean;
  activeRun: Run | null;
  lastStoppedRun: RunRestart | null;
  summary: { total: number; available: number; failures: number; unchecked: number };
}

export interface AddressView { address: Address; versions: Version[]; history: Result[] }

export function base(id: number) { return `/api/projects/${id}`; }

export const requestProfilesPath = (projectId: number) => `${base(projectId)}/request-profiles`;

export function requestOrigin(input: string) {
  const value = input.trim();
  if (!value || /[\s\\]/u.test(value)) return undefined;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port === '0') return undefined;
    url.hostname = url.hostname.replace(/\.$/, '');
    return url.origin;
  } catch { return undefined; }
}

const requestFailed = (locale: AppLocale) => createTranslator(locale, 'common', commonMessages)('requestFailed');

export function localizedFailure(error: unknown, locale: AppLocale) {
  if (error instanceof LocalizedError) return error.translate(locale);
  if (error instanceof Error) return translateDiagnostic(error.message, locale);
  return requestFailed(locale);
}

export class ApiResponseError extends LocalizedError {
  constructor(readonly status: number, message?: string, readonly code?: string, details?: unknown) {
    super(locale => isDiagnosticReference(details) ? translateReference(locale, details)
      : typeof message === 'string' ? translateDiagnostic(message, locale) : requestFailed(locale));
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const desktop = typeof window !== 'undefined' && window.pulseDesktop;
  if (desktop) {
    options.signal?.throwIfAborted();
    const response = await desktop.request({
      path: url, method: (options.method ?? 'GET') as DesktopMethod,
      body: typeof options.body === 'string' ? options.body : undefined,
      i18n: true,
    });
    options.signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) {
      const failure = response.data as { error?: string; code?: string } | null;
      throw new ApiResponseError(response.status, failure?.error, failure?.code, failure);
    }
    return response.data as T;
  }
  const headers = new Headers(options.headers);
  headers.set('x-urlpulse-i18n', '1');
  const response = await fetch(url, { ...options, headers });
  const value = await response.json();
  if (!response.ok) throw new ApiResponseError(response.status, value?.error, value?.code, value);
  return value as T;
}

export function write<T>(url: string, method: 'POST' | 'PATCH' | 'PUT', payload: object) {
  return api<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

export function useQuery<T>(
  path: string | null, interval: number | ((data?: T) => number) = 0, revisionOf?: (data: T) => string | undefined,
) {
  const locale = useLanguage();
  const [state, setState] = useState<{ path: string; data?: T; error?: unknown; status?: number }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: T | undefined;
    async function load() {
      try {
        const revision = latest !== undefined ? revisionOf?.(latest) : undefined;
        const target = revision ? path! + (path!.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(revision) : path!;
        const response = await api<T | { unchanged: true }>(target, { signal: abort.signal });
        if (revision && (response as { unchanged?: boolean }).unchanged === true) {
          if (!abort.signal.aborted) setState(previous => previous?.error ? { ...previous, error: undefined, status: undefined } : previous);
          return;
        }
        latest = response as T;
        if (!abort.signal.aborted) setState({ path: path!, data: latest });
      } catch (error) {
        if (error instanceof ApiResponseError && error.code === DESKTOP_SHUTDOWN.data.code) abort.abort();
        if (!abort.signal.aborted) setState(previous => ({
          path: path!, data: previous?.path === path ? previous.data : undefined,
          error,
          status: error instanceof ApiResponseError ? error.status : undefined,
        }));
      } finally {
        const delay = typeof interval === 'function' ? interval(latest) : interval;
        if (!abort.signal.aborted && delay) timer = setTimeout(load, delay);
      }
    }
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [path, interval, revision, revisionOf]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const reset = useCallback(() => { setState(undefined); refresh(); }, [refresh]);
  const current = state?.path === path ? state : undefined;
  return { data: current?.data, error: current?.error ? localizedFailure(current.error, locale) : undefined,
    status: current?.status, refresh, reset };
}

export function useTask() {
  const locale = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (failure) { setError(() => failure); }
    finally { setBusy(false); }
  }
  return { busy, error: error ? localizedFailure(error, locale) : '', run, clear: () => setError(undefined) };
}
