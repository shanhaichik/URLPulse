import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { CATALOG_DOCUMENT_LIMIT, CATALOG_URL_LIMIT, type CatalogClearPreview, type CatalogFilter, type CatalogJob, type CatalogJobPage, type CatalogPage, type CatalogSource, type ImportState } from '../../shared/catalog.js';
import type { TlsProfile } from '../../shared/types.js';
import { normalizeUrl } from '../checker.js';
import { scopeConfirmation } from '../confirmation.js';
import { CatalogTransfers } from './transfer.js';
import { ApiError } from '../store.js';

export type CatalogInput = { url: string; sourceId?: never } | { fileName: string; sourceId?: number } | { sourceId: number };
export interface CatalogDocument { id: number; location: string }
export interface SitemapEntry { loc: string; lastmod: string | null }

const sourceFields = 'id, name, url, current_id AS currentId, previous_id AS previousId, count, added, changed, removed';
const localDocument = '@upload';
const jobPageSize = 20;

export class Catalog {
  private readonly db: DatabaseSync;
  readonly transfers: CatalogTransfers;

  constructor(file: string, timeout = 100) {
    this.db = new DatabaseSync(file, { timeout });
    this.transfers = new CatalogTransfers(this.db);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA temp_store = FILE;');
  }

  close() { this.db.close(); }

