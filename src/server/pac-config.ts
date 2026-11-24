import { createHash } from 'node:crypto';
import { MAX_PAC_BYTES, type PacSettings } from '../shared/pac.js';

export interface StoredPac extends PacSettings { source: string }

export function parsePacFile(filename: unknown, source: unknown): StoredPac {
  if (typeof filename !== 'string' || !/^[^/\\\x00-\x1f\x7f]{1,180}\.pac$/i.test(filename)) {
    throw new Error('Выберите файл с расширением .pac.');
  }
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') || Buffer.byteLength(source) > MAX_PAC_BYTES) {
    throw new Error(`PAC-файл должен содержать текст UTF-8 и занимать до ${MAX_PAC_BYTES / 1024} КиБ.`);
  }
  const revision = createHash('sha256').update(filename).update('\0').update(source).digest('hex');
  return { filename, revision, source };
}

export function pacSettings(config?: StoredPac): { pac: PacSettings | null } {
  return { pac: config ? { filename: config.filename, revision: config.revision } : null };
}
