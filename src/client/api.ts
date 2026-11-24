import { DESKTOP_SHUTDOWN, type DesktopMethod } from '../shared/desktop.js';
import type { RunRestart } from '../shared/reports.js';
import { useCallback, useEffect, useState } from 'react';
import type { Address, Project, Result, Run, Version } from '../shared/types.js';

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

export class ApiResponseError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const desktop = typeof window !== 'undefined' && window.pulseDesktop;
  if (desktop) {
    options.signal?.throwIfAborted();
    const response = await desktop.request({
      path: url, method: (options.method ?? 'GET') as DesktopMethod,
      body: typeof options.body === 'string' ? options.body : undefined,
    });
    options.signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) {
      const failure = response.data as { error?: string; code?: string } | null;
      throw new ApiResponseError(response.status, failure?.error ?? 'Не удалось выполнить запрос.', failure?.code);
    }
    return response.data as T;
  }
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new ApiResponseError(response.status, value.error ?? 'Не удалось выполнить запрос.');
  return value as T;
}

export function write<T>(url: string, method: 'POST' | 'PATCH' | 'PUT', payload: object) {
  return api<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

export function useQuery<T>(
  path: string | null, interval: number | ((data?: T) => number) = 0, revisionOf?: (data: T) => string | undefined,
) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string; status?: number }>();
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
          error: (error as Error).message,
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
  return { data: current?.data, error: current?.error, status: current?.status, refresh, reset };
}

export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return { busy, error, run, clear: () => setError('') };
}
