import { catalogSchema } from './catalog/schema.js';
import { CHECK_CONCURRENCY } from '../shared/types.js';

export const checkConcurrencyColumn = `check_concurrency INTEGER NOT NULL DEFAULT ${CHECK_CONCURRENCY.default}
  CHECK (typeof(check_concurrency) = 'integer' AND check_concurrency BETWEEN ${CHECK_CONCURRENCY.min} AND ${CHECK_CONCURRENCY.max})`;

export const requestProfileTables = ['request_profiles', 'request_url_profiles'] as const;
export const pacTables = ['project_pac_versions'] as const;
export const resultRequestColumns = {
  request_profile_override: 'INTEGER',
  request_profile: 'TEXT',
  request_route: 'TEXT',
  request_proxy: 'TEXT',
  request_source: 'TEXT',
  failure_stage: 'TEXT',
  proxy_http_code: 'INTEGER',
};

export const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  url_count INTEGER NOT NULL DEFAULT 0,
  worklist_revision INTEGER NOT NULL DEFAULT 0,
  view_revision INTEGER NOT NULL DEFAULT 0,
  request_revision INTEGER NOT NULL DEFAULT 0,
  schedule TEXT,
  next_at INTEGER,
  notify TEXT NOT NULL DEFAULT 'all',
  email TEXT,
  tls_profile TEXT NOT NULL DEFAULT 'default' CHECK (tls_profile IN ('default', 'russian-ca')),
  ${checkConcurrencyColumn}
);

