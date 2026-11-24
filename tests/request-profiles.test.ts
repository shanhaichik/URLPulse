import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { checkUrl } from '../src/server/checker.js';
import { envRequestSecrets, type RequestSecrets } from '../src/server/request-secrets.js';
import { Store } from '../src/server/store.js';
import { startBackground } from '../src/server/worker.js';
import type { RequestProfileInput } from '../src/shared/request-profiles.js';

const profile: RequestProfileInput = {
  name: 'Доступ к API', origin: 'https://example.test', isDefault: true,
  headers: [], auth: { kind: 'none' }, proxy: null,
};

test('stores a scoped profile and snapshots the configuration for manual runs', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Профили', '');
    const another = store.createProject('Другой проект', '');
    store.addUrls(project.id, [{ input: 'https://example.test/check', line: 1 },
      { input: 'https://other.test/check', line: 2 }]);
    const path = `/api/projects/${project.id}/request-profiles`;
    const draft = { name: 'API', origin: 'https://example.test', isDefault: true,
      headers: [{ name: 'Accept', secret: false, value: 'application/json' }], auth: { kind: 'none' }, proxy: null };
    const created = await app.inject({ method: 'POST', url: path, payload: draft });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ ...draft, headers: [{ ...draft.headers[0], name: 'accept' }] });
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${another.id}/request-profiles/${id}`, payload: draft })).statusCode).toBe(404);
    const [first, other] = store.addresses(project.id);
    const assign = (urlId: number, profileId: number | null | 'inherit') => app.inject({
      method: 'PATCH', url: `/api/projects/${project.id}/urls/${urlId}/request-profile`, payload: { profileId },
    });
    expect((await assign(other.id, id)).statusCode).toBe(400);
    expect((await assign(first.id, id)).statusCode).toBe(200);
    const older = store.enqueue(project.id);
    expect((await app.inject({ method: 'PATCH', url: path + '/' + id, payload: { ...draft, name: 'API v2' } })).statusCode).toBe(200);
    expect(store.enqueue(project.id).id).not.toBe(older.id);
    expect(store.claim()!.items[0]).toMatchObject({ id: expect.any(Number), profileChoice: id });
    expect(store.requestSnapshot(older.id)).toMatchObject([{ id, name: 'API' }]);
    const moved = await app.inject({ method: 'PATCH', url: path + '/' + id,
      payload: { ...draft, origin: 'https://changed.test' } });
    expect(moved.statusCode).toBe(200);
    expect(store.requestChoice(project.id, first.id)).toBeNull();
    expect((await assign(first.id, null)).json()).toMatchObject({ profileId: null });
  } finally { await app.close(); store.close(); }
});

test('can stop a run while the operating system is still opening a secret', async () => {
  const store = new Store(':memory:');
  const project = store.createProject('Отмена чтения секрета', '');
  store.addUrls(project.id, [{ input: 'https://example.test/protected', line: 1 }, { input: 'https://other.test/direct', line: 2 }]);
  store.saveRequestProfile(project.id, { ...profile, headers: [], auth: { kind: 'bearer', ref: 'fixture-ref' }, proxy: null });
  const [scoped, direct] = store.addresses(project.id);
  const first = store.enqueue(project.id, [scoped.id]);
  const next = store.enqueue(project.id, [direct.id]);
  let announceReading!: () => void;
  let releaseSecret!: (secret: string) => void;
  const reading = new Promise<void>(resolve => { announceReading = resolve; });
  const value = new Promise<string>(resolve => { releaseSecret = resolve; });
  const secrets: RequestSecrets = {
    mode: 'desktop', async save() { return 'fixture-ref'; }, async remove() {},
    read() { announceReading(); return value; },
  };
  const stop = startBackground(store, { requestSecrets: secrets, check: async url => ({
    status: 'ok', httpCode: 204, redirects: 0, durationMs: 1, finalUrl: url, contentType: null,
    contentLength: null, errorKind: null, error: null,
  }) });
  const app = createApp({ store, requestSecrets: secrets, onRunStopped: runId => stop.cancelRun(runId) });
  try {
    await reading;
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/runs/${first.id}/stop` });
    expect(result.statusCode).toBe(200);
    await expect.poll(() => store.run(next.id, project.id).status, { timeout: 2500 }).toBe('done');
    expect(store.run(first.id, project.id).completed).toBe(0);
  } finally {
    releaseSecret('secret');
    await stop();
    await app.close();
    store.close();
  }
});

