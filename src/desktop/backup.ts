import { realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { BackupPhase } from '../shared/desktop.js';
import { defaultLocale, type AppLocale } from '../shared/i18n/index.js';
import { nativeTranslator } from '../shared/i18n/locales/native.js';
import { catalogTables } from '../server/catalog/schema.js';
import { ownerSuffix } from '../server/database-owner.js';
import { unreferencedPacVersion, validatePacVersion, type PacVersionRow } from '../server/pac-config.js';
import { MAX_PROFILES, validateStoredRequestProfile, type ProfileConfig, type SavedRequestProfile } from '../server/request-profiles.js';
import { pacTables, projectViewTriggers, requestProfileTables, schema } from '../server/schema.js';
import { Store } from '../server/store.js';
import { stageFile, type StagingJournal } from './staging.js';

export { openStagingJournal } from './staging.js';

const requiredTables = ['projects', 'urls', 'url_versions', 'runs', 'results', 'notifications'];
const allowedTables = new Set([...requiredTables, 'id_sequences', 'stopped_run_targets',
  'work_groups', 'work_group_urls', 'work_group_runs', ...catalogTables, ...requestProfileTables, ...pacTables]);

export async function copyDatabase(source: string, destination: string) {
  if (!(await stat(source)).isFile()) throw new Error('Выберите файл базы Пульса URL.');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;');
    await backup(db, destination);
  } finally { db.close(); }
}

export async function assertSeparateFile(source: string, destination: string, locale: AppLocale = defaultLocale) {
  const actualSource = await realpath(source);
  const actualDestination = await realpath(destination).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await realpath(dirname(destination)), basename(destination));
  });
  const left = await stat(actualSource);
  const right = await stat(actualDestination).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (['', '-wal', '-shm', '-journal', ownerSuffix].some(suffix => actualSource + suffix === actualDestination)
    || (right?.ino && left.ino === right.ino && left.dev === right.dev)) {
    throw new Error(nativeTranslator(locale)('selectSeparateDatabase'));
  }
}

export async function atomicFile(destination: string, write: (path: string) => Promise<unknown>,
  journal?: StagingJournal, kind: 'write' | 'backup' = 'write') {
  const stage = await stageFile(dirname(destination), kind, journal);
  try {
    await write(stage.file);
    await rename(stage.file, destination);
  } finally { await stage.dispose().catch(console.error); }
}

export async function createBackup(source: string, destination: string, journal?: StagingJournal) {
  await assertSeparateFile(source, destination);
  await atomicFile(destination, path => copyDatabase(source, path), journal, 'backup');
}

function validateSchema(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const expected = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA trusted_schema = OFF;');
    expected.exec(schema + projectViewTriggers);
    const triggers = "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'";
    const known = new Map(expected.prepare(triggers).all().map(({ name, sql }) => [name, sql]));
    const objects = db.prepare("SELECT type, name FROM pragma_table_list WHERE schema = 'main'").all();
    const names = new Set(objects.map(entry => String(entry.name)));
    if (requiredTables.some(table => !names.has(table))
      || objects.some(entry => !String(entry.name).startsWith('sqlite_')
        && (entry.type !== 'table' || !allowedTables.has(String(entry.name))))
      || db.prepare(triggers).all().some(({ name, sql }) => known.get(name) !== sql)
      || db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Неподдерживаемая или повреждённая база Пульса URL.');
    }
  } finally { expected.close(); db.close(); }
}

function validateColumns(db: DatabaseSync) {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(schema);
    const columns = "SELECT name, type, [notnull], pk, hidden FROM pragma_table_xinfo(?) ORDER BY name";
    const foreignKeys = "SELECT [table], [from], [to], on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY [from]";
    for (const query of [columns, foreignKeys]) {
      const actual = db.prepare(query);
      const reference = expected.prepare(query);
      if ([...allowedTables].some(table => JSON.stringify(actual.all(table)) !== JSON.stringify(reference.all(table)))) {
        throw new Error('Структура базы отличается от поддерживаемого формата Пульса URL.');
      }
    }
  } finally { expected.close(); }
}

async function validateRequestProfiles(db: DatabaseSync) {
  try {
    for (const row of db.prepare('SELECT origin,is_default,config FROM request_profiles').iterate()) {
      const profile = JSON.parse(String(row.config)) as ProfileConfig;
      if (profile.origin !== row.origin || Number(profile.isDefault) !== row.is_default) throw new Error();
      await validateStoredRequestProfile(profile);
    }
    const assignments = db.prepare(`SELECT u.url,p.origin,u.project_id AS project,p.project_id AS scope
      FROM request_url_profiles a JOIN urls u ON u.id=a.url_id JOIN request_profiles p ON p.id=a.profile_id`);
    for (const row of assignments.iterate()) {
      if (row.project !== row.scope || new URL(String(row.url)).origin !== row.origin) throw new Error();
    }
    for (const row of db.prepare('SELECT request_snapshot FROM runs WHERE request_snapshot IS NOT NULL').iterate()) {
      const snapshot = JSON.parse(String(row.request_snapshot)) as SavedRequestProfile[];
      if (!Array.isArray(snapshot) || snapshot.length > MAX_PROFILES) throw new Error();
      const profileIds = new Set<number>();
      for (const { id, ...profile } of snapshot) {
        if (!Number.isSafeInteger(id) || id <= 0 || profileIds.has(id)) throw new Error();
        profileIds.add(id);
        await validateStoredRequestProfile(profile);
      }
    }
  } catch {
    throw new Error('В резервной копии повреждены профили HTTP-запросов.');
  }
}

export class BackupRunIntegrityError extends Error {
  constructor(readonly runId: number, locale: AppLocale = defaultLocale) {
    super(nativeTranslator(locale)('backupRunIntegrity', { runId }));
  }
}

