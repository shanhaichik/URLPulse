export const catalogTables = ['catalog_sources', 'catalog_imports', 'catalog_documents', 'catalog_urls', 'catalog_diffs',
  'catalog_transfers', 'catalog_transfer_sources'] as const;

export const catalogSchema = `
CREATE TABLE IF NOT EXISTS catalog_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  current_id INTEGER,
  previous_id INTEGER,
  count INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS catalog_project_sources ON catalog_sources(project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_source_url ON catalog_sources(project_id, url) WHERE url IS NOT NULL;

CREATE TABLE IF NOT EXISTS catalog_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  profile TEXT NOT NULL,
  pac_revision TEXT,
  file_name TEXT,
  file_key TEXT UNIQUE,
  error TEXT,
  problem_file TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_jobs_by_source ON catalog_imports(source_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_one_active_source ON catalog_imports(source_id)
  WHERE state IN ('upload', 'queued', 'running', 'paused');

CREATE TABLE IF NOT EXISTS catalog_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  location TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE(import_id, location)
);

CREATE TABLE IF NOT EXISTS catalog_urls (
  import_id INTEGER NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  url TEXT NOT NULL COLLATE BINARY,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  lastmod TEXT,
  document_id INTEGER NOT NULL,
  PRIMARY KEY(import_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS catalog_url_sources ON catalog_urls(url,import_id);
CREATE INDEX IF NOT EXISTS catalog_by_domain ON catalog_urls(import_id, domain, url);
CREATE INDEX IF NOT EXISTS catalog_by_path ON catalog_urls(import_id, path, url);
CREATE INDEX IF NOT EXISTS catalog_by_domain_path ON catalog_urls(import_id, domain, path, url);
CREATE INDEX IF NOT EXISTS catalog_by_document ON catalog_urls(import_id, document_id, url);
CREATE TABLE IF NOT EXISTS catalog_diffs (
  import_id INTEGER NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY(import_id,kind,url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS catalog_diff_domain ON catalog_diffs(import_id,kind,domain,url);
CREATE INDEX IF NOT EXISTS catalog_diff_path ON catalog_diffs(import_id,kind,path,url);
CREATE INDEX IF NOT EXISTS catalog_diff_domain_path ON catalog_diffs(import_id,kind,domain,path,url);

CREATE TABLE IF NOT EXISTS catalog_transfers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  last_import INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  added INTEGER NOT NULL DEFAULT 0,
  existing INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS catalog_project_transfers ON catalog_transfers(project_id,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_one_active_transfer ON catalog_transfers(project_id)
  WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS catalog_transfer_sources (
  transfer_id INTEGER NOT NULL REFERENCES catalog_transfers(id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  PRIMARY KEY(transfer_id,import_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS catalog_transfer_by_import ON catalog_transfer_sources(import_id);
`;
