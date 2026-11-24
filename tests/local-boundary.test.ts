import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { ownDatabase, ownerSuffix, prepareProfileDirectory } from '../src/server/database-owner.js';
import { Store } from '../src/server/store.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-local-boundary-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe.skipIf(process.platform === 'win32')('private POSIX paths', () => {
  const permissions = (file: string) => statSync(file).mode & 0o777;

  test('limits the app profile and files from a previous deployment', () => {
    const { dir, dispose } = temporaryDirectory();
    const profile = join(dir, 'profile');
    mkdirSync(profile, { mode: 0o755 });
    const database = join(profile, 'pulse.sqlite3');
    const previous = new Store(database);
    previous.close();
    chmodSync(database, 0o644);
    writeFileSync(database + ownerSuffix, '', { mode: 0o644 });
    const ownership = prepareProfileDirectory(profile, true);
    expect(ownership).toBe(profile);
    const lock = ownDatabase(database);
    const current = new Store(lock.path);
    try {
      current.createProject('Проверка прав', '');
      expect(permissions(profile)).toBe(0o700);
      for (const file of [database, database + '-wal', database + '-shm', database + ownerSuffix]) {
        expect(permissions(file)).toBe(0o600);
      }
    } finally { current.close(); lock.release(); dispose(); }
  });

  test('requires an explicitly configured profile to be private without chmod on the parent', () => {
    const { dir, dispose } = temporaryDirectory();
    try {
      const reusable = join(dir, 'shared');
      mkdirSync(reusable, { mode: 0o755 });
      expect(() => prepareProfileDirectory(reusable, false)).toThrow(/700/);
      expect(permissions(reusable)).toBe(0o755);
      const created = join(reusable, 'app');
      prepareProfileDirectory(created, false);
      expect(permissions(created)).toBe(0o700);
      expect(permissions(reusable)).toBe(0o755);
    } finally { dispose(); }
  });
});

test('requires a local web session for workspace, writes and streamed downloads', async () => {
  const key = 'launch_key_abcdefghijklmnopqrstuvwxyz';
  const origin = 'http://127.0.0.1:8731';
  const headers = { host: '127.0.0.1:8731', origin };
  const app = createApp({ origin, webAccessKey: key });
  const restart = createApp({ origin, webAccessKey: key });
  try {
    expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects/1/export?format=json', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/session', method: 'POST', headers, payload: { key: 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/session', method: 'POST', headers: { host: headers.host }, payload: { key } })).statusCode).toBe(403);
    const login = await app.inject({ url: '/api/session', method: 'POST', headers, payload: { key } });
    expect(login.statusCode).toBe(204);
    const received = String(login.headers['set-cookie']);
    expect(received).toMatch(/HttpOnly; SameSite=Strict/);
    expect(received).toContain('Path=/api');
    expect(received).not.toContain(key);
    const cookie = received.split(';')[0];
    const operator = { ...headers, cookie };
    const created = await app.inject({ url: '/api/projects', method: 'POST', headers: operator, payload: { name: 'Веб-сессия' } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/projects', headers: operator })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/projects/' + created.json().id + '/export?format=json', headers: operator })).body).toBe('[]\n');
    expect((await restart.inject({ url: '/api/projects', headers: operator })).statusCode).toBe(401);
  } finally { await Promise.all([app.close(), restart.close()]); }
});