  private get<T>(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  private all<T>(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }

  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recover() {
    this.db.exec(`
      UPDATE catalog_transfers SET state='queued' WHERE state='running';
      UPDATE catalog_imports SET state='queued' WHERE state='running';
      UPDATE catalog_imports SET state='failed', error='Загрузка файла прервалась. Выберите файл повторно.'
        WHERE state='upload';
    `);
  }

  sources(projectId: number) {
    return this.all<CatalogSource>(`SELECT ${sourceFields} FROM catalog_sources WHERE project_id=? ORDER BY id`, projectId);
  }

  private source(projectId: number, id: number) {
    const source = this.get<CatalogSource>(`SELECT ${sourceFields} FROM catalog_sources WHERE project_id=? AND id=?`, projectId, id);
    if (!source) throw new ApiError(404, 'Источник sitemap не найден.');
    return source;
  }

  private activeImport(sourceId: number) {
    return this.get("SELECT 1 FROM catalog_imports WHERE source_id=? AND state IN ('upload','queued','running','paused')", sourceId);
  }

  editSource(projectId: number, id: number, input: string) {
    let url: string;
    try { url = normalizeSitemapUrl(input); }
    catch (error) { throw new ApiError(400, (error as Error).message); }
    return this.atomic(() => {
      const source = this.source(projectId, id);
      if (!source.url) throw new ApiError(400, 'У источника из файла нет ссылки для редактирования.');
      if (source.url === url) return source;
      if (this.activeImport(id)) throw new ApiError(409, 'Дождитесь завершения импорта или отмените его.');
      if (this.get('SELECT 1 FROM catalog_sources WHERE project_id=? AND url=?', projectId, url)) {
        throw new ApiError(409, 'Источник с этой ссылкой уже добавлен.');
      }
      this.run('UPDATE catalog_sources SET url=?,name=? WHERE id=?', url, url, id);
      return this.source(projectId, id);
    });
  }

  deleteSource(projectId: number, id: number) {
    return this.atomic(() => {
      this.source(projectId, id);
      if (this.activeImport(id)) throw new ApiError(409, 'Дождитесь завершения импорта или отмените его.');
      if (this.get(`SELECT 1 FROM catalog_imports i JOIN catalog_transfer_sources t ON t.import_id=i.id
        WHERE i.source_id=? LIMIT 1`, id)) {
        throw new ApiError(409, 'Дождитесь завершения переноса адресов или остановите его.');
      }
      const files = this.all<{ key: string }>('SELECT file_key AS key FROM catalog_imports WHERE source_id=? AND file_key IS NOT NULL', id);
      this.run('DELETE FROM catalog_sources WHERE id=?', id);
      return files;
    });
  }

  private clearScope(projectId: number): CatalogClearPreview {
    const project = this.get<{ name: string }>('SELECT name FROM projects WHERE id=?', projectId);
    if (!project) throw new ApiError(404, 'Проект не найден.');
    const sources = this.sources(projectId);
    const imports = this.all<{ id: number; state: ImportState }>(`
      SELECT i.id,i.state FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
      WHERE s.project_id=? ORDER BY i.id`, projectId);
    const transfer = this.get<{ id: number; state: string; created_at: string }>(
      'SELECT id,state,created_at FROM catalog_transfers WHERE project_id=? ORDER BY id DESC LIMIT 1', projectId);
    return { projectName: project.name, sources: sources.length,
      publishedUrls: sources.reduce((total, source) => total + source.count, 0),
      imports: imports.length, activeImports: imports.filter(job => ['upload', 'queued', 'running', 'paused'].includes(job.state)).length,
      transferActive: transfer?.state === 'queued' || transfer?.state === 'running',
      confirmation: scopeConfirmation([projectId, project, sources, imports, transfer]) };
  }

  previewClear(projectId: number): CatalogClearPreview {
    this.db.exec('BEGIN');
    try { return this.clearScope(projectId); } finally { this.db.exec('ROLLBACK'); }
  }

  clearProject(projectId: number, confirmation: string) {
    return this.atomic(() => {
      const scope = this.clearScope(projectId);
      if (!scope.sources || confirmation !== scope.confirmation) {
        throw new ApiError(409, 'Источники или операции каталога изменились. Проверьте обновлённый предпросмотр.');
      }
      const files = this.all<{ key: string }>(`SELECT i.file_key AS key FROM catalog_sources s
        JOIN catalog_imports i ON i.source_id=s.id WHERE s.project_id=? AND i.file_key IS NOT NULL`, projectId);
      this.run('DELETE FROM catalog_transfers WHERE project_id=?', projectId);
      this.run('DELETE FROM catalog_sources WHERE project_id=?', projectId);
      return { files, deleted: scope.sources };
    });
  }

  create(projectId: number, input: CatalogInput) {
    return this.atomic(() => {
      const project = this.get<{ tls_profile: TlsProfile }>('SELECT tls_profile FROM projects WHERE id=?', projectId);
      if (!project) throw new ApiError(404, 'Проект не найден.');
      let requestedUrl: string | null = null;
      if ('url' in input) {
        try { requestedUrl = normalizeSitemapUrl(input.url); }
        catch (error) { throw new ApiError(400, (error as Error).message); }
      }
      const fileName = 'fileName' in input ? input.fileName.trim().slice(0, 255) : null;
      const source = input.sourceId ? this.source(projectId, input.sourceId)
        : requestedUrl ? this.get<CatalogSource>(`SELECT ${sourceFields} FROM catalog_sources WHERE project_id=? AND url=?`, projectId, requestedUrl)
          : undefined;
      if (!requestedUrl && !fileName && !source?.url) throw new ApiError(400, 'Выберите XML-файл или укажите ссылку.');
      if (source && fileName && source.url) throw new ApiError(400, 'Для источника по ссылке используйте обновление по ссылке.');
      const sourceId = source?.id ?? Number(this.run('INSERT INTO catalog_sources(project_id,name,url) VALUES (?,?,?)',
        projectId, requestedUrl ?? fileName!, requestedUrl).lastInsertRowid);
      if (this.activeImport(sourceId)) {
        throw new ApiError(409, 'Для этого источника уже есть активный импорт.');
      }
      const result = this.run('INSERT INTO catalog_imports(source_id,state,profile,file_name,file_key,created_at) VALUES (?,?,?,?,?,?)',
        sourceId, fileName ? 'upload' : 'queued', project.tls_profile, fileName, fileName ? randomUUID() : null, new Date().toISOString());
      const id = Number(result.lastInsertRowid);
      this.run('INSERT INTO catalog_documents(import_id,location) VALUES (?,?)', id, fileName ? localDocument : requestedUrl ?? source!.url!);
      return this.job(projectId, id);
    });
  }

  private getJob(id: number, projectId?: number) {
    const job = this.get<Omit<CatalogJob, 'warning' | 'needsFile'> & { warning: number; needsFile: number }>(`
      SELECT i.id,i.source_id AS sourceId,i.created_at AS createdAt,i.state,i.error,i.problem_file AS problemFile, i.file_name IS NOT NULL AS needsFile,
        COALESCE(SUM(d.records),0) AS records, COALESCE(SUM(d.records-d.duplicates-d.invalid),0) AS uniqueUrls,
        COALESCE(SUM(d.duplicates),0) AS duplicates, COALESCE(SUM(d.invalid),0) AS invalid,
        COALESCE(SUM(d.done),0) AS documentsDone, COUNT(d.id) AS documentsTotal, COALESCE(SUM(d.bytes),0) AS bytes,
        COALESCE(MAX(CASE WHEN d.records>50000 OR d.bytes>52428800 THEN 1 ELSE 0 END),0) AS warning
      FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
      LEFT JOIN catalog_documents d ON d.import_id=i.id
      WHERE i.id=? AND (? IS NULL OR s.project_id=?) GROUP BY i.id
    `, id, projectId ?? null, projectId ?? null);
    if (!job) throw new ApiError(404, 'Импорт sitemap не найден.');
    return { ...job, warning: Boolean(job.warning), needsFile: Boolean(job.needsFile) };
  }

  job(projectId: number, id: number) { return this.getJob(id, projectId); }

  jobs(projectId: number) {
    return this.all<{ id: number }>(`
      SELECT i.id FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
        WHERE s.project_id=? AND i.state IN ('upload','queued','running','paused')
      UNION
      SELECT id FROM (
        SELECT i.id FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
        WHERE s.project_id=? ORDER BY i.id DESC LIMIT ?
      ) ORDER BY id DESC`, projectId, projectId, jobPageSize).map(({ id }) => this.getJob(id, projectId));
  }

  jobHistory(projectId: number, before?: number): CatalogJobPage {
    const cursor = before === undefined ? [] : [before];
    const rows = this.all<{ id: number }>(`SELECT i.id
      FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
      WHERE s.project_id=? ${cursor.length ? 'AND i.id<?' : ''} ORDER BY i.id DESC LIMIT ?`,
      projectId, ...cursor, jobPageSize + 1);
    const more = rows.length > jobPageSize;
    if (more) rows.pop();
    return { jobs: rows.map(({ id }) => this.getJob(id, projectId)), next: more ? rows.at(-1)!.id : null };
  }

  uploaded(projectId: number, id: number) {
    if (this.job(projectId, id).state !== 'upload') throw new ApiError(409, 'Задание уже получило файл или было остановлено.');
    this.run("UPDATE catalog_imports SET state='queued' WHERE id=? AND state='upload'", id);
  }

  failUpload(id: number, error: string) {
    this.run("UPDATE catalog_imports SET state='failed',error=? WHERE id=? AND state='upload'", error, id);
  }

  control(projectId: number, id: number, action: 'cancel' | 'pause' | 'resume') {
    return this.atomic(() => {
      const job = this.job(projectId, id);
      const { state, sourceId } = job;
      const transitions: Partial<Record<ImportState, ImportState>> = action === 'resume' ? { paused: 'queued', failed: 'queued' }
        : action === 'pause' ? { queued: 'paused', running: 'paused' } : {
          upload: 'cancelled', queued: 'cancelled', running: 'cancelled', paused: 'cancelled', failed: 'cancelled',
        };
      const next = transitions[state];
      if (!next) throw new ApiError(409, 'Действие недоступно в текущем состоянии импорта.');
      if (action === 'resume') {
        const source = this.source(projectId, sourceId);
        if ((source.currentId ?? 0) > id) throw new ApiError(409, 'Для источника уже опубликована более новая версия.');
        const root = this.get<CatalogDocument>('SELECT id,location FROM catalog_documents WHERE import_id=? ORDER BY id LIMIT 1', id);
        if (source.url && root?.location !== source.url) {
          throw new ApiError(409, 'Ссылка на sitemap изменилась. Запустите обновление источника.');
        }
        if (state === 'failed' && this.activeImport(sourceId)) throw new ApiError(409, 'Для этого источника уже запущен новый импорт.');
        if (root && state === 'failed' && job.records > 0 && job.uniqueUrls === 0 && job.documentsDone === job.documentsTotal) {
          this.run('DELETE FROM catalog_documents WHERE import_id=? AND id<>?', id, root.id);
          this.run('UPDATE catalog_documents SET done=0,records=0,duplicates=0,invalid=0,bytes=0 WHERE id=?', root.id);
        }
      }
      this.run('UPDATE catalog_imports SET state=?, error=NULL, problem_file=NULL WHERE id=?', next, id);
      return this.job(projectId, id);
    });
  }

  next() { return this.get<{ id: number }>("SELECT id FROM catalog_imports WHERE state='queued' ORDER BY id LIMIT 1")?.id; }
  nextCleanup() {
    return this.get<{ id: number }>(`SELECT i.id FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
      WHERE (i.state='cancelled' OR (i.state IN ('done', 'failed') AND s.current_id>i.id AND s.previous_id IS NOT i.id))
        AND NOT EXISTS (SELECT 1 FROM catalog_transfer_sources pin WHERE pin.import_id=i.id)
        AND (EXISTS (SELECT 1 FROM catalog_urls u WHERE u.import_id=i.id)
          OR EXISTS (SELECT 1 FROM catalog_diffs d WHERE d.import_id=i.id))
      ORDER BY i.id LIMIT 1`)?.id;
  }
  fileKey(id: number) { return this.get<{ key: string | null }>('SELECT file_key AS key FROM catalog_imports WHERE id=?', id)?.key; }
  importProject(id: number) {
    return this.get<{ projectId: number }>(`SELECT s.project_id AS projectId FROM catalog_imports i
      JOIN catalog_sources s ON s.id=i.source_id WHERE i.id=?`, id)?.projectId;
  }
  openFileKey(key: string) {
    return this.get<{ id: number }>("SELECT id FROM catalog_imports WHERE file_key=? AND state IN ('upload','queued','running','paused','failed')", key)?.id;
  }
  state(id: number) { return this.get<{ state: ImportState }>('SELECT state FROM catalog_imports WHERE id=?', id)?.state; }
  workerFailed(id: number) {
    this.run("UPDATE catalog_imports SET state='failed', error='Обработчик импорта завершился. Попробуйте продолжить.' WHERE id=? AND state IN ('queued','running')", id);
  }
  profile(id: number) { return this.get<{ profile: TlsProfile }>('SELECT profile FROM catalog_imports WHERE id=?', id)!.profile; }
  start(id: number) { return this.run("UPDATE catalog_imports SET state='running' WHERE id=? AND state='queued'", id).changes !== 0; }
  document(id: number) { return this.get<CatalogDocument>('SELECT id,location FROM catalog_documents WHERE import_id=? AND done=0 ORDER BY id LIMIT 1', id); }
  isLocal(doc: CatalogDocument) { return doc.location === localDocument; }

  resetDocument(id: number, document: number) {
    for (;;) {
      const change = this.run(`DELETE FROM catalog_urls WHERE import_id=? AND url IN
        (SELECT url FROM catalog_urls WHERE import_id=? AND document_id=? LIMIT 1500)`, id, id, document);
      if (!change.changes) break;
    }
    this.run('UPDATE catalog_documents SET records=0,duplicates=0,invalid=0,bytes=0 WHERE import_id=? AND id=?', id, document);
  }

  completeDocument(id: number, document: number, bytes: number, locations: string[]) {
    this.atomic(() => {
      if (this.state(id) !== 'running') throw new Error('Импорт остановлен.');
      const insert = this.db.prepare('INSERT OR IGNORE INTO catalog_documents(import_id,location) VALUES (?,?)');
      for (const location of locations) insert.run(id, location);
      const total = this.get<{ count: number }>('SELECT COUNT(*) AS count FROM catalog_documents WHERE import_id=?', id)!.count;
      if (total > CATALOG_DOCUMENT_LIMIT) throw new Error('В импорте больше 1 000 файлов sitemap.');
      this.run('UPDATE catalog_documents SET done=1,bytes=? WHERE id=?', bytes, document);
    });
  }

  insertEntries(id: number, document: number, entries: SitemapEntry[], bytes: number) {
    this.atomic(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO catalog_urls VALUES (?,?,?,?,?,?)');
      let duplicates = 0, invalid = 0;
      for (const entry of entries) {
        let url: URL;
        try { url = new URL(normalizeSitemapUrl(entry.loc)); } catch { invalid++; continue; }
        if (!insert.run(id, url.href, url.hostname, url.pathname, entry.lastmod, document).changes) duplicates++;
      }
      this.run(`UPDATE catalog_documents SET records=records+?,duplicates=duplicates+?,invalid=invalid+?,bytes=?
        WHERE id=?`, entries.length, duplicates, invalid, bytes, document);
      const { uniqueUrls } = this.getJob(id);
      if (uniqueUrls > CATALOG_URL_LIMIT) throw new Error('Превышен лимит в 1 000 000 уникальных URL на проект.');
    });
  }

