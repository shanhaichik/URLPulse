import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const kinds = {
  write: { prefix: '.pulse-write-', file: 'staged', sqlite: false },
  backup: { prefix: '.pulse-write-', file: 'staged', sqlite: true },
  import: { prefix: '.pulse-import-', file: 'restore.sqlite3', sqlite: true },
} as const;
type Kind = keyof typeof kinds;
type Record = {
  kind: Kind;
  parent: string;
  parentIdentity: string;
  stageIdentity: string;
};

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function identity(value: BigIntStats) {
  return `${value.dev}:${value.ino}:${value.birthtimeNs}`;
}

async function directoryIdentity(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error('Не удалось проверить каталог промежуточных файлов.');
  return identity(info);
}

function isRecord(record: unknown): record is Record {
  if (typeof record !== 'object' || !record) return false;
  const { kind, parent, parentIdentity, stageIdentity } = record as Partial<Record>;
  return typeof kind === 'string' && Object.hasOwn(kinds, kind) && typeof parent === 'string' && isAbsolute(parent)
    && typeof parentIdentity === 'string' && typeof stageIdentity === 'string';
}

export interface StagedFile { file: string; dispose: () => Promise<void> }

export class StagingJournal {
  constructor(private readonly journal: string) {}

  async create(parent: string, kind: Kind): Promise<StagedFile> {
    parent = await realpath(parent);
    const parentIdentity = await directoryIdentity(parent);
    const id = randomUUID();
    const path = join(parent, kinds[kind].prefix + id);
    await mkdir(path, { mode: 0o700 });
    let record: Record;
    try {
      record = { kind, parent, parentIdentity, stageIdentity: await directoryIdentity(path) };
      // No payload is written until the ownership record is on disk.
      await writeFile(this.recordPath(id), JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true });
    } catch (error) {
      await rmdir(path).catch(() => {});
      throw error;
    }
    return { file: join(path, kinds[kind].file), dispose: () => this.cleanup(id, record) };
  }

  async recover() {
    for (const name of await readdir(this.journal)) {
      const match = /^([a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12})\.json$/u.exec(name);
      if (!match) continue;
      try {
        const record = await this.readRecord(match[1]);
        if (record) await this.cleanup(match[1], record);
      } catch (error) {
        // A detached volume can be mounted again at the next launch.
        console.warn('Не удалось завершить очистку промежуточной файловой операции.', (error as NodeJS.ErrnoException).code);
      }
    }
  }

  private recordPath(id: string) { return join(this.journal, id + '.json'); }

  private async readRecord(id: string) {
    const path = this.recordPath(id);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) return undefined;
    const handle = await open(path, 'r');
    try {
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || identity(after) !== identity(before) || after.size > 64_000n) return undefined;
      const bytes = Buffer.alloc(Number(after.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) return undefined;
      const record: unknown = JSON.parse(bytes.toString('utf8'));
      return isRecord(record) ? record : undefined;
    } finally { await handle.close(); }
  }

  private async cleanup(id: string, record: Record) {
    const { kind, parent, parentIdentity, stageIdentity } = record;
    const { prefix, file, sqlite } = kinds[kind];
    if (await realpath(parent) !== parent || await directoryIdentity(parent) !== parentIdentity) return;
    const path = join(parent, prefix + id);
    const directory = await lstat(path, { bigint: true }).catch(error => {
      if (!missing(error)) throw error;
    });
    if (directory) {
      if (!directory.isDirectory() || identity(directory) !== stageIdentity) return;
      const allowed = sqlite ? [file, file + '-journal', file + '-wal', file + '-shm'] : [file];
      // Refuse to remove unfamiliar files or follow a replacement link.
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some(entry => !entry.isFile() || !allowed.includes(entry.name))) return;
      for (const entry of entries) await unlink(join(path, entry.name)).catch(error => {
        if (!missing(error)) throw error;
      });
      await rmdir(path);
    }
    await unlink(this.recordPath(id)).catch(error => {
      if (!missing(error)) throw error;
    });
  }
}

export async function openStagingJournal(profile: string) {
  const journal = join(await realpath(profile), '.pulse-file-operations');
  await mkdir(journal, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await directoryIdentity(journal);
  return new StagingJournal(journal);
}

export async function stageFile(parent: string, kind: Kind, journal?: StagingJournal): Promise<StagedFile> {
  if (journal) return journal.create(parent, kind);
  const directory = await mkdtemp(join(parent, kinds[kind].prefix));
  return { file: join(directory, kinds[kind].file), dispose: () => rm(directory, { recursive: true, force: true }) };
}