CREATE TABLE IF NOT EXISTS id_sequences (
  entity TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  removed_at TEXT,
  worklist INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS active_project_url ON urls(project_id, url) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS archived_project_url ON urls(project_id, url, id DESC) WHERE removed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS url_versions (
  url_id INTEGER NOT NULL REFERENCES urls(id),
  version INTEGER NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(url_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  request_revision INTEGER NOT NULL DEFAULT 0,
  request_snapshot TEXT,
  pac_revision TEXT,
  tls_profile TEXT NOT NULL DEFAULT 'default' CHECK (tls_profile IN ('default', 'russian-ca'))
);
CREATE INDEX IF NOT EXISTS project_runs ON runs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS completed_run_times ON runs(project_id, finished_at DESC, id DESC) WHERE status='done';
CREATE INDEX IF NOT EXISTS queued_runs ON runs(id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS project_active_runs ON runs(project_id,status) WHERE status IN ('queued','running');

INSERT INTO id_sequences (entity, last_id) SELECT 'project', COALESCE(MAX(id), 0) FROM projects WHERE true
ON CONFLICT(entity) DO UPDATE SET last_id = MAX(id_sequences.last_id, excluded.last_id);
INSERT INTO id_sequences (entity, last_id) SELECT 'run', COALESCE(MAX(id), 0) FROM runs WHERE true
ON CONFLICT(entity) DO UPDATE SET last_id = MAX(id_sequences.last_id, excluded.last_id);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  url_id INTEGER NOT NULL REFERENCES urls(id),
  version INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  http_code INTEGER,
  duration_ms INTEGER,
  final_url TEXT,
  redirects INTEGER,
  content_type TEXT,
  content_length TEXT,
  error_kind TEXT,
  tls_code TEXT,
  access_hint TEXT,
  error TEXT,
  checked_at TEXT,
  ${Object.entries(resultRequestColumns).map(([column, type]) => `${column} ${type}`).join(',\n  ')},
  UNIQUE(run_id, url_id)
);
CREATE INDEX IF NOT EXISTS project_url_result_time ON results(url_id, version, checked_at DESC, id DESC) WHERE checked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS url_result_history_time ON results(url_id, checked_at DESC, id DESC) WHERE checked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_results ON results(run_id, id);
CREATE INDEX IF NOT EXISTS pending_run_results ON results(run_id,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS checked_run_results ON results(run_id,id) WHERE checked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS request_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  config TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS request_profiles_project ON request_profiles(project_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS request_profiles_default ON request_profiles(project_id,origin) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS request_url_profiles (
  url_id INTEGER PRIMARY KEY REFERENCES urls(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES request_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_pac_versions (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  filename TEXT NOT NULL,
  source TEXT NOT NULL,
  proxy_rules TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (project_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS current_project_pac ON project_pac_versions(project_id) WHERE active=1;

CREATE TABLE IF NOT EXISTS stopped_run_targets (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url_id INTEGER NOT NULL REFERENCES urls(id),
  version INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(run_id, position)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stopped_run_targets_by_address ON stopped_run_targets(run_id, url_id);

CREATE TABLE IF NOT EXISTS work_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS active_work_group_names ON work_groups(project_id,name_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS project_work_groups ON work_groups(project_id,id);
CREATE TABLE IF NOT EXISTS work_group_urls (
  group_id INTEGER NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
  url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id,url_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS url_work_groups ON work_group_urls(url_id);
CREATE TABLE IF NOT EXISTS work_group_runs (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_run_history ON work_group_runs(group_id,run_id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  total INTEGER NOT NULL,
  available INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivery TEXT NOT NULL,
  email_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivery_error TEXT,
  retry_at INTEGER,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS pending_email ON notifications(retry_at) WHERE delivery = 'pending';
${catalogSchema}
`;

export const projectViewTriggers = `
CREATE TRIGGER IF NOT EXISTS project_view_changed AFTER UPDATE OF
  name,description,url_count,worklist_revision,schedule,next_at,notify,email,tls_profile,check_concurrency ON projects
BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS project_run_added AFTER INSERT ON runs BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS project_run_changed AFTER UPDATE ON runs BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS project_run_removed AFTER DELETE ON runs BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=OLD.project_id;
END;
CREATE TRIGGER IF NOT EXISTS project_transfer_added AFTER INSERT ON catalog_transfers
WHEN NEW.state IN ('queued','running') BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS project_transfer_changed AFTER UPDATE OF state ON catalog_transfers
WHEN (OLD.state IN ('queued','running')) <> (NEW.state IN ('queued','running')) BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS project_transfer_removed AFTER DELETE ON catalog_transfers
WHEN OLD.state IN ('queued','running') BEGIN
  UPDATE projects SET view_revision=view_revision+1 WHERE id=OLD.project_id;
END;
`;

const resultColumns = {
  id: 'id', runId: 'run_id', urlId: 'url_id', version: 'version', url: 'url', label: 'label', status: 'status',
  httpCode: 'http_code', durationMs: 'duration_ms', finalUrl: 'final_url', redirects: 'redirects',
  contentType: 'content_type', contentLength: 'content_length', errorKind: 'error_kind', tlsCode: 'tls_code',
  accessHint: 'access_hint', error: 'error', checkedAt: 'checked_at',
  requestProfile: 'request_profile', requestRoute: 'request_route', failureStage: 'failure_stage', proxyHttpCode: 'proxy_http_code',
  requestProxy: 'request_proxy', requestSource: 'request_source',
};

export function selectResultFields(prefix = '', aliasPrefix = '') {
  return Object.entries(resultColumns).map(([key, column]) => `${prefix}${column} AS ${aliasPrefix}${key}`).join(', ');
}

export const resultFields = selectResultFields();

export const runFields = `
  r.id, r.project_id AS projectId, r.source, r.tls_profile AS tlsProfile, r.status, r.created_at AS createdAt,
  r.finished_at AS finishedAt, r.total, r.completed, r.available, r.failures
`;

export const notificationFields = `
  n.id, n.project_id AS projectId, p.name AS projectName, n.run_id AS runId, n.total,
  n.available, n.failures, n.created_at AS createdAt, n.read_at AS readAt,
  n.delivery, n.attempts, n.delivery_error AS deliveryError
`;