  previousBytes(id: number) {
    return this.get<{ bytes: number }>('SELECT COALESCE(SUM(bytes),0) AS bytes FROM catalog_documents WHERE import_id=? AND done=1', id)!.bytes;
  }

  fail(id: number, error: string, document?: CatalogDocument) {
    const problem = document?.location === localDocument
      ? this.get<{ file_name: string }>('SELECT file_name FROM catalog_imports WHERE id=?', id)?.file_name : document?.location;
    this.run("UPDATE catalog_imports SET state='failed',error=?,problem_file=? WHERE id=? AND state='running'",
      error.slice(0, 500), problem ?? null, id);
  }

  publish(id: number) {
    if (this.state(id) !== 'running') return;
    const source = this.get<{ id: number; project_id: number; current_id: number | null; previous_id: number | null }>(
      'SELECT s.id,s.project_id,s.current_id,s.previous_id FROM catalog_sources s JOIN catalog_imports i ON i.source_id=s.id WHERE i.id=?', id,
    )!;
    const { records, uniqueUrls: count } = this.getJob(id);
    if (records > 0 && count === 0) throw new Error('В sitemap нет корректных адресов. Опубликованная версия не изменена.');
    const prior = source.current_id;
    if (this.get('SELECT id FROM catalog_sources WHERE project_id=? AND id<>? AND current_id IS NOT NULL LIMIT 1',
      source.project_id, source.id)) {
      const total = this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM (
        SELECT url FROM catalog_urls WHERE import_id=? UNION
        SELECT u.url FROM catalog_sources s JOIN catalog_urls u ON u.import_id=s.current_id
        WHERE s.project_id=? AND s.id<>?
      )`, id, source.project_id, source.id)!.count;
      if (total > CATALOG_URL_LIMIT) throw new Error('Суммарный каталог проекта превышает 1 000 000 URL.');
    }
    if (prior !== null) {
      this.compare(id, id, prior, false);
      this.compare(id, prior, id, true);
    }
    const counts = this.all<{ kind: 'added' | 'removed' | 'changed'; count: number }>(
      'SELECT kind,COUNT(*) AS count FROM catalog_diffs WHERE import_id=? GROUP BY kind', id);
    const totals = { added: prior === null ? count : 0, removed: 0, changed: 0 };
    for (const entry of counts) totals[entry.kind] = entry.count;
    const { added, removed, changed } = totals;
    this.atomic(() => {
      if (this.state(id) !== 'running') return;
      if (prior !== null && prior > id) throw new Error('Для источника уже опубликована более новая версия.');
      this.run('UPDATE catalog_sources SET current_id=?,previous_id=?,count=?,added=?,changed=?,removed=? WHERE id=?',
        id, prior, count, added, changed, removed, source.id);
      this.run("UPDATE catalog_imports SET state='done' WHERE id=?", id);
    });
  }

  private compare(revision: number, left: number, right: number, removed: boolean) {
    const range = this.db.prepare(`SELECT MAX(url) AS last FROM (
      SELECT url FROM catalog_urls WHERE import_id=? AND url>? ORDER BY url LIMIT 2048
    )`);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO catalog_diffs(import_id,kind,url,domain,path)
      SELECT ?,${removed ? "'removed'" : "CASE WHEN b.url IS NULL THEN 'added' ELSE 'changed' END"}, a.url,a.domain,a.path
      FROM catalog_urls a LEFT JOIN catalog_urls b ON b.import_id=? AND b.url=a.url
      WHERE a.import_id=? AND a.url>? AND a.url<=?
        AND (${removed ? 'b.url IS NULL' : 'b.url IS NULL OR a.lastmod IS NOT b.lastmod'})
    `);
    let cursor = '';
    while (this.state(revision) === 'running') {
      const { last } = range.get(left, cursor) as { last: string | null };
      if (!last) return;
      insert.run(revision, right, left, cursor, last);
      cursor = last;
    }
  }

