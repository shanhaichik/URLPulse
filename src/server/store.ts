import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { ADDRESS_SELECTION_LIMIT, type DeleteAllPreview } from '../shared/addresses.js';
import { isActiveRun } from '../shared/types.js';
import type { Address, AddressFilters, AddressRow, CheckResult, ImportIssue, ImportResult, Notification, NotificationPage, Project, Result, Run, Settings, TlsProfile, Version, WorkGroup } from '../shared/types.js';
import type { ReportFilters, ReportResult, RunPage, RunRestart, RunView, StoppedRunResponse } from '../shared/reports.js';
import { canCompareRun } from '../shared/run-comparison.js';
import type { ComparisonFilters, ComparisonInput, ComparisonPage, ComparisonPair, ComparisonSummary } from '../shared/run-comparison.js';
import type { RequestProfileChoice } from '../shared/request-profiles.js';
import { comparisonFields, comparisonJoin, resultFilters } from './report-query.js';
import { comparisonCoverage, comparisonRows, comparisonTotals, eligibleComparisonRun, type ComparisonCoverage } from './run-comparison.js';
import { MAX_PROFILES, profileReferences, type ProfileConfig, type SavedRequestProfile } from './request-profiles.js';
import { normalizeUrl } from './checker.js';
import { scopeConfirmation } from './confirmation.js';
import type { StoredPac } from './pac-config.js';
import { nextOccurrence } from './schedule.js';
import { addressRow, groupWhere, latestResultJoin, workingWhere, WorklistView } from './worklist.js';
import { checkConcurrencyColumn, notificationFields, projectViewTriggers, resultFields, resultRequestColumns, runFields, schema, selectResultFields } from './schema.js';

export const PROJECT_URL_LIMIT = ADDRESS_SELECTION_LIMIT;
export const BATCH_LIMIT = 1_000;
export const PAGE_SIZE = 100;
const RUN_PAGE_SIZE = 25;

export class ApiError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

type ProjectRow = Omit<Project, 'schedule' | 'nextAt'> & { schedule: string | null; nextAt: number | null };
type PickedUrl = Pick<Address, 'id' | 'url' | 'label' | 'version'>;
export type EmailJob = Notification & { email: string; messageId: string };
export type ExportScope = { urlId?: number; runId?: number; groupId?: number };
export interface ExportSelection {
  projectId: number;
  scope: ExportScope;
  filters: ReportFilters;
  until: string;
}
type ExportSnapshot = { reader: Store; temporary?: string };

function iso(value: number) { return new Date(value).toISOString(); }

const activeLatest = `FROM urls u ${latestResultJoin} WHERE ${workingWhere}`;
const archivedUrl = `SELECT id,url,label,version FROM urls WHERE project_id=? AND url=? AND removed_at IS NOT NULL
  ORDER BY worklist DESC,id DESC LIMIT 1`;
const stoppedTargets = `SELECT id AS position,url_id,version,url,label FROM results WHERE run_id=?
  UNION ALL SELECT position,url_id,version,url,label FROM stopped_run_targets WHERE run_id=?`;
const runGroupJoin = 'LEFT JOIN work_group_runs g ON g.run_id=r.id';
const groupedRunFields = `${runFields},g.group_id AS groupId,g.group_name AS groupName`;
type RunRow = Run & { groupId: number | null; groupName: string | null };
function mapRun({ groupId, groupName, ...run }: RunRow): Run {
  return groupId === null ? run : { ...run, group: { id: groupId, name: groupName! } };
}

export class Store {
  private readonly db: DatabaseSync;
  readonly worklist: WorklistView;
  private readonly exports = new Map<string, ExportSnapshot & { selection: ExportSelection }>();
  private readonly comparisonExports = new Map<string, ExportSnapshot & { coverage: ComparisonCoverage; filters: ComparisonFilters }>();
  private readonly instance = randomUUID();

