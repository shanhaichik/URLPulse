import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openStagingJournal } from '../src/desktop/backup.js';
import { ownDatabase } from '../src/server/database-owner.js';
import { Store } from '../src/server/store.js';

const residue = async (directory: string) => (await readdir(directory))
  .filter(name => /^\.pulse-(write|import)-/.test(name));

test('recovers journaled import and export stages after SIGKILL and preserves both original files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-staging-crash-'));
  const profile = join(root, 'profile');
  const exports = join(root, 'exports');
  const db = join(profile, 'pulse.sqlite3');
  const changed = join(exports, 'report.csv');
  let child: ChildProcess | undefined;
  try {
    await mkdir(profile);
    await mkdir(exports);
    const store = new Store(db);
    store.createProject('Текущая база', '');
    store.close();
    await writeFile(changed, 'Предыдущий отчёт');
    await mkdir(join(exports, '.pulse-write-untracked'));
    await writeFile(join(exports, '.pulse-write-untracked', 'staged'), 'Чужой файл');

    const entry = new URL('../src/desktop/backup.ts', import.meta.url).href;
    const locks = new URL('../src/server/database-owner.ts', import.meta.url).href;
    const script = `
      import { writeFile } from 'node:fs/promises';
      import { atomicFile, openStagingJournal, prepareImport } from ${JSON.stringify(entry)};
      import { ownDatabase } from ${JSON.stringify(locks)};
      const [db, profile, changed] = process.argv.slice(1);
      const owner = ownDatabase(db);
      const journal = await openStagingJournal(profile);
      await prepareImport(db, profile, undefined, journal);
      await atomicFile(changed, async staged => {
        await writeFile(staged, 'Удалённая копия');
        process.send('ready');
        process.on('message', () => {});
        await new Promise(() => {});
      }, journal);
      owner.release();
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, db, profile, changed],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`Process exited before staging: ${code}`); }),
    ]);
    expect(message).toBe('ready');
    expect(await residue(profile)).toHaveLength(1);
    expect(await residue(exports)).toHaveLength(2);
    expect(() => ownDatabase(db)).toThrow(/уже открыта/i);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;

    const owner = ownDatabase(db);
    try {
      const journal = await openStagingJournal(profile);
      await journal.recover();
      await journal.recover();
      expect(await residue(profile)).toEqual([]);
      expect(await residue(exports)).toEqual(['.pulse-write-untracked']);
      expect(await readFile(join(exports, '.pulse-write-untracked', 'staged'), 'utf8')).toBe('Чужой файл');
      expect(await readFile(changed, 'utf8')).toBe('Предыдущий отчёт');
      const restored = new Store(db);
      try { expect(restored.projects().map(project => project.name)).toEqual(['Текущая база']); }
      finally { restored.close(); }
    } finally { owner.release(); }
  } finally {
    if (child?.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('recovers an interrupted post-rename cleanup without changing the published output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-staging-rename-'));
  try {
    const stage = await (await openStagingJournal(root)).create(root, 'write');
    const output = join(root, 'report.csv');
    await writeFile(stage.file, 'Опубликованный отчёт');
    await rename(stage.file, output);
    await (await openStagingJournal(root)).recover();
    expect(await readFile(output, 'utf8')).toBe('Опубликованный отчёт');
    expect(await residue(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers a SQLite backup stage after SIGKILL while its rollback journal exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-staging-sqlite-backup-'));
  const db = join(root, 'pulse.sqlite3');
  const destination = join(root, 'copy.sqlite3');
  let child: ChildProcess | undefined;
  try {
    const store = new Store(db);
    store.createProject('Рабочая SQLite', '');
    store.close();
    await writeFile(destination, 'Предыдущая копия');
    const entry = new URL('../src/desktop/backup.ts', import.meta.url).href;
    const script = `
      import { existsSync, writeSync } from 'node:fs';
      import { backup, DatabaseSync } from 'node:sqlite';
      import { atomicFile, openStagingJournal } from ${JSON.stringify(entry)};
      const [root, db, destination] = process.argv.slice(1);
      const source = new DatabaseSync(db, { readOnly: true });
      try {
        await atomicFile(destination, staged => backup(source, staged, { rate: 1, progress() {
          if (!existsSync(staged + '-journal')) return;
          writeSync(1, 'journal ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        } }), await openStagingJournal(root), 'backup');
      } finally { source.close(); }
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, db, destination],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'] });
    await expect(Promise.race([
      once(child.stdout!, 'data').then(([chunk]) => chunk.toString()),
      once(child, 'exit').then(([code]) => { throw new Error(`Backup exited before checkpoint: ${code}`); }),
    ])).resolves.toBe('journal ready');
    const [stage] = await residue(root);
    expect(await readdir(join(root, stage))).toContain('staged-journal');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;

    await (await openStagingJournal(root)).recover();
    expect(await residue(root)).toEqual([]);
    expect(await readFile(destination, 'utf8')).toBe('Предыдущая копия');
  } finally {
    if (child?.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test('does not follow a replaced stage directory or touch a different profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-staging-ownership-'));
  try {
    const profile = join(root, 'profile');
    const other = join(root, 'other');
    await mkdir(profile);
    await mkdir(other);
    const foreignStage = await (await openStagingJournal(other)).create(root, 'write');
    await writeFile(foreignStage.file, 'Другая запись');
    const journal = await openStagingJournal(profile);
    const stage = await journal.create(root, 'write');
    await writeFile(stage.file, 'Данные замены');
    const original = join(root, 'original');
    await rename(dirname(stage.file), original);
    await symlink(original, dirname(stage.file), process.platform === 'win32' ? 'junction' : 'dir');
    await (await openStagingJournal(profile)).recover();
    expect(await readFile(join(original, 'staged'), 'utf8')).toBe('Данные замены');
    expect(await readFile(foreignStage.file, 'utf8')).toBe('Другая запись');
  } finally { await rm(root, { recursive: true, force: true }); }
});