  discardRows(id: number) {
    while (this.run(`DELETE FROM catalog_urls WHERE import_id=? AND url IN
      (SELECT url FROM catalog_urls WHERE import_id=? LIMIT 1500)`, id, id).changes) { /* Bound write lock duration. */ }
    while (this.run(`DELETE FROM catalog_diffs WHERE import_id=? AND (kind,url) IN
      (SELECT kind,url FROM catalog_diffs WHERE import_id=? LIMIT 1500)`, id, id).changes) { /* Bound write lock duration. */ }
  }

  page(projectId: number, filter: CatalogFilter, limit = 100): CatalogPage {
    this.db.exec('BEGIN');
    try { return this.pageInSnapshot(projectId, filter, limit); }
    finally { this.db.exec('ROLLBACK'); }
  }

  private pageInSnapshot(projectId: number, filter: CatalogFilter, limit: number): CatalogPage {
    const source = this.source(projectId, filter.sourceId);
    if (filter.revision !== undefined && filter.revision !== source.currentId) {
      throw new ApiError(409, 'Каталог изменился. Откройте первую страницу.');
    }
    if (source.currentId === null) return { revision: 0, items: [], next: null };
    const change = filter.change ?? 'all';
    if (change !== 'all' && source[change] === 0) return { revision: source.currentId, items: [], next: null };
    const diff = source.previousId !== null && change !== 'all';
    const left = change === 'removed' ? source.previousId : source.currentId;
    const args: SQLInputValue[] = diff ? [left, source.currentId, change] : [source.previousId, left];
    const direction = filter.direction === 'desc' ? 'DESC' : 'ASC';
    const comparison = direction === 'DESC' ? '<' : '>';
    const conditions: string[] = [];
    if (filter.domain) { conditions.push('a.domain=?'); args.push(filter.domain); }
    if (filter.prefix) { conditions.push('a.path>=? AND a.path<?'); args.push(filter.prefix, filter.prefix + '\uffff'); }
    if (filter.after && filter.prefix) {
      conditions.push(`(a.path,a.url) ${comparison} (?,?)`);
      args.push(new URL(normalizeSitemapUrl(filter.after)).pathname, filter.after);
    } else if (filter.after) {
      conditions.push(`a.url${comparison}?`);
      args.push(filter.after);
    }
    const select = diff
      ? `SELECT a.url,u.lastmod,a.kind AS change FROM catalog_diffs a
         CROSS JOIN catalog_urls u ON u.import_id=? AND u.url=a.url
         WHERE a.import_id=? AND a.kind=?`
      : `SELECT a.url,a.lastmod,
           CASE WHEN b.url IS NULL THEN 'added' WHEN a.lastmod IS NOT b.lastmod THEN 'changed' END AS change
         FROM catalog_urls a LEFT JOIN catalog_urls b ON b.import_id=? AND b.url=a.url
         WHERE a.import_id=?`;
    const items = this.all<CatalogPage['items'][number]>(`
      ${select} ${conditions.map(condition => 'AND ' + condition).join(' ')}
      ORDER BY ${filter.prefix ? `a.path ${direction}, ` : ''}a.url ${direction} LIMIT ?
    `, ...args, limit + 1);
    const more = items.length > limit;
    if (more) items.pop();
    return { revision: source.currentId, items, next: more ? items[items.length - 1].url : null };
  }

