import type { DesktopRequest } from '../shared/desktop.js';
import { defaultLocale, type AppLocale } from '../shared/i18n/index.js';
import { nativeTranslator } from '../shared/i18n/locales/native.js';

const validRoutes: Record<Exclude<DesktopRequest['method'], 'PUT'>, RegExp> = {
  GET: /^\/api\/(?:notifications|projects(?:\/\d+(?:\/(?:urls(?:\/(?:\d+|page|selection|delete\/all))?|runs(?:\/\d+)?|groups(?:\/\d+\/runs)?|catalog(?:\/(?:page|imports\/history|clear))?))?)?)$/,
  POST: /^\/api\/(?:notifications\/(?:read|clear)|projects(?:\/\d+\/(?:urls(?:\/(?:delete(?:\/(?:preview|all))?|sitemap|\d+\/restore))?|runs(?:\/\d+\/(?:stop|restart))?|groups(?:\/\d+\/runs)?|catalog\/(?:actions|clear|transfer(?:\/\d+\/stop)?|imports(?:\/\d+\/control)?)))?)$/,
  PATCH: /^\/api\/projects\/\d+(?:\/settings|\/urls\/\d+|\/groups\/\d+(?:\/members)?|\/catalog\/sources\/\d+)?$/,
  DELETE: /^\/api\/projects\/\d+(?:\/runs\/\d+|\/groups\/\d+|\/catalog\/sources\/\d+)?$/,
};

const numberId = (value: string | null | undefined) =>
  !!value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

const requestProfileRoutes: Record<Exclude<DesktopRequest['method'], 'PUT'>, RegExp> = {
  GET: /^\/api\/projects\/(\d+)\/(?:request-profiles|urls\/(\d+)\/request-profile)$/,
  POST: /^\/api\/projects\/(\d+)\/request-profiles(?:\/(\d+)\/test)?$/,
  PATCH: /^\/api\/projects\/(\d+)\/(?:request-profiles\/(\d+)|urls\/(\d+)\/request-profile)$/,
  DELETE: /^\/api\/projects\/(\d+)\/request-profiles\/(\d+)$/,
};

function validRoute(method: DesktopRequest['method'], path: string) {
  const [pathname] = path.split('?', 1);
  const comparisonRequest = /^\/api\/projects\/(\d+)\/run-comparison$/.exec(pathname);
  if (comparisonRequest) return method === 'GET' && numberId(comparisonRequest[1]);
  const pacRequest = /^\/api\/projects\/(\d+)\/proxy-pac(\/test)?$/.exec(pathname);
  if (pacRequest) return numberId(pacRequest[1]) && (pacRequest[2] ? method === 'POST'
    : method === 'GET' || method === 'PUT' || method === 'PATCH' || method === 'DELETE');
  if (method === 'PUT') return false;
  if (validRoutes[method].test(pathname)) return true;
  const match = requestProfileRoutes[method].exec(pathname);
  return match?.slice(1).every(value => value === undefined || numberId(value));
}

export function desktopRequest(input: DesktopRequest, locale: AppLocale = defaultLocale): DesktopRequest {
  if (!input || (input.method !== 'PUT' && !Object.hasOwn(validRoutes, input.method))
    || typeof input.path !== 'string' || input.path.length > 14_000
    || /[#\\\u0000-\u001f]/.test(input.path)
    || !validRoute(input.method, input.path)
    || (input.i18n !== undefined && input.i18n !== true)
    || (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 12_010_000))) {
    throw new Error(nativeTranslator(locale)('invalidDesktopOperation'));
  }
  return { path: input.path, method: input.method, body: input.body, ...(input.i18n && { i18n: true }) };
}

export function exportScope(path: string, locale: AppLocale = defaultLocale) {
  const match = typeof path === 'string' && /^\/api\/projects\/(\d+)(?:\/(urls|runs|groups)\/(\d+))?$/.exec(path);
  if (!match || !numberId(match[1]) || (match[2] && !numberId(match[3]))) {
    throw new Error(nativeTranslator(locale)('invalidReportAddress'));
  }
  const projectId = Number(match[1]);
  if (match[2] === 'urls') return { projectId, urlId: Number(match[3]) };
  if (match[2] === 'runs') return { projectId, runId: Number(match[3]) };
  if (match[2] === 'groups') return { projectId, groupId: Number(match[3]) };
  return { projectId };
}

export function reportArguments(link: string) {
  try {
    const url = new URL(link);
    const project = url.searchParams.get('project');
    const run = url.searchParams.get('run');
    if (url.protocol === 'pulse-url:' && url.host === 'report' && url.pathname === '/'
      && !url.username && !url.password && project && run && numberId(project) && numberId(run)) {
      return { project, run };
    }
  } catch { /* Ignore arguments that are not report links. */ }
}
