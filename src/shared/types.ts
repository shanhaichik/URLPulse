export type AccessHint = 'curator-challenge';

export type TlsProfile = 'default' | 'russian-ca';

export type NotificationMode = 'all' | 'errors' | 'off';

export const CHECK_CONCURRENCY = { min: 1, max: 24, default: 6 } as const;

export interface Schedule {
  weekdays: number[];
  time: string;
  timezone: string;
}

export interface Settings {
  tlsProfile?: TlsProfile;
  checkConcurrency?: number;
  schedule: Schedule | null;
  notify: NotificationMode;
  email: string | null;
}

export interface Project extends Settings {
  tlsProfile: TlsProfile;
  checkConcurrency: number;
  id: number;
  name: string;
  description: string;
  nextAt: string | null;
  urlCount: number;
}

export interface CheckResult {
  status: 'ok' | 'error';
  httpCode: number | null;
  durationMs: number;
  finalUrl: string;
  redirects: number;
  contentType: string | null;
  contentLength: string | null;
  errorKind: 'http' | 'dns' | 'tls' | 'timeout' | 'connection' | 'blocked' | 'redirect' | 'configuration' | 'proxy' | null;
  error: string | null;
  tlsCode?: string | null;
  accessHint?: AccessHint | null;
  requestProfile?: string | null;
  requestRoute?: 'direct' | 'proxy' | null;
  requestProxy?: string | null;
  requestSource?: 'profile' | 'pac' | null;
  failureStage?: 'configuration' | 'pac' | 'proxy' | 'target' | null;
  proxyHttpCode?: number | null;
}

export interface Result extends Omit<CheckResult, 'status' | 'durationMs' | 'finalUrl' | 'redirects'> {
  id: number;
  runId: number;
  urlId: number;
  version: number;
  url: string;
  label: string;
  status: 'ok' | 'error' | 'pending';
  durationMs: number | null;
  finalUrl: string | null;
  redirects: number | null;
  checkedAt: string | null;
  tlsCode: string | null;
  accessHint: AccessHint | null;
}

export interface Address {
  id: number;
  url: string;
  label: string;
  version: number;
  removedAt: string | null;
  latest: Result | null;
}

export type AddressRow = Omit<Address, 'latest'> & {
  latest: Pick<Result, 'status' | 'httpCode' | 'durationMs' | 'checkedAt'> | null;
};

export interface Version {
  version: number;
  url: string;
  createdAt: string;
}

export interface Run {
  id: number;
  projectId: number;
  source: 'manual' | 'schedule';
  tlsProfile: TlsProfile;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  createdAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  available: number;
  failures: number;
  group?: Pick<WorkGroup, 'id' | 'name'>;
}

export interface WorkGroup { id: number; name: string; count: number }

export function isActiveRun(run: Run) {
  return run.status === 'queued' || run.status === 'running';
}

export interface Notification {
  id: number;
  projectId: number;
  projectName: string;
  runId: number;
  total: number;
  available: number;
  failures: number;
  createdAt: string;
  readAt: string | null;
  delivery: 'disabled' | 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
  attempts: number;
  deliveryError: string | null;
}

export interface NotificationPage {
  items: Notification[];
  nextBefore: number | null;
}

export interface ImportIssue {
  line: number;
  input: string;
  kind: 'invalid' | 'duplicate' | 'limit';
  message: string;
}

export interface ImportResult {
  added: number;
  duplicates: number;
  invalid: number;
  skipped: number;
  issues: ImportIssue[];
  documents?: number;
}

export const ADDRESS_SORTS = ['url', 'label', 'status', 'httpCode', 'durationMs', 'checkedAt'] as const;
export type AddressSort = typeof ADDRESS_SORTS[number];
export type AddressStatus = 'all' | 'ok' | 'error' | 'unchecked';

export interface AddressFilters {
  groupId?: number;
  q: string;
  status: AddressStatus;
  sort: AddressSort;
  direction: 'asc' | 'desc';
}
