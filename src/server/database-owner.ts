import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ownerSuffix = '.owner-lock';

export function prepareProfileDirectory(directory: string, appManaged: boolean) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = lstatSync(directory);
  if (!state.isDirectory()) throw new Error('Укажите отдельный каталог данных Пульса URL.');
  if (process.platform !== 'win32') {
    if (state.uid !== process.getuid?.() || (!appManaged && (state.mode & 0o077) !== 0)) {
      throw new Error('Укажите каталог данных, принадлежащий текущему пользователю, с правами 700.');
    }
    if (appManaged && (state.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
  }
  return directory;
}

function privateDatabaseFile(file: string, create = false) {
  if (process.platform === 'win32') return;
  const inspect = (state: Stats) => {
    if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid?.()) {
      throw new Error('Для базы и её служебных файлов нужны обычные файлы текущего пользователя без дополнительных ссылок.');
    }
  };
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number;
  try {
    const state = lstatSync(file);
    inspect(state);
    // Closing a separate descriptor can release same-process SQLite file locks.
    // Leave already-private open files alone.
    if ((state.mode & 0o777) === 0o600) return;
    fd = openSync(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return;
    try { fd = openSync(file, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'EEXIST') return privateDatabaseFile(file, create);
      throw failure;
    }
  }
  try {
    const state = fstatSync(fd);
    inspect(state);
    if ((state.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

export function ownDatabase(database: string) {
  let canonical: string;
  try {
    canonical = realpathSync(database);
    if (statSync(canonical).nlink > 1) {
      throw new Error('У файла базы есть жёсткие ссылки. Используйте отдельную копию базы.');
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonical = join(realpathSync(dirname(database)), basename(database));
  }
  // The OS releases this SQLite write lock even if the owner is killed. The
  // sidecar stays in place so replacing the working database cannot split the lock.
  const lockPath = canonical + ownerSuffix;
  privateDatabaseFile(lockPath, true);
  privateDatabaseFile(lockPath + '-journal');
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    privateDatabaseFile(canonical, true);
    for (const suffix of ['-wal', '-shm', '-journal']) privateDatabaseFile(canonical + suffix);
  }
  catch (error) {
    lock.close();
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0)) {
      throw new Error('База Пульса URL уже открыта в другой копии приложения. Закройте её и повторите запуск.', { cause: error });
    }
    throw error;
  }
  return { path: canonical, release: () => lock.close() };
}
