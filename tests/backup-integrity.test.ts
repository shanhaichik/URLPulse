import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { createBackup, prepareImport } from '../src/desktop/backup.js';
import { Store } from '../src/server/store.js';
import { parsePacFile, withPacProxies } from '../src/server/pac-config.js';

function finishFirst(store: Store) {
  const project = store.createProject('Действительная история', '').id;
  store.addUrls(project, ['a.example', 'b.example'].map((input, index) => ({ input, line: index + 1 })));
  const run = store.enqueue(project).id;
  for (const item of store.claim()!.items) store.saveResult(item.id, {
    status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
    contentType: null, contentLength: null, errorKind: null, error: null,
  });
  store.finish(run);
  return { project, run };
}

test('rejects a physically valid backup with inconsistent run counters before replacing active data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-invariants-'));
  const active = join(directory, 'active.sqlite3');
  const source = join(directory, 'input.sqlite3');
  const store = new Store(active);
  try {
    const { project, run } = finishFirst(store);
    await createBackup(active, source);
    const copy = new DatabaseSync(source);
    try {
      copy.prepare('UPDATE runs SET completed=0,available=0 WHERE id=?').run(run);
      expect(copy.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
      expect(copy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { copy.close(); }

    const phases: string[] = [];
    await expect(prepareImport(source, directory, phase => phases.push(phase)))
      .rejects.toThrow(new RegExp(`счётчики.*№${run}`, 'i'));
    expect(phases).toEqual(['copy', 'validate']);
    expect(store.run(run, project)).toMatchObject({ status: 'done', completed: 2, available: 2 });
    expect((await readdir(directory)).filter(path => path.startsWith('.pulse-import-'))).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves checked history from an older stopped run without a known complete list of goals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-legacy-'));
  const source = join(directory, 'legacy.sqlite3');
  const store = new Store(source);
  try {
    const { project } = finishFirst(store);
    const run = store.enqueue(project).id;
    const [item] = store.claim()!.items;
    store.saveResult(item.id, { status: 'error', httpCode: 503, durationMs: 1, finalUrl: item.url,
      redirects: 0, contentType: null, contentLength: null, errorKind: 'http', error: 'fixture' });
    store.stopRun(project, run);
    const legacy = new DatabaseSync(source);
    try {
      legacy.prepare('DELETE FROM stopped_run_targets WHERE run_id=?').run(run);
      legacy.exec('ALTER TABLE notifications DROP COLUMN email_message_id');
    }
    finally { legacy.close(); }

    const staged = await prepareImport(source, directory);
    const restored = new Store(staged.file);
    try {
      expect(restored.run(run, project)).toMatchObject({ status: 'cancelled', total: 2, completed: 1, failures: 1 });
      expect(restored.runResults(run)).toMatchObject([{ id: item.id, status: 'error' }]);
      const inspection = new DatabaseSync(staged.file, { readOnly: true });
      try {
        expect(inspection.prepare('PRAGMA table_info(notifications)').all().map(column => column.name))
          .toContain('email_message_id');
      } finally { inspection.close(); }
    } finally {
      restored.close();
      await staged.dispose();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['non-array policy', 'unknown rule field'])('rejects a PAC backup with %s', async kind => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-pac-'));
  const source = join(directory, 'input.sqlite3');
  const store = new Store(source);
  try {
    const { id } = store.createProject('PAC backup', '');
    const pac = parsePacFile('office.pac', "function FindProxyForURL() { return 'DIRECT'; }");
    const unexpected = { url: 'https://proxy.example:8443', allowPrivate: false, connectByHostname: false, note: 'fixture' };
    store.savePac(id, kind === 'non-array policy' ? pac : withPacProxies(pac, [unexpected]));
    if (kind === 'non-array policy') {
      const db = new DatabaseSync(source);
      try { db.prepare('UPDATE project_pac_versions SET proxy_rules=?').run('{}'); }
      finally { db.close(); }
    }
    const result = await prepareImport(source, directory).then(async staged => {
      await staged.dispose();
      return 'accepted';
    }, (error: Error) => error.cause instanceof Error ? error.cause.message : error.message);
    expect(result).toBe('В резервной копии повреждены версии PAC-файлов.');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([false, true])('restores PAC settings from a backup with proxy rules present=%s', async withRules => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-backup-pac-valid-'));
  const source = join(directory, 'input.sqlite3');
  const store = new Store(source);
  try {
    const { id } = store.createProject('PAC backup', '');
    const pac = parsePacFile('office.pac', "function FindProxyForURL() { return 'DIRECT'; }");
    const proxy = { url: 'https://proxy.example:8443', allowPrivate: true, connectByHostname: true,
      auth: { username: 'fixture', ref: 'PULSE_REQUEST_SECRET_FIXTURE' } };
    const config = withRules ? withPacProxies(pac, [proxy]) : pac;
    store.savePac(id, config);
    if (!withRules) {
      const db = new DatabaseSync(source);
      try { db.exec('ALTER TABLE project_pac_versions DROP COLUMN proxy_rules; ALTER TABLE catalog_imports DROP COLUMN pac_revision'); }
      finally { db.close(); }
    }
    const staged = await prepareImport(source, directory);
    const restored = new Store(staged.file);
    try { expect(restored.projectPac(id)).toEqual(config); }
    finally { restored.close(); await staged.dispose(); }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
