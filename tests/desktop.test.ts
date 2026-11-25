import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { assertSeparateFile, atomicFile, createBackup, prepareDatabase, prepareImport } from '../src/desktop/backup.js';
import { desktopRequest, exportScope, reportArguments } from '../src/desktop/contracts.js';
import { ownerSuffix } from '../src/server/database-owner.js';
import { parsePacFile } from '../src/server/pac-config.js';
import { Store } from '../src/server/store.js';

test('restricts desktop requests and file exports to the typed application routes', () => {
  expect(desktopRequest({ method: 'DELETE', path: '/api/projects/12/runs/50' }).path)
    .toBe('/api/projects/12/runs/50');
  expect(desktopRequest({ method: 'GET', path: '/api/projects/12/runs?before=80' }).path)
    .toBe('/api/projects/12/runs?before=80');
  const comparison = '/api/projects/12/run-comparison?baseline=50&target=51&view=summary';
  expect(desktopRequest({ method: 'GET', path: comparison }).path).toBe(comparison);
  expect(() => desktopRequest({ method: 'POST', path: comparison })).toThrow();
  for (const path of ['/api/projects/12/urls/delete/preview?status=ok', '/api/projects/12/urls/50/restore']) {
    expect(desktopRequest({ method: 'POST', path }).path).toBe(path);
  }
  for (const path of ['https://example.com', '/api/projects/../notifications', '/assets/a.js',
    '/api/projects/1/export', '/api/projects/1/runs/%31', '/api/projects/1/run-comparison/export']) {
    expect(() => desktopRequest({ method: 'GET', path })).toThrow();
  }
  expect(exportScope('/api/projects/12/urls/50')).toEqual({ projectId: 12, urlId: 50 });
  expect(() => exportScope('/api/projects/12?format=csv')).toThrow();
  expect(reportArguments('pulse-url://report/?project=2&run=7')).toEqual({ project: '2', run: '7' });
  expect(reportArguments('pulse-url://example.com/?project=2&run=7')).toBeUndefined();
});

test('forwards structured diagnostics only when a desktop request explicitly opts in', () => {
  const request = { method: 'GET', path: '/api/projects' } as const;
  expect(desktopRequest(request)).not.toHaveProperty('i18n');
  expect(desktopRequest({ ...request, i18n: true })).toHaveProperty('i18n', true);
  expect(() => desktopRequest({ ...request, i18n: '1' as unknown as true })).toThrow(/Недопустимая операция/);
});

