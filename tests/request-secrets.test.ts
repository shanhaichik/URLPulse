import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { desktopRequestSecrets } from '../src/desktop/request-secrets.js';
import { envRequestSecrets } from '../src/server/request-secrets.js';
import type { DesktopRequest } from '../src/shared/desktop.js';

function testEncryption() {
  const key = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    async decryptStringAsync(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'),
        shouldReEncrypt: false,
      };
    },
  };
}

async function temporaryDirectory(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-request-secrets-'));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('only resolves explicitly named request secret environment variables', async () => {
  const env = { PULSE_REQUEST_SECRET_SITE_1: 'site token', SMTP_PASSWORD: 'unrelated credential' };
  const secrets = envRequestSecrets(env);
  const reference = await secrets.save({ environment: 'PULSE_REQUEST_SECRET_SITE_1' });
  expect(reference).toBe('PULSE_REQUEST_SECRET_SITE_1');
  expect(await secrets.read(reference)).toBe('site token');
  await secrets.remove(reference);
  expect(env.PULSE_REQUEST_SECRET_SITE_1).toBe('site token');
  expect(await secrets.read('PULSE_REQUEST_SECRET_MISSING')).toBeUndefined();
  expect(await secrets.read('SMTP_PASSWORD')).toBeUndefined();
  for (const alias of ['SMTP_PASSWORD', 'PULSE_REQUEST_SECRET_', 'PULSE_REQUEST_SECRET_Site', 'PULSE_REQUEST_SECRET_SITE_1\n']) {
    await expect(secrets.save({ environment: alias })).rejects.toThrow();
  }
  await expect(secrets.save({ value: 'site token' })).rejects.toThrow();
});

test('persists concurrent desktop secret saves under independent encrypted references', async () => {
  await temporaryDirectory(async directory => {
    const encryption = testEncryption();
    const first = desktopRequestSecrets(directory, encryption);
    const second = desktopRequestSecrets(directory, encryption);
    const original = 'original bearer secret';
    const replacement = 'replacement bearer secret';
    const [firstRef, secondRef] = await Promise.all([
      first.save({ value: original }), second.save({ value: replacement }),
    ]);
    expect(firstRef).not.toBe(secondRef);
    expect(firstRef).not.toContain(original);
    expect(secondRef).not.toContain(replacement);
    const restarted = desktopRequestSecrets(directory, encryption);
    expect(await restarted.read(firstRef)).toBe(original);
    expect(await restarted.read(secondRef)).toBe(replacement);
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter(file => file.isFile());
    expect(files).toHaveLength(2);
    for (const file of files) {
      const bytes = await readFile(join(file.parentPath, file.name));
      expect(bytes.includes(original)).toBe(false);
      expect(bytes.includes(replacement)).toBe(false);
    }
    await Promise.all([restarted.remove(firstRef), first.remove(firstRef)]);
    expect(await second.read(firstRef)).toBeUndefined();
    expect(await second.read(secondRef)).toBe(replacement);
  });
});

test('desktop secrets are unavailable without the storage keys or their encrypted files', async () => {
  await temporaryDirectory(async directory => {
    const encryption = testEncryption();
    const secrets = desktopRequestSecrets(directory, encryption);
    const reference = await secrets.save({ value: 'original bearer secret' });
    await temporaryDirectory(async otherDirectory => {
      const moved = desktopRequestSecrets(otherDirectory, encryption);
      expect(await moved.read(reference)).toBeUndefined();
    });
    const wrongKey = desktopRequestSecrets(directory, testEncryption());
    expect(await wrongKey.read(reference)).toBeUndefined();
    const unavailable = desktopRequestSecrets(directory, {
      ...encryption, async isAsyncEncryptionAvailable() { return false; },
    });
    expect(await unavailable.read(reference)).toBeUndefined();
    await expect(unavailable.save({ value: 'another secret' })).rejects.toThrow(/хранилищ/i);
    await expect(secrets.save({ environment: 'PULSE_REQUEST_SECRET_SITE' })).rejects.toThrow();
    const outside = join(directory, 'unrelated');
    await writeFile(outside, 'other data');
    expect(await secrets.read('../unrelated')).toBeUndefined();
    await secrets.remove('../unrelated');
    expect(await readFile(outside, 'utf8')).toBe('other data');
  });
});

test('desktop refuses the Linux safeStorage fallback even when encryption reports success', async () => {
  await temporaryDirectory(async directory => {
    const encryption = testEncryption();
    const basic = desktopRequestSecrets(directory, {
      ...encryption,
      getSelectedStorageBackend: () => 'basic_text',
    });
    await expect(basic.save({ value: 'local credential' })).rejects.toThrow(/хранилищ/i);
    const fallback = desktopRequestSecrets(directory, {
      ...encryption,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      async encryptStringAsync() { return Buffer.from('v10fallback ciphertext'); },
    });
    await expect(fallback.save({ value: 'local credential' })).rejects.toThrow(/хранилищ/i);
    expect(await readdir(directory)).toEqual([]);
  });
});

test('desktop IPC allows only the scoped request profile operations', () => {
  const projects = '/api/projects/12';
  const allowed: [DesktopRequest['method'], string][] = [
    ['GET', '/request-profiles'], ['POST', '/request-profiles'],
    ['PATCH', '/request-profiles/34'], ['DELETE', '/request-profiles/34'],
    ['POST', '/request-profiles/34/test'],
    ['GET', '/urls/56/request-profile'], ['PATCH', '/urls/56/request-profile'],
  ];
  for (const [method, path] of allowed) {
    expect(desktopRequest({ method, path: projects + path }).path).toBe(projects + path);
  }
  const denied: [DesktopRequest['method'], string][] = [
    ['GET', '/api/request-profiles'], ['GET', '/api/projects/0/request-profiles'],
    ['GET', projects + '/request-profiles/34'], ['GET', projects + '/request-profiles/34/test'],
    ['GET', projects + '/urls/0/request-profile'], ['GET', projects + '/urls/56/request-profile/secrets'],
    ['PATCH', projects + '/request-profiles/9007199254740992'],
    ['POST', projects + '/request-profiles/%33/test'], ['DELETE', projects + '/request-profiles/34/secrets'],
  ];
  for (const [method, path] of denied) expect(() => desktopRequest({ method, path })).toThrow();
});