test('validates request fields and supports Basic, Bearer and named API keys', async () => {
  const values = { PULSE_REQUEST_SECRET_TEST: 'fixture-token-19283' };
  const store = new Store(':memory:');
  const sent: Record<string, string>[] = [];
  const app = createApp({ store, requestSecrets: envRequestSecrets(values), checkRequest: (url, options) =>
    checkUrl(url, { ...options, resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (_url, _ips, _signal, _limit, _ca, _stream, headers) => {
        sent.push(headers);
        return { code: 401, headers: { 'content-type': 'echo:' + values.PULSE_REQUEST_SECRET_TEST } };
      } }),
  });
  const { id } = store.createProject('Авторизация', '');
  const path = `/api/projects/${id}/request-profiles`;
  const post = (data: RequestProfileInput) => app.inject({ method: 'POST', url: path, payload: data });
  const secret = { environment: 'PULSE_REQUEST_SECRET_TEST' };
  try {
    for (const patch of [
      { origin: 'http://example.test', auth: { kind: 'bearer', secret } },
      { origin: 'https://example.test:0' },
      { proxy: { url: 'http://proxy.example.test:8080', auth: { username: 'user', secret } } },
      { headers: [{ name: 'Foo', secret: false, value: 'one' }, { name: 'foo', secret: false, value: 'two' }] },
      { headers: [{ name: 'Host', secret: false, value: 'other.test' }] },
      { headers: [{ name: 'X-Test', secret: false, value: 'one\r\nX-Duplicate: yes' }] },
      { headers: [{ name: 'X-Test', secret: false, value: 'one\ttwo' }] },
      { headers: Array.from({ length: 5 }, (_, index) => ({ name: 'X-' + index, secret: false, value: 'A'.repeat(4000) })) },
      { auth: { kind: 'bearer', secret: { value: values.PULSE_REQUEST_SECRET_TEST } } },
    ] satisfies Partial<RequestProfileInput>[]) {
      expect((await post({ ...profile, ...patch })).statusCode).toBe(400);
    }
    for (const auth of [
      { kind: 'basic', username: 'operator', secret },
      { kind: 'bearer', secret },
      { kind: 'api-key', header: 'X-Api-Key', secret },
    ] satisfies RequestProfileInput['auth'][]) {
      const created = await post({ ...profile, origin: 'https://example.test.', isDefault: false, auth,
        headers: [{ name: 'User-Agent', secret: false, value: 'Pulse Fixture' },
          { name: '__proto__', secret: false, value: 'valid-header-name' }] });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain(values.PULSE_REQUEST_SECRET_TEST);
      expect(created.json().origin).toBe('https://example.test');
      const url = `${path}/${created.json().id}/test`;
      expect((await app.inject({ method: 'POST', url, payload: { url: 'https://other.test/' } })).statusCode).toBe(400);
      const result = await app.inject({ method: 'POST', url, payload: { url: 'https://example.test/private' } });
      expect(result.json()).toMatchObject({ httpCode: 401, failureStage: 'target', requestProfile: profile.name, requestRoute: 'direct' });
      expect(result.body).not.toContain(values.PULSE_REQUEST_SECRET_TEST);
    }
    expect(sent).toMatchObject([
      { 'user-agent': 'Pulse Fixture', authorization: 'Basic ' + Buffer.from('operator:' + values.PULSE_REQUEST_SECRET_TEST).toString('base64') },
      { 'user-agent': 'Pulse Fixture', authorization: 'Bearer ' + values.PULSE_REQUEST_SECRET_TEST },
      { 'user-agent': 'Pulse Fixture', 'x-api-key': values.PULSE_REQUEST_SECRET_TEST },
    ]);
    expect(sent.every(headers => Object.hasOwn(headers, '__proto__') && headers.__proto__ === 'valid-header-name')).toBe(true);
    const missing = await post({ ...profile, auth: { kind: 'bearer', secret: { environment: 'PULSE_REQUEST_SECRET_MISSING' } } });
    const result = await app.inject({ method: 'POST', url: `${path}/${missing.json().id}/test`, payload: { url: 'https://example.test/' } });
    expect(result.json()).toMatchObject({ httpCode: null, errorKind: 'configuration', failureStage: 'configuration' });
    expect(sent).toHaveLength(3);
  } finally { await app.close(); store.close(); }
});