test('creates a consistent SQLite backup while writes are open and validates the import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-'));
  const source = join(directory, 'source.sqlite3');
  const copy = join(directory, 'copy.sqlite3');
  const store = new Store(source);
  try {
    const project = store.createProject('История', '');
    store.addUrls(project.id, [{ input: 'example.com', line: 1 }]);
    store.saveSettings(project.id, { schedule: null, notify: 'all', email: 'operator@example.com', tlsProfile: 'russian-ca', checkConcurrency: 12 });
    const profile = store.saveRequestProfile(project.id, { name: 'Профиль из резервной копии', origin: 'https://example.com',
      isDefault: true, headers: [], auth: { kind: 'bearer', ref: 'desktop-23587e66-c9d7-4ea0-864c-881c1913e5ce' }, proxy: null });
    const urlId = store.addresses(project.id)[0].id;
    store.saveRequestChoice(project.id, urlId, profile.id);
    const group = store.saveGroup(project.id, 'Группа из резервной копии');
    store.changeGroupMembers(project.id, group.id, 'add', [store.addresses(project.id)[0].id]);
    const pastPac = parsePacFile('direct.pac', 'function FindProxyForURL() { return "DIRECT"; }');
    store.savePac(project.id, pastPac);
    const first = store.enqueueGroup(project.id, group.id);
    store.saveResult(store.claim()!.items[0].id, {
      status: 'ok', httpCode: 200, durationMs: 1, finalUrl: 'https://example.com/', redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null,
    });
    store.finish(first.id);
    const activePac = parsePacFile('work.pac', 'function FindProxyForURL() { return "PROXY proxy.example:8080"; }');
    store.savePac(project.id, activePac);
    const cancelled = store.enqueue(project.id);
    store.stopRun(project.id, cancelled.id);
    store.enqueue(project.id);
    await createBackup(source, copy);
    const staged = await prepareImport(copy, directory);
    const restored = new Store(staged.file);
    try {
      expect(restored.project(project.id)).toMatchObject({ name: 'История', urlCount: 1, tlsProfile: 'russian-ca', checkConcurrency: 12 });
      expect(restored.runs(project.id)).toMatchObject([
        { id: cancelled.id, status: 'cancelled', total: 1, completed: 0 },
        { id: first.id, status: 'done', group: { id: group.id, name: group.name } },
      ]);
      expect(restored.groups(project.id)).toMatchObject([{ id: group.id, name: group.name, count: 1 }]);
      expect(restored.requestProfiles(project.id)).toEqual([profile]);
      expect(restored.requestChoice(project.id, urlId)).toBe(profile.id);
      expect(restored.projectPac(project.id)).toEqual(activePac);
      expect(restored.pacSnapshot(first.id)).toEqual(pastPac);
      expect(restored.addresses(project.id)[0].latest?.httpCode).toBe(200);
      expect(restored.claimEmail()).toBeUndefined();
      const replay = restored.restartRun(project.id, cancelled.id);
      expect(restored.claim()).toMatchObject({ id: replay.id, items: [{ url: 'https://example.com/', profileChoice: profile.id }] });
      expect(restored.pacSnapshot(replay.id)).toEqual(activePac);
    } finally {
      restored.close();
      await staged.dispose();
    }
    const unrelated = join(directory, 'other.sqlite3');
    const database = new DatabaseSync(unrelated);
    database.exec('CREATE TABLE sample (id INTEGER)');
    database.close();
    await expect(prepareImport(unrelated, directory)).rejects.toThrow(/баз[ау]/i);
    const edited = join(directory, 'modified-trigger.sqlite3');
    await createBackup(source, edited);
    const withModifiedTrigger = new DatabaseSync(edited);
    withModifiedTrigger.exec(`DROP TRIGGER project_run_changed;
      CREATE TRIGGER project_run_changed AFTER UPDATE ON runs BEGIN SELECT 1; END;`);
    withModifiedTrigger.close();
    await expect(prepareImport(edited, directory)).rejects.toThrow(/баз[ау]/i);
    const incomplete = new DatabaseSync(copy);
    const badProfile = join(directory, 'invalid-profile.sqlite3');
    await createBackup(source, badProfile);
    const invalid = new DatabaseSync(badProfile);
    invalid.prepare('UPDATE request_profiles SET config=? WHERE id=?').run('{broken', profile.id);
    invalid.close();
    await expect(prepareImport(badProfile, directory)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/профил/i) },
    });
    const badPac = join(directory, 'invalid-pac.sqlite3');
    await createBackup(source, badPac);
    const inconsistent = new DatabaseSync(badPac);
    inconsistent.prepare('UPDATE runs SET pac_revision=? WHERE id=?').run('missing-revision', first.id);
    inconsistent.close();
    await expect(prepareImport(badPac, directory)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/PAC/i) },
    });
    incomplete.exec('ALTER TABLE urls DROP COLUMN label');
    incomplete.close();
    await expect(prepareImport(copy, directory)).rejects.toThrow(/баз[ау]/i);
    await expect(createBackup(source, source)).rejects.toThrow();
    await expect(createBackup(source, source + '-wal')).rejects.toThrow();
    expect(store.projects()).toHaveLength(1);
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('restores a partial check as stopped and excludes it from the comparison baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-partial-backup-'));
  const source = join(directory, 'source.sqlite3');
  const copy = join(directory, 'copy.sqlite3');
  const store = new Store(source);
  try {
    const { id } = store.createProject('История', '');
    store.addUrls(id, ['a.invalid', 'b.invalid', 'c.invalid'].map((input, index) => ({ input, line: index + 1 })));
    const save = (item: { id: number; url: string }) => store.saveResult(item.id, {
      status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null,
    });
    const baseline = store.enqueue(id);
    for (const item of store.claim()!.items) save(item);
    store.finish(baseline.id);

    const partial = store.enqueue(id);
    const [checked] = store.claim()!.items;
    save(checked);
    await createBackup(source, copy);
    const staged = await prepareImport(copy, directory);
    const restored = new Store(staged.file);
    try {
      expect(restored.run(partial.id, id)).toMatchObject({
        status: 'cancelled', total: 3, completed: 1, available: 1, finishedAt: expect.any(String),
      });
      expect(restored.runResults(partial.id)).toMatchObject([{ id: checked.id, status: 'ok' }]);
      const next = restored.restartRun(id, partial.id);
      expect(restored.run(next.id, id)).toMatchObject({ total: 3, completed: 0 });
      expect(restored.claim()!.items.map(row => row.url)).toEqual(['https://a.invalid/', 'https://b.invalid/', 'https://c.invalid/']);
      expect(restored.report(id, next.id, {}).previousRun?.id).toBe(baseline.id);
    } finally {
      restored.close();
      await staged.dispose();
    }
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('keeps the existing destination and removes staged bytes on a failed export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-export-write-'));
  const destination = join(directory, 'report.csv');
  try {
    await writeFile(destination, 'previous report');
    await expect(atomicFile(destination, async staged => {
      await writeFile(staged, 'partial report');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readFile(destination, 'utf8')).toBe('previous report');
    expect(await readdir(directory)).toEqual(['report.csv']);
  } finally { await rm(directory, { force: true, recursive: true }); }
});

