import { reportChanges, reportParams, type ReportFilters } from '../shared/reports.js';
import { isComparisonKind, type ComparisonInput } from '../shared/run-comparison.js';

export type Tab = 'urls' | 'catalog' | 'runs' | 'settings' | 'notifications';

export type WorkspaceRoute = {
  project?: number;
  tab: Tab;
  address?: number;
  group?: number;
  groupRuns?: boolean;
  run?: number;
  filters?: ReportFilters;
  comparison?: Partial<ComparisonInput>;
  notification?: number;
  cursors?: number[];
};

function positiveId(value: string | null) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function readRoute(search: string): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const run = positiveId(params.get('run'));
  const status = params.get('status');
  const change = params.get('change');
  const code = Number(params.get('httpCode'));
  const comparing = params.get('compare') === '1';
  const kind = params.get('kind');
  return {
    project: positiveId(params.get('project')),
    tab: tab === 'urls' || tab === 'catalog' || tab === 'runs' || tab === 'settings' || tab === 'notifications'
      ? tab : run || comparing ? 'runs' : 'urls',
    address: positiveId(params.get('address')),
    group: positiveId(params.get('group')),
    groupRuns: params.get('groupRuns') === '1',
    run,
    filters: run ? {
      q: params.get('q')?.trim().slice(0, 512) || undefined,
      status: status === 'ok' || status === 'error' ? status : undefined,
      change: change && Object.hasOwn(reportChanges, change) ? change as ReportFilters['change'] : undefined,
      httpCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined,
    } : undefined,
    comparison: comparing ? {
      baseline: positiveId(params.get('baseline')),
      target: positiveId(params.get('target')),
      q: params.get('compareQ')?.trim().slice(0, 512) || undefined,
      kind: isComparisonKind(kind) ? kind : undefined,
    } : undefined,
    notification: positiveId(params.get('notification')),
    cursors: params.getAll('before').flatMap(value => positiveId(value) ?? []),
  };
}

export function routeSearch(route: WorkspaceRoute) {
  const params = route.run ? reportParams(route.filters) : new URLSearchParams();
  if (route.project) params.set('project', String(route.project));
  if (route.tab !== 'urls' || route.run) params.set('tab', route.tab);
  if (route.address) params.set('address', String(route.address));
  if (route.group) params.set('group', String(route.group));
  if (route.group && route.groupRuns) params.set('groupRuns', '1');
  if (route.run) params.set('run', String(route.run));
  if (route.comparison) {
    const { baseline, target, q, kind } = route.comparison;
    params.set('compare', '1');
    if (baseline !== undefined) params.set('baseline', String(baseline));
    if (target !== undefined) params.set('target', String(target));
    if (q) params.set('compareQ', q);
    if (kind && kind !== 'differences') params.set('kind', kind);
  }
  if (route.notification) params.set('notification', String(route.notification));
  for (const cursor of route.cursors ?? []) params.append('before', String(cursor));
  return params.size ? `?${params}` : '';
}