test('replays a stopped run with current profile settings and retains protected configuration of queued runs', async () => {
  let now = Date.parse('2026-11-23T08:59:00Z');
  const store = new Store(':memory:', () => now);
  const values = new Map<string, string>();
  let nextRef = 0;
  const secrets: RequestSecrets = {
    mode: 'desktop',
    async save(input) {
      if (!('value' in input)) throw new Error();
      const ref = `fixture-vault-${++nextRef}`;
      values.set(ref, input.value);
      return ref;
    },
    async read(ref) { return values.get(ref); },
    async remove(ref) { values.delete(ref); },
  };
  const app = createApp({ store, requestSecrets: secrets });
  const { id } = store.createProject('Плановые и ручные проверки', '');
  const path = `/api/projects/${id}`;
  const profiles = `${path}/request-profiles`;
  const create = (value: string) => ({ ...profile, headers: [{ name: 'X-Token', secret: true, value }] });
  const oldSecret = 'vault-original-token';
  const newSecret = 'vault-replacement-token';
  const errors: unknown[] = [];
  let stop: (() => Promise<void>) | undefined;
  try {
    const created = await app.inject({ method: 'POST', url: profiles, payload: create(oldSecret) });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toMatch(/vault-original-token|fixture-vault-/);
    const profileId = created.json().id;
    store.addUrls(id, [{ input: 'https://example.test/scoped', line: 1 }, { input: 'https://example.test/direct', line: 2 }]);
    const [scoped, direct] = store.addresses(id);
    store.saveRequestChoice(id, scoped.id, profileId);
    store.saveRequestChoice(id, direct.id, null);
    const group = store.saveGroup(id, 'Один адрес');
    store.changeGroupMembers(id, group.id, 'add', [scoped.id]);
    const pending = store.enqueueGroup(id, group.id);
    const stopped = store.enqueue(id);
    store.stopRun(id, stopped.id);
    const updated = await app.inject({ method: 'PATCH', url: `${profiles}/${profileId}`, payload: create(newSecret) });
    expect(updated.statusCode).toBe(200);
    expect([...values.values()]).toEqual([oldSecret, newSecret]);
    const replay = store.restartRun(id, stopped.id);
    store.saveSettings(id, { schedule: { weekdays: [1], time: '09:00', timezone: 'UTC' }, notify: 'all', email: null });
    now = Date.parse('2026-11-23T09:00:00Z');
    store.enqueueDue();
    const scheduled = store.runs(id).find(run => run.source === 'schedule')!;
    const transmitted = new Map<string, (string | undefined)[]>();
    stop = startBackground(store, { requestSecrets: secrets, reportError: error => errors.push(error),
      check: (url, tlsProfile, signal, requestOptions) => checkUrl(url, { tlsProfile, signal, requestOptions,
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async (_url, _ips, _signal, _limit, _ca, _stream, headers) => {
          const tokens = transmitted.get(_url.pathname) ?? [];
          tokens.push(headers['x-token']);
          transmitted.set(_url.pathname, tokens);
          return { code: 200, headers: { 'content-type': headers['x-token'] } };
        },
      }),
    });
    await expect.poll(() => store.run(scheduled.id, id).status, { timeout: 4000 }).toBe('done');
    expect(store.run(pending.id, id)).toMatchObject({ status: 'done', total: 1 });
    expect(store.run(replay.id, id)).toMatchObject({ status: 'done', total: 2 });
    expect(transmitted.get('/scoped')).toEqual([oldSecret, newSecret, newSecret]);
    expect(transmitted.get('/direct')).toEqual([undefined, undefined]);
    expect([...values.values()]).toEqual([newSecret]);
    for (const route of [`/runs/${pending.id}`, `/runs/${replay.id}/export?format=json`, '/export?format=csv', '/export?format=excel']) {
      const response = await app.inject({ method: 'GET', url: path + route });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(profile.name);
      expect(response.body).not.toMatch(/vault-original-token|vault-replacement-token|fixture-vault-/);
    }
    expect((await app.inject({ method: 'DELETE', url: `${profiles}/${profileId}` })).json()).toEqual({ deleted: true });
    expect(values.size).toBe(0);
    expect(store.requestChoice(id, scoped.id)).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await stop?.();
    await app.close();
    store.close();
  }
});