function validateRunIntegrity(db: DatabaseSync) {
  const inconsistent = db.prepare(`
    WITH checks AS (
      SELECT run_id, COUNT(*) AS known, COUNT(checked_at) AS checked,
        COUNT(*) FILTER (WHERE status='ok') AS available,
        COUNT(*) FILTER (WHERE status='error') AS failures,
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status NOT IN ('ok','error','pending')
          OR (status='pending') <> (checked_at IS NULL)) AS invalid
      FROM results GROUP BY run_id
    ), stopped AS (
      SELECT run_id, COUNT(*) AS known, COUNT(DISTINCT url_id) AS unique_urls
      FROM stopped_run_targets GROUP BY run_id
    )
    SELECT r.id FROM runs r LEFT JOIN checks c ON c.run_id=r.id LEFT JOIN stopped s ON s.run_id=r.id
    WHERE r.status NOT IN ('queued','running','done','cancelled') OR r.total<0
      OR COALESCE(c.invalid,0)<>0
      OR r.completed<>COALESCE(c.checked,0)
      OR r.available<>COALESCE(c.available,0)
      OR r.failures<>COALESCE(c.failures,0)
      OR (r.status<>'cancelled' AND (r.total<>COALESCE(c.known,0) OR COALESCE(s.known,0)<>0))
      OR (r.status='done' AND r.completed<>r.total)
      OR (r.status='cancelled' AND (
        COALESCE(c.pending,0)<>0 OR COALESCE(c.known,0)+COALESCE(s.known,0)>r.total
        OR s.known<>s.unique_urls OR EXISTS(
          SELECT 1 FROM stopped_run_targets t JOIN results v ON v.run_id=t.run_id AND v.url_id=t.url_id
          WHERE t.run_id=r.id
        )
      ))
    LIMIT 1
  `).get();
  if (inconsistent) throw new BackupRunIntegrityError(Number(inconsistent.id));
}

export async function prepareDatabase(source: string, file: string, progress: (phase: BackupPhase) => void) {
  progress('copy');
  await copyDatabase(source, file);
  progress('validate');
  validateSchema(file);
  const upgraded = new Store(file, Date.now, false);
  try { upgraded.projects(); } finally { upgraded.close(); }
  const db = new DatabaseSync(file);
  try {
    validateColumns(db);
    validateRunIntegrity(db);
    await validateRequestProfiles(db);
    validatePacVersions(db);
    progress('prepare');
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        BEGIN IMMEDIATE;
        UPDATE notifications SET delivery = 'disabled', retry_at = NULL
          WHERE delivery IN ('pending', 'sending');
        DELETE FROM catalog_transfers WHERE state IN ('queued','running');
        DELETE FROM catalog_imports WHERE id NOT IN (
          SELECT current_id FROM catalog_sources WHERE current_id IS NOT NULL
          UNION SELECT previous_id FROM catalog_sources WHERE previous_id IS NOT NULL
        );
        INSERT INTO stopped_run_targets(run_id,position,url_id,version,url,label)
          SELECT r.run_id,r.id,r.url_id,r.version,r.url,r.label FROM results r JOIN runs q ON q.id=r.run_id
          WHERE r.status='pending' AND q.status IN ('queued','running') AND q.completed>0;
        DELETE FROM results WHERE status = 'pending';
        DELETE FROM runs WHERE status IN ('queued','running') AND id NOT IN (SELECT run_id FROM results);
        UPDATE runs SET status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE status IN ('queued','running');
        DELETE FROM project_pac_versions AS pac WHERE ${unreferencedPacVersion};
        COMMIT;
        PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally { db.close(); }
}

function validatePacVersions(db: DatabaseSync) {
  try {
    for (const row of db.prepare('SELECT filename,source,revision,proxy_rules FROM project_pac_versions').iterate()) {
      validatePacVersion(row as PacVersionRow);
    }
    if (db.prepare(`SELECT 1 FROM runs r WHERE r.pac_revision IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_pac_versions p WHERE p.project_id=r.project_id AND p.revision=r.pac_revision
    ) LIMIT 1`).get()) throw new Error();
    if (db.prepare(`SELECT 1 FROM catalog_imports i JOIN catalog_sources s ON s.id=i.source_id
      WHERE i.pac_revision IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM project_pac_versions p WHERE p.project_id=s.project_id AND p.revision=i.pac_revision
      ) LIMIT 1`).get()) throw new Error();
  } catch {
    throw new Error('В резервной копии повреждены версии PAC-файлов.');
  }
}

export async function prepareImport(source: string, parent: string, progress?: (phase: BackupPhase) => void,
  journal?: StagingJournal, locale: AppLocale = defaultLocale) {
  const { file, dispose } = await stageFile(parent, 'import', journal);
  try {
    await new Promise<void>((resolve, reject) => {
      const typescript = import.meta.url.endsWith('.ts');
      const worker = new Worker(new URL(typescript ? './backup-worker.ts' : './backup-worker.js', import.meta.url), {
        workerData: { source, file }, execArgv: typescript ? ['--import', 'tsx'] : undefined,
      });
      let failure: Error | undefined;
      worker.on('message', (message: BackupPhase | { inconsistentRunId: number }) => {
        if (typeof message === 'string') progress?.(message);
        else failure = new BackupRunIntegrityError(message.inconsistentRunId, locale);
      });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('Подготовка резервной копии прервалась.'));
        else resolve();
      });
    });
    return { file, dispose };
  } catch (cause) {
    await dispose().catch(console.error);
    if (cause instanceof BackupRunIntegrityError) throw cause;
    throw new Error(nativeTranslator(locale)('backupImportFailed'), { cause });
  }
}
