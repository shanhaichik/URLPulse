import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkUrl } from '../src/server/checker.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { openReportStream } from '../src/server/export.js';
import { russianTrustRoots } from '../src/server/tls-profile.js';
import type { TlsProfile } from '../src/shared/types.js';
import { fixtureCertificate } from './fixtures/tls-certificate.js';

const expectedFingerprint = 'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';
let directory: string;
let certificatePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pulse-tls-'));
  certificatePath = join(directory, 'root.cer');
  vi.stubEnv('PULSE_RUSSIAN_CA_FILE', certificatePath);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test('reports a missing local CA and retries once the file exists', () => {
  expect(() => russianTrustRoots()).toThrow(/Файл российского CA отсутствует/);
  vi.spyOn(X509Certificate.prototype, 'fingerprint256', 'get').mockReturnValue(expectedFingerprint);
  const certificate = new X509Certificate(fixtureCertificate);
  writeFileSync(certificatePath, certificate.raw);
  expect(russianTrustRoots()).toEqual([...getCACertificates('default'), certificate.toString()]);
});

test('rejects a different self-signed CA at the configured path', () => {
  writeFileSync(certificatePath, fixtureCertificate);
  expect(() => russianTrustRoots()).toThrow(/Файл российского CA не прошёл проверку/);
});

test('rejects a bundle even when the first CA matches the pinned fingerprint', () => {
  vi.spyOn(X509Certificate.prototype, 'fingerprint256', 'get').mockReturnValue(expectedFingerprint);
  writeFileSync(certificatePath, `${fixtureCertificate}\n${fixtureCertificate}`);
  expect(() => russianTrustRoots()).toThrow(/Файл российского CA не прошёл проверку/);
});

test('preserves project TLS profiles in queued runs and isolates sitemap imports', async () => {
  const store = new Store(':memory:');
  const profiles: TlsProfile[] = [];
  const app = createApp({
    store,
    sitemap: async (_source, profile) => {
      profiles.push(profile);
      return { documents: 1, urls: ['https://example.com/'] };
    },
  });
  try {
    const enabled = store.createProject('С дополнительным CA', '');
    const normal = store.createProject('Штатный CA', '');
    const update = await app.inject({ method: 'PATCH', url: `/api/projects/${enabled.id}/settings`,
      payload: { tlsProfile: 'russian-ca', schedule: null, notify: 'off', email: null } });
    expect(update.json().tlsProfile).toBe('russian-ca');
    for (const project of [enabled, normal]) {
      const imported = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/urls/sitemap`,
        payload: { url: 'https://example.org/sitemap.xml' } });
      expect(imported.json().added).toBe(1);
    }
    expect(profiles).toEqual(['russian-ca', 'default']);
    const queued = store.enqueue(enabled.id);
    store.saveSettings(enabled.id, { tlsProfile: 'default', schedule: null, notify: 'off', email: null });
    expect(store.claim()).toMatchObject({ id: queued.id, tlsProfile: 'russian-ca' });
    expect(store.project(normal.id).tlsProfile).toBe('default');
  } finally {
    await app.close();
    store.close();
  }
});

test('supplies additional CA on each HTTPS hop and records certificate errors', async () => {
  vi.spyOn(X509Certificate.prototype, 'fingerprint256', 'get').mockReturnValue(expectedFingerprint);
  writeFileSync(certificatePath, fixtureCertificate);
  const calls: { host: string; ca: string[] | undefined }[] = [];
  const result = await checkUrl('https://example.com/', {
    tlsProfile: 'russian-ca',
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, _addresses, _signal, _maxBytes, ca) => {
      calls.push({ host: url.host, ca });
      if (url.host === 'example.com') return { code: 302, headers: { location: 'https://example.org/' } };
      throw Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' });
    },
  });
  expect(calls.map(call => call.host)).toEqual(['example.com', 'example.org']);
  expect(calls.every(call => call.ca?.at(-1) === new X509Certificate(fixtureCertificate).toString())).toBe(true);
  expect(result).toMatchObject({ errorKind: 'tls', tlsCode: 'CERT_HAS_EXPIRED' });
  const store = new Store(':memory:');
  try {
    const { id } = store.createProject('История TLS', '');
    store.addUrls(id, [{ input: 'example.org', line: 1 }]);
    const run = store.enqueue(id);
    store.saveResult(store.claim()!.items[0].id, result);
    store.finish(run.id);
    const output = await (await openReportStream(store, id, {}, {}, 'csv')).toArray();
    expect(Buffer.concat(output).toString()).toContain('CERT_HAS_EXPIRED');
  } finally { store.close(); }
});