test('blocks backup writes to active database aliases and sidecars', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-targets-'));
  const databaseDirectory = join(directory, 'db');
  const linkedDirectory = join(directory, 'linked-db');
  const source = join(databaseDirectory, 'source.sqlite3');
  let store: Store | undefined;
  try {
    await mkdir(databaseDirectory);
    await symlink(databaseDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    store = new Store(source);
    const project = store.createProject('Активная база', '');
    const alias = join(directory, 'hard-link.sqlite3');
    await link(source, alias);
    await expect(createBackup(source, alias)).rejects.toThrow(/отличный от активной базы/);
    const linkedSource = join(linkedDirectory, 'source.sqlite3');
    for (const suffix of ['-shm', '-journal', ownerSuffix]) {
      await expect(assertSeparateFile(source, linkedSource + suffix), suffix).rejects.toThrow(/отличный от активной базы/);
    }
    await expect(assertSeparateFile(source, join(linkedDirectory, 'new.sqlite3'))).resolves.toBeUndefined();
    expect(await readFile(alias)).toEqual(await readFile(source));
    expect(store.project(project.id)?.name).toBe('Активная база');
  } finally {
    store?.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('restores completed catalog snapshots while removing unfinished transfers and disabling in-flight mail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-state-'));
  const source = join(directory, 'source.sqlite3');
  const destination = join(directory, 'restored.sqlite3');
  const phases: string[] = [];
  const store = new Store(source);
  try {
    const { id } = store.createProject('Снимок каталога', '');
    store.addUrls(id, [{ input: 'https://fixture.invalid/', line: 1 }]);
    store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@fixture.invalid' });
    for (let i = 0; i < 2; i++) {
      const { id: run } = store.enqueue(id);
      const [item] = store.claim()!.items;
      store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url,
        redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
      store.finish(run);
    }
    expect(store.claimEmail()).toBeDefined();

    const original = new DatabaseSync(source);
    try {
      original.prepare('INSERT INTO catalog_sources (id,project_id,name,current_id,previous_id) VALUES (1,?,?,2,1)').run(id, 'fixture');
      original.exec(`INSERT INTO catalog_imports (id,source_id,state,profile,created_at) VALUES
        (1,1,'done','default','2026-01-01'), (2,1,'done','default','2026-01-02'), (3,1,'queued','default','2026-01-03');`);
      const transfer = original.prepare('INSERT INTO catalog_transfers (id,project_id,state,created_at) VALUES (?,?,?,?)');
      transfer.run(1, id, 'done', '2026-01-01');
      transfer.run(2, id, 'running', '2026-01-02');
      original.exec('INSERT INTO catalog_transfer_sources (transfer_id, import_id) VALUES (1,1), (2,2)');
      expect(original.prepare('SELECT delivery FROM notifications ORDER BY delivery').all())
        .toEqual([{ delivery: 'pending' }, { delivery: 'sending' }]);

      await prepareDatabase(source, destination, phase => phases.push(phase));
      expect(phases).toEqual(['copy', 'validate', 'prepare']);
      const restored = new DatabaseSync(destination, { readOnly: true });
      try {
        expect(restored.prepare('SELECT current_id, previous_id FROM catalog_sources').get())
          .toMatchObject({ current_id: 2, previous_id: 1 });
        expect(restored.prepare('SELECT id FROM catalog_imports ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
        expect(restored.prepare('SELECT id, state FROM catalog_transfers').all()).toEqual([{ id: 1, state: 'done' }]);
        expect(restored.prepare('SELECT transfer_id, import_id FROM catalog_transfer_sources').all())
          .toEqual([{ transfer_id: 1, import_id: 1 }]);
        expect(restored.prepare('SELECT delivery, retry_at FROM notifications').all())
          .toEqual([{ delivery: 'disabled', retry_at: null }, { delivery: 'disabled', retry_at: null }]);
        expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { restored.close(); }
      expect(original.prepare('SELECT count(*) AS count FROM catalog_imports').get()).toMatchObject({ count: 3 });
      expect(original.prepare('SELECT delivery FROM notifications ORDER BY delivery').all())
        .toEqual([{ delivery: 'pending' }, { delivery: 'sending' }]);
    } finally { original.close(); }
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