  selection(projectId: number, filter: CatalogFilter, selected: string[]) {
    const source = this.source(projectId, filter.sourceId);
    if (source.currentId === null || filter.revision !== source.currentId) {
      throw new ApiError(409, 'Каталог изменился. Откройте первую страницу.');
    }
    const snapshot = filter.change === 'removed' ? source.previousId : source.currentId;
    const find = this.db.prepare('SELECT url FROM catalog_urls WHERE import_id=? AND url=?');
    if (selected.some(url => !find.get(snapshot, url))) throw new ApiError(409, 'Часть адресов больше недоступна в каталоге.');
    return selected;
  }

  csv(file: string, projectId: number, filter: CatalogFilter, selected?: string[]) {
    // A read transaction keeps both revisions available even if a refresh publishes during export.
    const snapshot = new Catalog(file);
    try {
      snapshot.db.exec('BEGIN');
      const first = snapshot.pageInSnapshot(projectId, { ...filter, after: undefined }, selected ? 1 : 1_000);
      const source = snapshot.source(projectId, filter.sourceId);
      const removed = filter.change === 'removed';
      const left = removed ? source.previousId : source.currentId;
      const right = removed ? source.currentId : source.previousId;
      const lookup = snapshot.db.prepare(`SELECT a.url,a.lastmod,
        ${removed ? "'removed'" : "CASE WHEN b.url IS NULL THEN 'added' WHEN a.lastmod IS NOT b.lastmod THEN 'changed' END"} AS change
        FROM catalog_urls a LEFT JOIN catalog_urls b ON b.import_id=? AND b.url=a.url
        WHERE a.import_id=? AND a.url=?`);
      const chosen = selected ? snapshot.selection(projectId, filter, selected) : undefined;
      let page = first;
      const quote = (text: string | null) => '"' + (text ?? '').replaceAll('"', '""') + '"';
      const stream = Readable.from((async function* () {
        yield '\uFEFFurl,lastmod,change\r\n';
        const line = (row: CatalogPage['items'][number]) => [row.url, row.lastmod, row.change].map(quote).join(',') + '\r\n';
        if (chosen) {
          for (const url of chosen) yield line(lookup.get(right, left, url) as CatalogPage['items'][number]);
          return;
        }
        for (;;) {
          if (page.items.length) yield page.items.map(line).join('');
          if (!page.next) return;
          await new Promise<void>(resolve => setImmediate(resolve));
          page = snapshot.pageInSnapshot(projectId, { ...filter, revision: page.revision, after: page.next }, 1_000);
        }
      })(), { objectMode: false });
      stream.once('close', () => snapshot.close());
      return stream;
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }
}

export function normalizeSitemapUrl(value: string) {
  if (!/^https?:\/\//i.test(value.trim())) throw new ApiError(400, 'Укажите полный HTTP(S) URL.');
  return normalizeUrl(value);
}