  constructor(private readonly file: string, private readonly clock = Date.now, recover = true, initialize = true, readOnly = false) {
    this.db = new DatabaseSync(file, { timeout: initialize ? 100 : 5000, readOnly });
    this.worklist = new WorklistView(this.db);
    if (!initialize) {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE');
      return;
    }
    try {
      this.db.exec(schema);
      this.atomic(() => {
        this.db.exec('DROP INDEX IF EXISTS project_url_results; DROP INDEX IF EXISTS result_history');
        for (const table of ['projects', 'runs']) {
          if (!this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(column => column.name === 'tls_profile')) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN tls_profile TEXT NOT NULL DEFAULT 'default'
              CHECK (tls_profile IN ('default', 'russian-ca'))`);
          }
        }
        if (!this.all<{ name: string }>('PRAGMA table_info(urls)').some(column => column.name === 'worklist')) {
          this.db.exec('ALTER TABLE urls ADD COLUMN worklist INTEGER NOT NULL DEFAULT 1');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS working_urls ON urls(project_id, id) WHERE worklist=1 AND removed_at IS NULL');
        this.db.exec('CREATE INDEX IF NOT EXISTS working_urls_by_url ON urls(project_id,url COLLATE NOCASE,id) WHERE worklist=1 AND removed_at IS NULL');
        if (!this.all<{ name: string }>('PRAGMA table_info(projects)').some(column => column.name === 'url_count')) {
          this.db.exec(`ALTER TABLE projects ADD COLUMN url_count INTEGER NOT NULL DEFAULT 0;
            UPDATE projects SET url_count=(SELECT COUNT(*) FROM urls
              WHERE project_id=projects.id AND worklist=1 AND removed_at IS NULL)`);
        }
        if (!this.all<{ name: string }>('PRAGMA table_info(projects)').some(column => column.name === 'check_concurrency')) {
          this.db.exec(`ALTER TABLE projects ADD COLUMN ${checkConcurrencyColumn}`);
        }
        if (!this.all<{ name: string }>('PRAGMA table_info(projects)').some(column => column.name === 'worklist_revision')) {
          this.db.exec('ALTER TABLE projects ADD COLUMN worklist_revision INTEGER NOT NULL DEFAULT 0');
        }
        if (!this.all<{ name: string }>('PRAGMA table_info(projects)').some(column => column.name === 'view_revision')) {
          this.db.exec('ALTER TABLE projects ADD COLUMN view_revision INTEGER NOT NULL DEFAULT 0');
        }
        if (!this.all<{ name: string }>('PRAGMA table_info(runs)').some(column => column.name === 'total')) {
          for (const column of ['total', 'completed', 'available', 'failures']) {
            this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
          }
          this.db.exec(`UPDATE runs SET (total,completed,available,failures) = (
            SELECT COUNT(*),COUNT(checked_at),COUNT(CASE WHEN status='ok' THEN 1 END),
              COUNT(CASE WHEN status='error' THEN 1 END) FROM results WHERE run_id=runs.id
          )`);
        }
        const results = new Set(this.all<{ name: string }>('PRAGMA table_info(results)').map(column => column.name));
        if (!results.has('tls_code')) this.db.exec('ALTER TABLE results ADD COLUMN tls_code TEXT');
        if (!results.has('access_hint')) this.db.exec('ALTER TABLE results ADD COLUMN access_hint TEXT');
        for (const [column, type] of Object.entries(resultRequestColumns)) {
          if (!results.has(column)) this.db.exec(`ALTER TABLE results ADD COLUMN ${column} ${type}`);
        }
        for (const table of ['projects', 'runs']) {
          const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
          if (!columns.some(column => column.name === 'request_revision')) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0`);
          }
          if (table === 'runs' && !columns.some(column => column.name === 'request_snapshot')) {
            this.db.exec('ALTER TABLE runs ADD COLUMN request_snapshot TEXT');
          }
          if (table === 'runs' && !columns.some(column => column.name === 'pac_revision')) {
            this.db.exec('ALTER TABLE runs ADD COLUMN pac_revision TEXT');
          }
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS project_pac_runs ON runs(project_id,pac_revision) WHERE pac_revision IS NOT NULL');
        const notificationColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(notifications)').map(column => column.name));
        if (!notificationColumns.has('cleared_at')) {
          this.db.exec('ALTER TABLE notifications ADD COLUMN cleared_at TEXT');
        }
        if (!notificationColumns.has('email_message_id')) {
          this.db.exec('ALTER TABLE notifications ADD COLUMN email_message_id TEXT');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS visible_notifications ON notifications(id DESC) WHERE cleared_at IS NULL');
        this.db.exec(projectViewTriggers);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (recover) this.recover();
    this.db.exec('PRAGMA busy_timeout = 100');
  }

  recover() {
    this.atomic(() => {
      this.db.exec("UPDATE runs SET status = 'queued' WHERE status = 'running'");
      this.db.exec(`
        UPDATE notifications SET delivery = 'uncertain', retry_at = NULL,
          delivery_error = 'Отправку прервало завершение приложения. Проверьте почтовый ящик получателя.'
        WHERE delivery = 'sending'
      `);
    });
  }

  close() {
    for (const id of this.exports.keys()) this.endExport(id);
    for (const id of this.comparisonExports.keys()) this.endComparisonExport(id);
    this.db.close();
  }

  private get<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  private all<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args) as T[];
  }

  private atomic<T>(fn: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private projectsWhere(where: string, ...args: SQLInputValue[]): Project[] {
    const rows = this.all<ProjectRow>(`
      SELECT p.id, name, description, schedule, next_at AS nextAt, notify, email, tls_profile AS tlsProfile,
        p.url_count AS urlCount, p.check_concurrency AS checkConcurrency
      FROM projects p ${where} ORDER BY p.id
    `, ...args);
    return rows.map(row => ({
      ...row, schedule: row.schedule ? JSON.parse(row.schedule) : null,
      nextAt: row.nextAt === null ? null : iso(row.nextAt),
    }));
  }

  projects() { return this.projectsWhere(''); }

  requireProject(id: number) {
    if (!this.get('SELECT id FROM projects WHERE id=?', id)) throw new ApiError(404, 'Проект не найден.');
  }

  transferActive(id: number) {
    return Boolean(this.get("SELECT id FROM catalog_transfers WHERE project_id=? AND state IN ('queued','running')", id));
  }

  project(id: number) {
    const project = this.projectsWhere('WHERE p.id = ?', id)[0];
    if (!project) throw new ApiError(404, 'Проект не найден.');
    return project;
  }

  private nextId(entity: 'project' | 'run') {
    return this.get<{ id: number }>(
      'UPDATE id_sequences SET last_id = last_id + 1 WHERE entity = ? RETURNING last_id AS id', entity,
    )!.id;
  }

  createProject(name: string, description: string) {
    return this.atomic(() => {
      const id = this.nextId('project');
      this.db.prepare('INSERT INTO projects(id, name, description) VALUES (?, ?, ?)').run(id, name, description);
      return this.project(id);
    });
  }

  overview(projectId: number) {
    this.db.exec('BEGIN');
    try {
      const project = this.project(projectId);
      return { project, viewRevision: this.projectViewRevision(projectId),
        summary: this.worklist.summary(projectId, project.urlCount), activeRun: this.activeRun(projectId),
        transferActive: this.transferActive(projectId), lastStoppedRun: this.restartInfo(this.runs(projectId, undefined, 1)[0]) };
    } finally { this.db.exec('ROLLBACK'); }
  }

  projectWithAddresses(projectId: number, tableOnly: boolean) {
    this.db.exec('BEGIN');
    try {
      const project = this.project(projectId);
      if (project.urlCount > PROJECT_URL_LIMIT) {
        throw new ApiError(413, 'Для большого списка используйте GET /urls/page и GET ?view=summary.');
      }
      const addresses = tableOnly ? this.addressRows(projectId) : this.addresses(projectId);
      const available = addresses.filter(entry => entry.latest?.status === 'ok').length;
      const failures = addresses.filter(entry => entry.latest?.status === 'error').length;
      const total = addresses.length;
      return {
        revision: this.revision(projectId), project, addresses, activeRun: this.activeRun(projectId),
        summary: { total, available, failures, unchecked: total - available - failures },
      };
    } finally { this.db.exec('ROLLBACK'); }
  }

  editProject(id: number, name: string, description?: string) {
    const change = this.db.prepare('UPDATE projects SET name = ?, description = COALESCE(?, description) WHERE id = ?')
      .run(name, description ?? null, id);
    if (!change.changes) throw new ApiError(404, 'Проект не найден.');
    return this.project(id);
  }

  deleteProject(id: number) {
    return this.atomic(() => {
      this.project(id);
      if (this.get("SELECT id FROM runs WHERE project_id = ? AND status = 'running' LIMIT 1", id)) {
        throw new ApiError(409, 'Дождитесь окончания текущей проверки и повторите удаление.');
      }
      if (this.get("SELECT id FROM notifications WHERE project_id = ? AND delivery = 'sending' LIMIT 1", id)) {
        throw new ApiError(409, 'Дождитесь окончания отправки письма и повторите удаление.');
      }
      if (this.get(`SELECT i.id FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
        WHERE s.project_id=? AND i.state IN ('upload','queued','running','paused') LIMIT 1`, id)) {
        throw new ApiError(409, 'Дождитесь завершения импорта sitemap или отмените его.');
      }
      if (this.transferActive(id)) throw new ApiError(409, 'Дождитесь завершения переноса адресов.');
      this.db.prepare('DELETE FROM notifications WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').run(id);
      this.db.prepare('DELETE FROM url_versions WHERE url_id IN (SELECT id FROM urls WHERE project_id = ?)').run(id);
      this.db.prepare('DELETE FROM runs WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM urls WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return { deleted: true };
    });
  }

  saveSettings(id: number, settings: Settings) {
    return this.atomic(() => {
      const current = this.project(id);
      const schedule = settings.schedule ? JSON.stringify(settings.schedule) : null;
      const unchanged = schedule === (current.schedule ? JSON.stringify(current.schedule) : null);
      const next = settings.schedule
        ? unchanged && current.nextAt ? Date.parse(current.nextAt) : nextOccurrence(settings.schedule, this.clock())
        : null;
      this.db.prepare(`UPDATE projects SET schedule=?,next_at=?,notify=?,email=?,tls_profile=?,
        check_concurrency=COALESCE(?,check_concurrency) WHERE id=?`)
        .run(schedule, next, settings.notify, settings.email,
          settings.tlsProfile ?? current.tlsProfile, settings.checkConcurrency ?? null, id);
      return this.project(id);
    });
  }

  private projectViewRevision(projectId: number) {
    const state = this.get<{ view_revision: number }>('SELECT view_revision FROM projects WHERE id=?', projectId);
    if (!state) throw new ApiError(404, 'Проект не найден.');
    return state.view_revision;
  }

  revision(projectId: number, viewRevision = this.projectViewRevision(projectId)) {
    return `${this.instance}.${projectId}.${viewRevision}`;
  }

  private invalidateView(projectId: number) {
    this.db.prepare('UPDATE projects SET view_revision=view_revision+1 WHERE id=?').run(projectId);
  }

  private requestSettingsChanged(projectId: number) {
    this.db.prepare('UPDATE projects SET request_revision=request_revision+1,view_revision=view_revision+1 WHERE id=?').run(projectId);
  }

  projectPac(projectId: number) {
    return this.get<StoredPac>('SELECT filename,revision,source FROM project_pac_versions WHERE project_id=? AND active=1', projectId);
  }

  private discardUnusedPac(projectId: number) {
    this.db.prepare(`DELETE FROM project_pac_versions AS pac WHERE project_id=? AND active=0 AND NOT EXISTS (
      SELECT 1 FROM runs r WHERE r.project_id=pac.project_id AND r.pac_revision=pac.revision
    )`).run(projectId);
  }

  savePac(projectId: number, config?: StoredPac) {
    return this.atomic(() => {
      this.requireProject(projectId);
      const active = this.get<{ revision: string }>('SELECT revision FROM project_pac_versions WHERE project_id=? AND active=1', projectId);
      if (active?.revision === config?.revision) return config;
      this.db.prepare('UPDATE project_pac_versions SET active=0 WHERE project_id=? AND active=1').run(projectId);
      if (config) {
        this.db.prepare(`INSERT INTO project_pac_versions(project_id,revision,filename,source,active)
          VALUES (?,?,?,?,1) ON CONFLICT(project_id,revision) DO UPDATE SET active=1`)
          .run(projectId, config.revision, config.filename, config.source);
      }
      this.discardUnusedPac(projectId);
      this.requestSettingsChanged(projectId);
      return config;
    });
  }

  pacSnapshot(runId: number) {
    const snapshot = this.get<StoredPac>(`SELECT p.filename,r.pac_revision AS revision,p.source FROM runs r
      LEFT JOIN project_pac_versions p ON p.project_id=r.project_id AND p.revision=r.pac_revision
      WHERE r.id=? AND r.pac_revision IS NOT NULL`, runId);
    if (snapshot && snapshot.source === null) throw new Error('Версия PAC для прогона отсутствует в базе.');
    return snapshot;
  }

  requestProfiles(projectId: number): SavedRequestProfile[] {
    return this.all<{ id: number; config: string }>(
      'SELECT id,config FROM request_profiles WHERE project_id=? ORDER BY id', projectId)
      .map(row => ({ ...JSON.parse(row.config) as ProfileConfig, id: row.id }));
  }

  requestProfile(projectId: number, profileId: number): SavedRequestProfile {
    const row = this.get<{ config: string }>('SELECT config FROM request_profiles WHERE project_id=? AND id=?', projectId, profileId);
    if (!row) throw new ApiError(404, 'Профиль запроса не найден.');
    return { ...JSON.parse(row.config) as ProfileConfig, id: profileId };
  }

  saveRequestProfile(projectId: number, profile: ProfileConfig, previous?: SavedRequestProfile): SavedRequestProfile {
    return this.atomic(() => {
      this.requireProject(projectId);
      if (previous) {
        if (JSON.stringify(this.requestProfile(projectId, previous.id)) !== JSON.stringify(previous)) {
          throw new ApiError(409, 'Профиль изменился. Откройте его заново.');
        }
      } else if (this.get<{ count: number }>('SELECT COUNT(*) AS count FROM request_profiles WHERE project_id=?', projectId)!.count >= MAX_PROFILES) {
        throw new ApiError(400, `Можно сохранить до ${MAX_PROFILES} профилей на проект.`);
      }
      if (profile.isDefault && this.get('SELECT id FROM request_profiles WHERE project_id=? AND origin=? AND is_default=1 AND id IS NOT ?',
        projectId, profile.origin, previous?.id ?? null)) {
        throw new ApiError(409, 'Для этого сервера уже выбран профиль по умолчанию.');
      }
      const args = [profile.origin, Number(profile.isDefault), JSON.stringify(profile)] as const;
      let id = previous?.id;
      if (id === undefined) {
        id = Number(this.db.prepare('INSERT INTO request_profiles(project_id,origin,is_default,config) VALUES (?,?,?,?)')
          .run(projectId, ...args).lastInsertRowid);
      } else {
        this.db.prepare('UPDATE request_profiles SET origin=?,is_default=?,config=? WHERE id=? AND project_id=?').run(...args, id, projectId);
        if (previous?.origin !== profile.origin) {
          this.db.prepare('UPDATE request_url_profiles SET profile_id=NULL WHERE profile_id=?').run(id);
        }
      }
      this.requestSettingsChanged(projectId);
      return { ...profile, id };
    });
  }

  deleteRequestProfile(projectId: number, profileId: number) {
    return this.atomic(() => {
      const profile = this.requestProfile(projectId, profileId);
      this.db.prepare('DELETE FROM request_profiles WHERE id=? AND project_id=?').run(profileId, projectId);
      this.requestSettingsChanged(projectId);
      return profile;
    });
  }

  requestChoice(projectId: number, urlId: number): RequestProfileChoice {
    this.address(projectId, urlId);
    const row = this.get<{ profile_id: number | null }>('SELECT profile_id FROM request_url_profiles WHERE url_id=?', urlId);
    return row ? row.profile_id : 'inherit';
  }

  requestChoiceForUrl(projectId: number, url: string): RequestProfileChoice {
    const row = this.get<{ profile_id: number | null }>(`SELECT p.profile_id FROM urls u JOIN request_url_profiles p ON p.url_id=u.id
      WHERE u.project_id=? AND u.url=? AND u.removed_at IS NULL`, projectId, url);
    return row ? row.profile_id : 'inherit';
  }

  private writeRequestChoice(projectId: number, urlId: number, url: string, choice: RequestProfileChoice) {
    if (typeof choice === 'number' && this.requestProfile(projectId, choice).origin !== new URL(url).origin) {
      throw new ApiError(400, 'Профиль настроен для другого сервера.');
    }
    const operation = choice === 'inherit' ? this.db.prepare('DELETE FROM request_url_profiles WHERE url_id=?').run(urlId)
      : this.db.prepare(`INSERT INTO request_url_profiles(url_id,profile_id) VALUES (?,?)
          ON CONFLICT(url_id) DO UPDATE SET profile_id=excluded.profile_id WHERE profile_id IS NOT excluded.profile_id`)
        .run(urlId, choice);
    if (operation.changes) this.requestSettingsChanged(projectId);
  }

  saveRequestChoice(projectId: number, urlId: number, choice: RequestProfileChoice) {
    return this.atomic(() => {
      const address = this.address(projectId, urlId);
      if (address.removedAt) throw new ApiError(404, 'Адрес удалён.');
      this.writeRequestChoice(projectId, urlId, address.url, choice);
      return { profileId: choice };
    });
  }

  requestSnapshot(runId: number): SavedRequestProfile[] {
    const value = this.get<{ request_snapshot: string | null }>('SELECT request_snapshot FROM runs WHERE id=?', runId)?.request_snapshot;
    return value ? JSON.parse(value) as SavedRequestProfile[] : [];
  }

  activeProjectRequestSecrets(projectId: number) {
    const profiles = this.requestProfiles(projectId);
    const runs = this.all<{ request_snapshot: string }>(`SELECT request_snapshot FROM runs
      WHERE project_id=? AND status IN ('queued','running') AND request_snapshot IS NOT NULL`, projectId);
    for (const run of runs) profiles.push(...JSON.parse(run.request_snapshot) as SavedRequestProfile[]);
    return profiles.flatMap(profileReferences);
  }

  unusedRequestSecrets(refs: readonly string[]) {
    const unused = new Set(refs);
    if (!unused.size) return [];
    const configs = this.db.prepare(`SELECT config AS value FROM request_profiles
      UNION ALL SELECT p.value FROM runs r JOIN json_each(r.request_snapshot) p
        WHERE r.status IN ('queued','running') AND r.request_snapshot IS NOT NULL`).iterate();
    for (const { value } of configs) {
      for (const ref of profileReferences(JSON.parse(String(value)) as ProfileConfig)) unused.delete(ref);
      if (!unused.size) break;
    }
    return [...unused];
  }

  addresses(projectId: number, groupId?: number): Address[] {
    const scope = groupId === undefined ? [] : [groupId, projectId];
    const entries = this.all<Result & {
      addressId: number; addressUrl: string; addressLabel: string; addressVersion: number; removedAt: string | null;
    }>(`
      SELECT u.id AS addressId, u.url AS addressUrl, u.label AS addressLabel, u.version AS addressVersion,
        u.removed_at AS removedAt, ${selectResultFields('r.')}
      ${activeLatest}${scope.length ? ` AND ${groupWhere}` : ''} ORDER BY u.id
    `, projectId, ...scope);
    return entries.map(({ addressId, addressUrl, addressLabel, addressVersion, removedAt, ...latest }) => ({
      id: addressId, url: addressUrl, label: addressLabel, version: addressVersion, removedAt,
      latest: latest.id === null ? null : latest,
    }));
  }

  addressRows(projectId: number): AddressRow[] {
    type Latest = NonNullable<AddressRow['latest']>;
    const entries = this.all<Omit<AddressRow, 'latest'> & Latest>(`
      SELECT u.id, u.url, u.label, u.version, u.removed_at AS removedAt, r.status, r.http_code AS httpCode,
        r.duration_ms AS durationMs, r.checked_at AS checkedAt
      ${activeLatest} ORDER BY u.id
    `, projectId);
    return entries.map(addressRow);
  }

  address(projectId: number, id: number) {
    const entry = this.get<Omit<Address, 'latest'>>(`
      SELECT id, url, label, version, removed_at AS removedAt FROM urls WHERE id = ? AND project_id = ?
    `, id, projectId);
    if (!entry) throw new ApiError(404, 'Адрес не найден.');
    return entry;
  }

  latestAddressResult(urlId: number, version: number) {
    return this.get<Result>(`SELECT ${resultFields} FROM results WHERE url_id=? AND version=? AND checked_at IS NOT NULL
      ORDER BY checked_at DESC, id DESC LIMIT 1`, urlId, version) ?? null;
  }

  versions(urlId: number) {
    return this.all<Version>(`
      SELECT version, url, created_at AS createdAt FROM url_versions WHERE url_id = ? ORDER BY version DESC
    `, urlId);
  }

  addUrls(projectId: number, candidates: { input: string; line: number }[], label = '',
    requireAbsolute = false): ImportResult {
    this.requireProject(projectId);
    return this.atomic(() => {
      const lookup = this.db.prepare('SELECT id,worklist FROM urls WHERE project_id=? AND url=? AND removed_at IS NULL');
      const archived = this.db.prepare(archivedUrl);
      const promote = this.db.prepare('UPDATE urls SET worklist=1,label=? WHERE id=?');
      const retireDuplicate = this.db.prepare('UPDATE urls SET removed_at=? WHERE id=?');
      const restore = this.db.prepare("UPDATE urls SET removed_at=NULL,worklist=1,label=COALESCE(NULLIF(?,''),label) WHERE id=?");
      const insert = this.db.prepare('INSERT INTO urls(project_id, url, label) VALUES (?, ?, ?)');
      const version = this.db.prepare('INSERT INTO url_versions VALUES (?, 1, ?, ?)');
      const now = iso(this.clock());
      const issues: ImportIssue[] = [];
      let added = 0, duplicates = 0, invalid = 0;
      function issue(line: number, input: string, kind: ImportIssue['kind'], message: string) {
        if (issues.length < BATCH_LIMIT) issues.push({ line, input: input.slice(0, 200), kind, message });
      }
      for (const { input, line } of candidates) {
        let url: string;
        try {
          if (requireAbsolute && !/^https?:\/\//i.test(input)) throw new Error('Ожидается полный HTTP(S) URL.');
          url = normalizeUrl(input);
        } catch (error) {
          invalid++;
          issue(line, input, 'invalid', (error as Error).message);
          continue;
        }
        const existing = lookup.get(projectId, url) as { id: number; worklist: number } | undefined;
        if (existing?.worklist) {
          duplicates++;
          issue(line, input, 'duplicate', 'Этот адрес уже добавлен.');
        } else {
          const prior = archived.get(projectId, url) as PickedUrl | undefined;
          if (prior) {
            if (existing) retireDuplicate.run(now, existing.id);
            restore.run(label, prior.id);
          } else if (existing) promote.run(label, existing.id);
          else version.run(insert.run(projectId, url, label).lastInsertRowid, url, now);
          added++;
        }
      }
      if (added) this.updateWorklist(projectId, added);
      return { added, duplicates, invalid, skipped: 0, issues };
    });
  }

  editUrl(projectId: number, id: number, input: string, label: string, choice?: RequestProfileChoice) {
    let url: string;
    try { url = normalizeUrl(input); }
    catch (error) { throw new ApiError(400, (error as Error).message); }
    return this.atomic(() => {
      const current = this.address(projectId, id);
      if (current.removedAt) throw new ApiError(404, 'Адрес удалён.');
      if (this.get('SELECT id FROM urls WHERE project_id = ? AND url = ? AND id != ? AND removed_at IS NULL',
        projectId, url, id)) throw new ApiError(409, 'Этот адрес уже есть в проекте.');
      const version = current.version + Number(current.url !== url);
      this.db.prepare('UPDATE urls SET url = ?, label = ?, version = ? WHERE id = ?').run(url, label, version, id);
      if (choice !== undefined) this.writeRequestChoice(projectId, id, url, choice);
      else if (version !== current.version && new URL(current.url).origin !== new URL(url).origin) {
        const cleared = this.db.prepare('UPDATE request_url_profiles SET profile_id=NULL WHERE url_id=? AND profile_id IS NOT NULL').run(id);
        if (cleared.changes) this.requestSettingsChanged(projectId);
      }
      if (current.url !== url || current.label !== label) {
        this.db.prepare(`UPDATE projects SET worklist_revision=worklist_revision+1 WHERE id=?
          AND EXISTS(SELECT 1 FROM urls WHERE id=? AND worklist=1)`).run(projectId, id);
      }
      if (version !== current.version) {
        this.db.prepare('INSERT INTO url_versions VALUES (?, ?, ?, ?)').run(id, version, url, iso(this.clock()));
      }
      return this.address(projectId, id);
    });
  }

  private pick(projectId: number, ids: number[]) {
    const find = this.db.prepare(`SELECT u.id,u.url,u.label,u.version FROM urls u WHERE ${workingWhere} AND u.id=?`);
    return [...new Set(ids)].map(id => {
      const address = find.get(projectId, id) as PickedUrl | undefined;
      if (!address) throw new ApiError(409, 'Часть выбранных адресов больше не доступна в этом проекте.');
      return address;
    });
  }

  private groupRows(projectId: number, groupId?: number) {
    const selection = groupId === undefined ? [] : [groupId];
    return this.all<WorkGroup>(`SELECT g.id,g.name,(SELECT COUNT(*) FROM work_group_urls m
        JOIN urls u ON u.id=m.url_id WHERE m.group_id=g.id AND u.project_id=g.project_id
          AND u.worklist=1 AND u.removed_at IS NULL) AS count
      FROM work_groups g WHERE g.project_id=? AND g.deleted_at IS NULL ${selection.length ? 'AND g.id=?' : ''}
      ORDER BY g.name_key,g.id`, projectId, ...selection);
  }

  groups(projectId: number) { return this.groupRows(projectId); }

  private requireGroup(projectId: number, groupId: number) {
    const group = this.get<Pick<WorkGroup, 'id' | 'name'>>(
      'SELECT id,name FROM work_groups WHERE id=? AND project_id=? AND deleted_at IS NULL', groupId, projectId,
    );
    if (!group) throw new ApiError(404, 'Рабочая группа не найдена.');
    return group;
  }

  saveGroup(projectId: number, name: string, groupId?: number) {
    return this.atomic(() => {
      const key = name.normalize('NFC').toLocaleLowerCase('ru');
      if (groupId !== undefined) this.requireGroup(projectId, groupId);
      if (this.get(`SELECT id FROM work_groups WHERE project_id=? AND name_key=? AND deleted_at IS NULL
        AND id IS NOT ?`, projectId, key, groupId ?? null)) throw new ApiError(409, 'Группа с таким названием уже существует.');
      if (groupId === undefined) {
        const result = this.db.prepare('INSERT INTO work_groups(project_id,name,name_key) VALUES (?,?,?)').run(projectId, name, key);
        this.invalidateView(projectId);
        return { id: Number(result.lastInsertRowid), name, count: 0 };
      }
      this.db.prepare('UPDATE work_groups SET name=?,name_key=? WHERE id=?').run(name, key, groupId);
      this.invalidateView(projectId);
      return this.groupRows(projectId, groupId)[0];
    });
  }

  changeGroupMembers(projectId: number, groupId: number, operation: 'add' | 'remove', ids: number[]) {
    return this.atomic(() => {
      this.requireGroup(projectId, groupId);
      const selected = JSON.stringify(this.pick(projectId, ids).map(address => address.id));
      const change = operation === 'add'
        ? 'INSERT OR IGNORE INTO work_group_urls(group_id,url_id) SELECT ?,value FROM json_each(?)'
        : 'DELETE FROM work_group_urls WHERE group_id=? AND url_id IN (SELECT value FROM json_each(?))';
      const changed = Number(this.db.prepare(change).run(groupId, selected).changes);
      if (changed) this.invalidateView(projectId);
      return { changed };
    });
  }

  deleteGroup(projectId: number, groupId: number) {
    return this.atomic(() => {
      this.requireGroup(projectId, groupId);
      this.db.prepare('DELETE FROM work_group_urls WHERE group_id=?').run(groupId);
      this.db.prepare(`UPDATE work_groups SET deleted_at=? WHERE id=?`).run(iso(this.clock()), groupId);
      this.invalidateView(projectId);
      return { deleted: true };
    });
  }

  previewDeletion(projectId: number, ids: number[], filters: AddressFilters) {
    const addresses = this.worklist.selectionPreview(projectId, filters, ids);
    if (addresses.length !== new Set(ids).size) throw new ApiError(409, 'Часть выбранных адресов больше не доступна в этом проекте.');
    return addresses;
  }

  deleteUrls(projectId: number, ids: number[], versions?: number[]) {
    return this.atomic(() => {
      const selected = this.pick(projectId, ids);
      if (versions && (selected.length !== versions.length || selected.some((address, index) => address.version !== versions[index]))) {
        throw new ApiError(409, 'Один из адресов изменился. Откройте подтверждение ещё раз.');
      }
      const update = this.db.prepare('UPDATE urls SET removed_at = ? WHERE id = ?');
      for (const { id } of selected) update.run(iso(this.clock()), id);
      if (selected.length) this.updateWorklist(projectId, -selected.length);
      return { deleted: selected.length };
    });
  }

  private updateWorklist(projectId: number, delta: number) {
    this.db.prepare('UPDATE projects SET url_count=url_count+?, worklist_revision=worklist_revision+1 WHERE id=?')
      .run(delta, projectId);
  }

  private deletionScope(projectId: number): DeleteAllPreview {
    const project = this.get<{ name: string; url_count: number; worklist_revision: number }>(
      'SELECT name,url_count,worklist_revision FROM projects WHERE id=?', projectId);
    if (!project) throw new ApiError(404, 'Проект не найден.');
    const runs = this.all<{ id: number; status: 'running' | 'queued' }>(
      "SELECT id,status FROM runs WHERE project_id=? AND status IN ('queued','running') ORDER BY id", projectId);
    const transfer = this.get<{ id: number; state: string; created_at: string }>(
      'SELECT id,state,created_at FROM catalog_transfers WHERE project_id=? ORDER BY id DESC LIMIT 1', projectId);
    const running = runs.filter(run => run.status === 'running').length;
    return { projectName: project.name, addresses: project.url_count, running, queued: runs.length - running,
      transferActive: transfer?.state === 'queued' || transfer?.state === 'running',
      confirmation: scopeConfirmation([projectId, project, runs, transfer]) };
  }

  previewDeleteAll(projectId: number): DeleteAllPreview {
    this.db.exec('BEGIN');
    try { return this.deletionScope(projectId); } finally { this.db.exec('ROLLBACK'); }
  }

  deleteAllUrls(projectId: number, confirmation: string) {
    return this.atomic(() => {
      const scope = this.deletionScope(projectId);
      const changedMessage = 'Список адресов или проверок изменился. Проверьте обновлённый предпросмотр.';
      if (!scope.addresses || scope.confirmation !== confirmation) throw new ApiError(409, changedMessage);
      if (scope.transferActive) throw new ApiError(409, 'Дождитесь завершения переноса из каталога или остановите его.');
      const removedAt = iso(this.clock());
      const deleted = Number(this.db.prepare(`UPDATE urls AS u SET removed_at=? WHERE ${workingWhere}`).run(removedAt, projectId).changes);
      if (deleted !== scope.addresses) throw new ApiError(409, changedMessage);
      this.updateWorklist(projectId, -deleted);
      const running = this.all<{ id: number }>("SELECT id FROM runs WHERE project_id=? AND status='running'", projectId);
      const stopped = this.cancelActiveRuns(projectId, removedAt);
      return { deleted, stopped, runningIds: running.map(run => run.id) };
    });
  }

  restoreUrl(projectId: number, addressId: number) {
    return this.atomic(() => {
      const address = this.address(projectId, addressId);
      if (!address.removedAt) return address;
      const duplicate = this.get<{ id: number; worklist: number }>(
        'SELECT id,worklist FROM urls WHERE project_id=? AND url=? AND removed_at IS NULL', projectId, address.url,
      );
      if (duplicate?.worklist) {
        throw new ApiError(409, 'Этот URL уже есть в проекте.');
      }
      if (duplicate) this.db.prepare('UPDATE urls SET removed_at=? WHERE id=?').run(iso(this.clock()), duplicate.id);
      this.db.prepare('UPDATE urls SET removed_at=NULL, worklist=1 WHERE id=?').run(addressId);
      this.updateWorklist(projectId, 1);
      return { ...address, removedAt: null };
    });
  }

  private queuedDuplicate(projectId: number, profile: TlsProfile, total: number, addresses?: PickedUrl[], groupId?: number) {
    // Snapshots have one row per URL. Equal counts and a matching version for each row make the sets equal.
    const mismatched = addresses
      ? `SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (
          SELECT 1 FROM results rs WHERE rs.run_id=q.id
            AND rs.url_id=selected.value->>0 AND rs.version=selected.value->>1
        )`
      : `SELECT 1 FROM results rs LEFT JOIN urls u ON u.id=rs.url_id AND u.version=rs.version
            AND ${workingWhere}${groupId === undefined ? '' : ` AND ${groupWhere}`} WHERE rs.run_id=q.id AND u.id IS NULL`;
    const selection = addresses ? [JSON.stringify(addresses.map(entry => [entry.id, entry.version]))]
      : groupId === undefined ? [projectId] : [projectId, groupId, projectId];
    return this.get<{ id: number }>(`
      SELECT q.id FROM runs q LEFT JOIN work_group_runs g ON g.run_id=q.id
      WHERE q.project_id=? AND q.source='manual' AND q.status='queued'
        AND q.tls_profile=? AND q.total=? AND g.group_id IS ?
        AND q.request_revision=(SELECT request_revision FROM projects WHERE id=q.project_id)
        AND NOT EXISTS (${mismatched}) ORDER BY q.id LIMIT 1
    `, projectId, profile, total, groupId ?? null, ...selection);
  }

  private createRun(projectId: number, source: Run['source'], profile: TlsProfile, group?: Run['group']) {
    const id = this.nextId('run');
    const saved = this.requestProfiles(projectId);
    this.db.prepare(`INSERT INTO runs(id,project_id,source,created_at,tls_profile,request_revision,request_snapshot,pac_revision)
      VALUES (?,?,?,?,?,(SELECT request_revision FROM projects WHERE id=?),?,
        (SELECT revision FROM project_pac_versions WHERE project_id=? AND active=1))`)
      .run(id, projectId, source, iso(this.clock()), profile, projectId, saved.length ? JSON.stringify(saved) : null, projectId);
    if (group) this.db.prepare('INSERT INTO work_group_runs(run_id,group_id,group_name) VALUES (?,?,?)').run(id, group.id, group.name);
    return id;
  }

  private snapshotRequestChoices(runId: number, projectId: number) {
    if (!this.get(`SELECT 1 FROM request_url_profiles p CROSS JOIN urls u ON u.id=p.url_id WHERE u.project_id=? LIMIT 1`, projectId)) return;
    this.db.prepare(`UPDATE results AS r SET request_profile_override=COALESCE(p.profile_id,0)
      FROM request_url_profiles p WHERE r.run_id=? AND r.url_id=p.url_id`).run(runId);
  }

  private insertRun(projectId: number, source: Run['source'], addresses?: PickedUrl[], group?: Run['group']) {
    const project = this.get<{ tls_profile: TlsProfile; url_count: number }>(
      'SELECT tls_profile,url_count FROM projects WHERE id=?', projectId,
    );
    if (!project) throw new ApiError(404, 'Проект не найден.');
    const profile = project.tls_profile;
    const where = workingWhere + (group ? ` AND ${groupWhere}` : '');
    const scope = group ? [projectId, group.id, projectId] : [projectId];
    const totalNow = group ? this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM urls u WHERE ${where}`, ...scope)!.count
      : addresses?.length ?? project.url_count;
    if (source === 'manual' && totalNow) {
      const existing = this.queuedDuplicate(projectId, profile, totalNow, addresses, group?.id);
      if (existing) return existing;
    }
    const id = this.createRun(projectId, source, profile, group);
    let total: number;
    if (addresses) {
      const insert = this.db.prepare('INSERT INTO results(run_id, url_id, version, url, label) VALUES (?, ?, ?, ?, ?)');
      for (const entry of addresses) insert.run(id, entry.id, entry.version, entry.url, entry.label);
      total = addresses.length;
    } else {
      total = Number(this.db.prepare(`INSERT INTO results(run_id,url_id,version,url,label)
        SELECT ?,u.id,u.version,u.url,u.label FROM urls u WHERE ${where} ORDER BY u.id`).run(id, ...scope).changes);
    }
    if (!total) throw new ApiError(400, group ? 'В группе пока нет адресов.' : 'Добавьте хотя бы один адрес.');
    this.snapshotRequestChoices(id, projectId);
    this.db.prepare('UPDATE runs SET total=? WHERE id=?').run(total, id);
    return { id };
  }

  enqueue(projectId: number, ids?: number[]) {
    return this.atomic(() => {
      if (!ids && this.transferActive(projectId)) throw new ApiError(409, 'Дождитесь завершения переноса адресов.');
      return this.insertRun(projectId, 'manual', ids ? this.pick(projectId, ids) : undefined);
    });
  }

  enqueueGroup(projectId: number, groupId: number) {
    return this.atomic(() => this.insertRun(projectId, 'manual', undefined, this.requireGroup(projectId, groupId)));
  }

  restartRun(projectId: number, runId: number) {
    return this.atomic(() => {
      const run = this.run(runId, projectId);
      if (run.status !== 'cancelled') throw new ApiError(409, 'Перезапустить можно остановленную проверку.');
      const profile = this.project(projectId).tlsProfile;
      const count = this.get<{ total: number }>(`SELECT COUNT(*) AS total FROM (${stoppedTargets})`, runId, runId)!.total;
      if (!count || count !== run.total) throw new ApiError(409, 'Исходный список адресов этой проверки недоступен.');
      const existing = this.get<{ id: number }>(`
        WITH targets AS (${stoppedTargets})
        SELECT q.id FROM runs q LEFT JOIN work_group_runs g ON g.run_id=q.id
        WHERE q.project_id=? AND q.source='manual' AND q.status='queued'
          AND q.completed=0 AND q.tls_profile=? AND q.total=? AND g.group_id IS ? AND g.group_name IS ?
          AND q.request_revision=(SELECT request_revision FROM projects WHERE id=q.project_id) AND NOT EXISTS (
            SELECT 1 FROM targets t WHERE NOT EXISTS (
              SELECT 1 FROM results r WHERE r.run_id=q.id AND r.url_id=t.url_id AND r.version=t.version AND r.label=t.label
            )
          ) ORDER BY q.id LIMIT 1
      `, runId, runId, projectId, profile, count, run.group?.id ?? null, run.group?.name ?? null);
      if (existing) return existing;
      const id = this.createRun(projectId, 'manual', profile, run.group);
      this.db.prepare(`INSERT INTO results(run_id,url_id,version,url,label)
        SELECT ?,url_id,version,url,label FROM (${stoppedTargets}) ORDER BY position`).run(id, runId, runId);
      this.snapshotRequestChoices(id, projectId);
      this.db.prepare('UPDATE runs SET total=? WHERE id=?').run(count, id);
      return { id };
    });
  }

  enqueueCatalog(projectId: number, urls: string[]) {
    if (!urls.length || urls.length > PROJECT_URL_LIMIT) throw new ApiError(400, 'Выберите от 1 до 5 000 адресов.');
    return this.atomic(() => {
      const find = this.db.prepare('SELECT id,url,label,version,worklist FROM urls WHERE project_id=? AND url=? AND removed_at IS NULL');
      const archived = this.db.prepare(archivedUrl);
      const insert = this.db.prepare("INSERT INTO urls(project_id,url,label,worklist) VALUES (?,?,'',0) RETURNING id,url,label,version");
      const version = this.db.prepare('INSERT INTO url_versions VALUES (?, 1, ?, ?)');
      const now = iso(this.clock());
      const addresses = [...new Set(urls)].map(url => {
        const current = find.get(projectId, url) as (PickedUrl & { worklist: number }) | undefined;
        if (current?.worklist) return current;
        const existing = (archived.get(projectId, url) as PickedUrl | undefined) ?? current;
        if (existing) return existing;
        const entry = insert.get(projectId, url) as PickedUrl;
        version.run(entry.id, url, now);
        return entry;
      });
      return this.insertRun(projectId, 'manual', addresses);
    });
  }

  private dueWhere = `p.next_at<=? AND NOT EXISTS (
    SELECT 1 FROM catalog_transfers t WHERE t.project_id=p.id AND t.state IN ('queued','running')
  )`;

  hasDue() {
    return Boolean(this.get(`SELECT id FROM projects p WHERE ${this.dueWhere} LIMIT 1`, this.clock()));
  }

  enqueueDue() {
    const now = this.clock();
    if (!this.hasDue()) return;
    this.atomic(() => {
      const due = this.all<{ id: number; schedule: string }>(`SELECT id,schedule FROM projects p WHERE ${this.dueWhere}`, now);
      const update = this.db.prepare('UPDATE projects SET next_at = ? WHERE id = ?');
      for (const project of due) {
        update.run(nextOccurrence(JSON.parse(project.schedule), now), project.id);
        if (this.get("SELECT id FROM runs WHERE project_id = ? AND source = 'schedule' AND status = 'queued'", project.id)) continue;
        if (this.get(`SELECT u.id FROM urls u WHERE ${workingWhere} LIMIT 1`, project.id)) this.insertRun(project.id, 'schedule');
      }
    });
  }

  hasQueued(schedulesEnabled = true) {
    return Boolean(this.get("SELECT id FROM runs WHERE status='queued' AND (? OR source='manual') LIMIT 1", Number(schedulesEnabled)));
  }

  claim(schedulesEnabled = true) {
    if (!this.hasQueued(schedulesEnabled)) return undefined;
    return this.atomic(() => {
      const run = this.get<{ id: number; source: Run['source']; tlsProfile: TlsProfile; checkConcurrency: number }>(`
        SELECT r.id,r.source,r.tls_profile AS tlsProfile,p.check_concurrency AS checkConcurrency
        FROM runs r JOIN projects p ON p.id=r.project_id
        WHERE r.status = 'queued' AND (? OR r.source = 'manual') AND NOT EXISTS (
          SELECT 1 FROM runs other WHERE other.project_id = r.project_id AND other.status = 'running'
        ) ORDER BY r.id LIMIT 1
      `, Number(schedulesEnabled));
      if (!run) return undefined;
      this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
      return { ...run, items: this.pendingResults(run.id) };
    });
  }

  pendingResults(runId: number) {
    return this.all<{ id: number; url: string; profileChoice: number | null }>(`
      SELECT id,url,request_profile_override AS profileChoice FROM results WHERE run_id=? AND status='pending' ORDER BY id LIMIT 256
    `, runId);
  }

  saveResult(id: number, result: CheckResult, expectedRunId?: number) {
    this.atomic(() => {
      const row = this.get<{ run_id: number }>(`
        UPDATE results SET status = ?, http_code = ?, duration_ms = ?, final_url = ?, redirects = ?,
          content_type = ?, content_length = ?, error_kind = ?, tls_code = ?, access_hint = ?, error = ?, checked_at = ?,
          request_profile = ?, request_route = ?, failure_stage = ?, proxy_http_code = ?, request_proxy = ?, request_source = ?
        WHERE id = ? AND status = 'pending' AND run_id = COALESCE(?, run_id) RETURNING run_id
      `, result.status, result.httpCode, result.durationMs, result.finalUrl, result.redirects,
      result.contentType, result.contentLength, result.errorKind, result.tlsCode ?? null, result.accessHint ?? null, result.error,
      iso(this.clock()), result.requestProfile ?? null, result.requestRoute ?? null, result.failureStage ?? null,
      result.proxyHttpCode ?? null, result.requestProxy ?? null, result.requestSource ?? null, id, expectedRunId ?? null);
      if (row) this.db.prepare('UPDATE runs SET completed=completed+1,available=available+?,failures=failures+? WHERE id=?')
        .run(Number(result.status === 'ok'), Number(result.status === 'error'), row.run_id);
    });
  }

  requeue(runId: number) {
    this.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'running'").run(runId);
  }

  private restartInfo(run?: Run): RunRestart | null {
    if (run?.status !== 'cancelled') return null;
    const { id, total, completed } = run;
    const canRestart = total > 0 && (completed === total || !!this.get('SELECT 1 FROM stopped_run_targets WHERE run_id=? LIMIT 1', id));
    return { id, total, completed, canRestart };
  }

  private cancelActiveRuns(projectId: number, finishedAt: string, runId?: number) {
    const scope = `SELECT id FROM runs WHERE project_id=? AND status IN ('queued','running')${runId === undefined ? '' : ' AND id=?'}`;
    const args = runId === undefined ? [projectId] : [projectId, runId];
    const pending = `run_id IN (${scope}) AND status='pending'`;
    this.db.prepare(`INSERT INTO stopped_run_targets(run_id,position,url_id,version,url,label)
      SELECT run_id,id,url_id,version,url,label FROM results WHERE ${pending}`).run(...args);
    this.db.prepare(`DELETE FROM results WHERE ${pending}`).run(...args);
    return Number(this.db.prepare(`UPDATE runs SET status='cancelled', finished_at=? WHERE id IN (${scope})`).run(finishedAt, ...args).changes);
  }

  stopRun(projectId: number, runId: number): StoppedRunResponse {
    return this.atomic(() => {
      const run = this.run(runId, projectId);
      if (!isActiveRun(run)) return { ...run, restart: this.restartInfo(run) };
      const finishedAt = iso(this.clock());
      this.cancelActiveRuns(projectId, finishedAt, runId);
      const stopped = { ...run, status: 'cancelled' as const, finishedAt };
      return { ...stopped, restart: this.restartInfo(stopped) };
    });
  }

  finish(runId: number, emailEnabled = true) {
    this.atomic(() => {
      const run = this.get<Run>(`SELECT ${runFields} FROM runs r WHERE r.id=?`, runId);
      if (!run || run.status !== 'running' || run.completed !== run.total) return;
      const now = this.clock();
      this.db.prepare("UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?").run(iso(now), runId);
      const project = this.project(run.projectId);
      if (project.notify === 'off' || (project.notify === 'errors' && !run.failures)) return;
      const email = emailEnabled ? project.email : null;
      this.db.prepare(`
        INSERT INTO notifications(project_id, run_id, total, available, failures, email, created_at, delivery, retry_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.projectId, run.id, run.total, run.available, run.failures, email, iso(now),
        email ? 'pending' : 'disabled', email ? now : null);
    });
  }

  runs(projectId: number, before?: number, limit = PAGE_SIZE, groupId?: number) {
    const params = [projectId];
    if (before !== undefined) params.push(before);
    if (groupId !== undefined) params.push(groupId);
    return this.all<RunRow>(`
      SELECT ${groupedRunFields}
      FROM runs r ${runGroupJoin}
      WHERE r.project_id = ? ${before === undefined ? '' : 'AND r.id < ?'} ${groupId === undefined ? '' : 'AND g.group_id=?'}
      ORDER BY r.id DESC LIMIT ?
    `, ...params, limit).map(mapRun);
  }

  runPage(projectId: number, before?: number, groupId?: number): RunPage {
    if (groupId !== undefined) this.requireGroup(projectId, groupId);
    const rows = this.runs(projectId, before, RUN_PAGE_SIZE + 1, groupId);
    const hasMore = rows.length > RUN_PAGE_SIZE;
    if (hasMore) rows.pop();
    return { items: rows, nextBefore: hasMore ? rows.at(-1)!.id : null };
  }

  comparisonOptions(projectId: number, before?: number): RunPage {
    this.requireProject(projectId);
    const cursor = before === undefined ? [] : [before];
    const rows = this.all<RunRow>(`SELECT ${groupedRunFields} FROM runs r ${runGroupJoin}
      WHERE r.project_id=? AND ${eligibleComparisonRun} ${cursor.length ? 'AND r.id<?' : ''}
      ORDER BY r.id DESC LIMIT ?`, projectId, ...cursor, RUN_PAGE_SIZE + 1);
    const hasMore = rows.length > RUN_PAGE_SIZE;
    if (hasMore) rows.pop();
    return { items: rows.map(mapRun), nextBefore: hasMore ? rows.at(-1)!.id : null };
  }

  queuedRuns(projectId: number) {
    return this.all<RunRow>(`SELECT ${groupedRunFields} FROM runs r ${runGroupJoin} WHERE r.project_id=? AND r.status='queued' ORDER BY r.id`, projectId).map(mapRun);
  }

  activeRun(projectId: number) {
    const run = this.get<{ id: number }>(`
      SELECT id FROM runs WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY status='running' DESC,id LIMIT 1
    `, projectId);
    return run ? this.run(run.id, projectId) : null;
  }

  run(id: number, projectId: number) {
    const run = this.get<RunRow>(`
      SELECT ${groupedRunFields} FROM runs r ${runGroupJoin}
      WHERE r.id = ? AND r.project_id = ?
    `, id, projectId);
    if (!run) throw new ApiError(404, 'Запуск не найден.');
    return mapRun(run);
  }

  deleteRun(projectId: number, runId: number) {
    return this.atomic(() => {
      const run = this.run(runId, projectId);
      if (isActiveRun(run)) {
        throw new ApiError(409, 'Завершите или остановите проверку перед удалением отчёта.');
      }
      if (this.get("SELECT id FROM notifications WHERE run_id = ? AND delivery = 'sending'", runId)) {
        throw new ApiError(409, 'Дождитесь окончания отправки письма и повторите удаление.');
      }
      this.db.prepare('DELETE FROM notifications WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM results WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      this.discardUnusedPac(projectId);
      return { deleted: true };
    });
  }

  runResults(runId: number, after = 0) {
    return this.all<Result>(`
      SELECT ${resultFields} FROM results WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?
    `, runId, after, PAGE_SIZE);
  }

  history(urlId: number, before?: number, beforeAt?: string) {
    let earlier = '';
    const parameters: SQLInputValue[] = [urlId];
    if (before !== undefined) {
      const checkedAt = beforeAt ?? this.get<{ checked_at: string }>(
        'SELECT checked_at FROM results WHERE url_id=? AND id=? AND checked_at IS NOT NULL', urlId, before)?.checked_at;
      earlier = checkedAt ? 'AND (checked_at,id)<(?,?)' : 'AND id<?';
      if (checkedAt) parameters.push(checkedAt);
      parameters.push(before);
    }
    return this.all<Result>(`
      SELECT ${resultFields} FROM results WHERE url_id = ? AND checked_at IS NOT NULL
        ${earlier} ORDER BY checked_at DESC, id DESC LIMIT ?
    `, ...parameters, PAGE_SIZE);
  }

  private previousRun(run: Run) {
    const cutoff = run.finishedAt ?? iso(this.clock());
    return this.get<NonNullable<RunView['previousRun']>>(
      `SELECT id,created_at AS createdAt FROM runs WHERE project_id=? AND status='done' AND completed>0 AND id<>?
        AND (finished_at,id)<(?,?) ORDER BY finished_at DESC,id DESC LIMIT 1`,
      run.projectId, run.id, cutoff, run.id) ?? null;
  }

  report(projectId: number, runId: number, filters: ReportFilters, after = 0): RunView {
    this.db.exec('BEGIN');
    try {
      const run = this.run(runId, projectId);
      const previousRun = this.previousRun(run);
      const selection = resultFilters(filters);
      const conditions = ['r.run_id=?', 'r.id>?', ...selection.conditions];
      const results = this.all<ReportResult>(`
        SELECT ${selectResultFields('r.')},${comparisonFields}
        FROM results r ${comparisonJoin}
        WHERE ${conditions.join(' AND ')} ORDER BY r.id LIMIT ?
      `, runId, after, ...selection.parameters, PAGE_SIZE + 1);
      const hasMore = results.length > PAGE_SIZE;
      if (hasMore) results.pop();
      return { run, results, previousRun, nextAfter: hasMore ? results.at(-1)!.id : null, restart: this.restartInfo(run) };
    } finally { this.db.exec('ROLLBACK'); }
  }

  comparisonPair(projectId: number, pair: ComparisonPair) {
    if (![pair.baseline, pair.target].every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new ApiError(400, 'Укажите два запуска для сравнения.');
    }
    if (pair.baseline === pair.target) throw new ApiError(400, 'Выберите разные запуски.');
    const baseline = this.run(pair.baseline, projectId);
    const target = this.run(pair.target, projectId);
    if (!canCompareRun(baseline) || !canCompareRun(target)) {
      throw new ApiError(409, 'Выберите завершённые или остановленные запуски с результатами.');
    }
    return { baseline, target };
  }

  private comparison(projectId: number, pair: ComparisonPair) {
    const { baseline, target } = this.comparisonPair(projectId, pair);
    return comparisonCoverage(this.db, baseline, target);
  }

  comparisonSummary(projectId: number, pair: ComparisonPair): ComparisonSummary {
    this.db.exec('BEGIN');
    try {
      const coverage = this.comparison(projectId, pair);
      return { baseline: coverage.baseline, target: coverage.target, ...comparisonTotals(this.db, coverage) };
    } finally { this.db.exec('ROLLBACK'); }
  }

  comparisonPage(projectId: number, input: ComparisonInput, after = 0): ComparisonPage {
    this.db.exec('BEGIN');
    try {
      const items = comparisonRows(this.db, this.comparison(projectId, input), input, after, PAGE_SIZE + 1);
      const hasMore = items.length > PAGE_SIZE;
      if (hasMore) items.pop();
      return { items, nextAfter: hasMore ? items.at(-1)!.urlId : null };
    } finally { this.db.exec('ROLLBACK'); }
  }

  private exportSelection(projectId: number, scope: ExportScope, filters: ReportFilters): ExportSelection {
    if (scope.urlId !== undefined) this.address(projectId, scope.urlId);
    if (scope.runId !== undefined) this.run(scope.runId, projectId);
    if (scope.groupId !== undefined) this.requireGroup(projectId, scope.groupId);
    if (filters.change && scope.runId === undefined) throw new ApiError(400, 'Сравнение доступно в экспорте запуска.');
    return { projectId, scope, filters, until: iso(this.clock()) };
  }

  private exportBatch({ projectId, scope, filters, until }: ExportSelection, before: number) {
    const constraints = ['r.run_id IN (SELECT id FROM runs WHERE project_id=?)', 'r.checked_at<=?'];
    const parameters: SQLInputValue[] = [projectId, until];
    if (scope.urlId !== undefined) { constraints.push('r.url_id=?'); parameters.push(scope.urlId); }
    if (scope.runId !== undefined) { constraints.push('r.run_id=?'); parameters.push(scope.runId); }
    if (scope.groupId !== undefined) {
      constraints.push('r.run_id IN (SELECT run_id FROM work_group_runs WHERE group_id=?)');
      parameters.push(scope.groupId);
    }
    if (scope.urlId === undefined) {
      constraints.push('r.id<?');
      parameters.push(before);
    } else if (before < Number.MAX_SAFE_INTEGER) {
      constraints.push('(r.checked_at,r.id)<(SELECT checked_at,id FROM results WHERE id=?)');
      parameters.push(before);
    }
    const comparable = scope.runId !== undefined;
    const selection = resultFilters(filters);
    constraints.push(...selection.conditions);
    return this.all<Result & Partial<ReportResult>>(`
      SELECT ${selectResultFields('r.')}${comparable ? ',' + comparisonFields : ''}
      FROM results r ${comparable ? comparisonJoin : ''}
      WHERE ${constraints.join(' AND ')} ORDER BY ${scope.urlId === undefined ? '' : 'r.checked_at DESC,'}r.id DESC LIMIT 500
    `, ...parameters, ...selection.parameters);
  }

  private async openExportSnapshot<T>(projectId: number, open: (snapshot: ExportSnapshot) => T) {
    let temporary: string | undefined;
    let reader: Store | undefined;
    try {
      let file = this.file;
      if (file === ':memory:' || !file) {
        temporary = mkdtempSync(join(tmpdir(), 'pulse-report-'));
        file = join(temporary, 'snapshot.sqlite3');
        await backup(this.db, file);
      }
      reader = new Store(file, this.clock, false, false, true);
      reader.db.exec('BEGIN');
      // This first read pins the same revision for the base report and every batch.
      reader.requireProject(projectId);
      return open({ reader, temporary });
    } catch (error) {
      try { reader?.close(); }
      finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
      throw error;
    }
  }

  async beginExport(projectId: number, scope: ExportScope, filters: ReportFilters) {
    return this.openExportSnapshot(projectId, snapshot => {
      const selection = snapshot.reader.exportSelection(projectId, scope, filters);
      const id = randomUUID();
      this.exports.set(id, { ...snapshot, selection });
      return id;
    });
  }

  async beginComparisonExport(projectId: number, input: ComparisonInput) {
    return this.openExportSnapshot(projectId, snapshot => {
      const coverage = snapshot.reader.comparison(projectId, input);
      const id = randomUUID();
      this.comparisonExports.set(id, { ...snapshot, coverage, filters: { kind: input.kind, q: input.q } });
      return { id, baseline: coverage.baseline, target: coverage.target };
    });
  }

  readExport(id: string, before: number) {
    const session = this.exports.get(id);
    if (!session) throw new Error('Снимок отчёта закрыт. Повторите выгрузку.');
    return session.reader.exportBatch(session.selection, before);
  }

  endExport(id: string) {
    const session = this.exports.get(id);
    if (!session) return;
    this.exports.delete(id);
    this.closeExportSnapshot(session);
  }

  readComparisonExport(id: string, after: number) {
    const session = this.comparisonExports.get(id);
    if (!session) throw new Error('Снимок сравнения закрыт. Повторите выгрузку.');
    return comparisonRows(session.reader.db, session.coverage, session.filters, after, 500);
  }

  endComparisonExport(id: string) {
    const session = this.comparisonExports.get(id);
    if (!session) return;
    this.comparisonExports.delete(id);
    this.closeExportSnapshot(session);
  }

  private closeExportSnapshot(snapshot: ExportSnapshot) {
    try { snapshot.reader.close(); }
    finally { if (snapshot.temporary) rmSync(snapshot.temporary, { recursive: true, force: true }); }
  }

  notifications(before?: number, limit = PAGE_SIZE) {
    const bounds = before === undefined ? [] : [before];
    return this.all<Notification>(`
      SELECT ${notificationFields} FROM notifications n JOIN projects p ON p.id = n.project_id
      WHERE n.cleared_at IS NULL ${before === undefined ? '' : 'AND n.id < ?'} ORDER BY n.id DESC LIMIT ?
    `, ...bounds, limit);
  }

  notificationPage(before?: number): NotificationPage {
    const items = this.notifications(before, PAGE_SIZE + 1);
    const hasMore = items.length > PAGE_SIZE;
    if (hasMore) items.pop();
    return { items, nextBefore: hasMore ? items.at(-1)!.id : null };
  }

  unread() {
    return this.get<{ count: number }>('SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL AND cleared_at IS NULL')!.count;
  }

  markRead(notificationId?: number) {
    const scope = notificationId === undefined ? '' : ' AND id=?';
    const params = notificationId === undefined ? [] : [notificationId];
    this.db.prepare(`UPDATE notifications SET read_at=? WHERE read_at IS NULL AND cleared_at IS NULL${scope}`).run(iso(this.clock()), ...params);
  }

  clearNotifications() {
    const result = this.db.prepare('UPDATE notifications SET cleared_at = ? WHERE cleared_at IS NULL').run(iso(this.clock()));
    return { cleared: Number(result.changes) };
  }

  hasPendingEmail() {
    return Boolean(this.get("SELECT id FROM notifications WHERE delivery='pending' AND retry_at<=? LIMIT 1", this.clock()));
  }

  claimEmail() {
    if (!this.hasPendingEmail()) return undefined;
    return this.atomic(() => {
      const job = this.get<Omit<EmailJob, 'messageId'> & { messageId: string | null }>(`
        SELECT ${notificationFields}, n.email, n.email_message_id AS messageId
        FROM notifications n JOIN projects p ON p.id = n.project_id
        WHERE n.delivery = 'pending' AND n.retry_at <= ? ORDER BY n.retry_at, n.id LIMIT 1
      `, this.clock());
      if (!job) return undefined;
      const messageId = job.messageId ?? `<${randomUUID()}@pulse-url.invalid>`;
      this.db.prepare("UPDATE notifications SET delivery = 'sending', attempts = attempts + 1, email_message_id=? WHERE id=?")
        .run(messageId, job.id);
      return { ...job, messageId, delivery: 'sending' as const, attempts: job.attempts + 1 };
    });
  }

  finishEmail(job: EmailJob, error: string | null, retry: boolean) {
    const next = retry && job.attempts < 4 ? this.clock() + 60_000 * 2 ** (job.attempts - 1) : null;
    const status = error === null ? 'sent' : next === null ? 'failed' : 'pending';
    this.db.prepare(`UPDATE notifications SET delivery=?, delivery_error=?, retry_at=?
      WHERE id=? AND delivery='sending' AND attempts=? AND email_message_id=?`)
      .run(status, error, next, job.id, job.attempts, job.messageId);
  }
}
