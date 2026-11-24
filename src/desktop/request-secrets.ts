import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SafeStorage } from 'electron';
import { isDesktopRequestSecret, type RequestSecrets } from '../server/request-secrets.js';
import { atomicFile } from './backup.js';

type Encryption = Pick<SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'>
  & Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>;

export function desktopRequestSecrets(directory: string, encryption: Encryption): RequestSecrets {
  const secretsDirectory = join(directory, 'request-secrets');
  function encryptionAvailable() {
    const backend = encryption.getSelectedStorageBackend?.();
    return backend !== 'basic_text' && backend !== 'unknown' && encryption.isAsyncEncryptionAvailable();
  }
  function isFallbackCiphertext(bytes: Buffer) {
    // Electron's Linux POSIX fallback uses a fixed key and the 'v10' provider tag.
    return !!encryption.getSelectedStorageBackend && bytes.toString('ascii', 0, 3) === 'v10';
  }
  return {
    mode: 'desktop',
    async save(input) {
      if (!('value' in input) || 'environment' in input || typeof input.value !== 'string' || !input.value) {
        throw new Error('Введите значение секрета для настольного приложения.');
      }
      try {
        if (!await encryptionAvailable()) throw new Error();
        const bytes = await encryption.encryptStringAsync(input.value);
        if (isFallbackCiphertext(bytes)) throw new Error();
        const reference = 'desktop-' + randomUUID();
        await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
        await atomicFile(join(secretsDirectory, reference), staged => writeFile(staged, bytes, { mode: 0o600, flush: true }));
        return reference;
      } catch {
        throw new Error('Хранилище секретов операционной системы недоступно.');
      }
    },
    async read(reference) {
      if (!isDesktopRequestSecret(reference)) return;
      try {
        const bytes = await readFile(join(secretsDirectory, reference));
        if (isFallbackCiphertext(bytes) || !await encryptionAvailable()) return;
        return (await encryption.decryptStringAsync(bytes)).result || undefined;
      } catch { return undefined; }
    },
    async remove(reference) {
      if (!isDesktopRequestSecret(reference)) return;
      try { await rm(join(secretsDirectory, reference), { force: true }); }
      catch { throw new Error('Не удалось удалить секрет из хранилища.'); }
    },
  };
}
