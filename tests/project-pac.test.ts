import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { startBackground } from '../src/server/worker.js';
import { desktopRequest } from '../src/desktop/contracts.js';
import { MAX_PAC_BYTES } from '../src/shared/pac.js';
import { parsePacFile } from '../src/server/pac-config.js';
import type { RequestSecrets } from '../src/server/request-secrets.js';

const pacFile = (route: string) => ({
  filename: 'work.pac',
  source: `function FindProxyForURL(url, host) { return ${JSON.stringify(route)}; }`,
});

test('uses UTF-8 bytes for the PAC size limit and rejects invalid local names', () => {
  const source = 'я'.repeat(MAX_PAC_BYTES / 2);
  const first = parsePacFile('маршрут.PAC', source);
  expect(parsePacFile('маршрут.PAC', source).revision).toBe(first.revision);
  expect(parsePacFile('резерв.pac', source).revision).not.toBe(first.revision);
  for (const file of ['work.txt', 'folder/work.pac', 'folder\\work.pac']) {
    expect(() => parsePacFile(file, source)).toThrow(/расширением/);
  }
  for (const contents of [source + 'я', ' ', '\0']) {
    expect(() => parsePacFile('work.pac', contents)).toThrow(/256 КиБ/);
  }
});

test('versions local PAC files per project without exposing their source in the API', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Рабочий прокси', '');
    const other = store.createProject('Другой проект', '');
    const path = `/api/projects/${id}/proxy-pac`;
    const otherPath = `/api/projects/${other.id}/proxy-pac`;
    const first = pacFile('PROXY proxy.example:8080; DIRECT');
    const upload = (payload: { filename: string; source: string }) => app.inject({ method: 'PUT', url: path, payload });
    expect((await app.inject(path)).json()).toEqual({ pac: null });
    const saved = await upload(first);
    expect(saved.statusCode).toBe(200);
    const metadata = saved.json().pac;
    expect(metadata).toEqual({ filename: first.filename, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await app.inject(otherPath)).json()).toEqual({ pac: null });
    expect((await app.inject({ method: 'PUT', url: otherPath, payload: first })).json()).toEqual({ pac: metadata });
    const preview = await app.inject({ method: 'POST', url: path + '/test', payload: { url: 'https://example.test/list' } });
    expect(preview.json()).toEqual({ routes: [{ kind: 'proxy', url: 'http://proxy.example:8080' }, { kind: 'direct' }], source: 'pac' });
    expect((await app.inject({ method: 'POST', url: path + '/test', payload: { url: 'http://example.test/' } })).statusCode).toBe(400);
    const broken = await upload({ ...first, source: 'function FindProxyForURL(' });
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toContain('function FindProxyForURL(');
    expect((await app.inject(path)).json()).toEqual({ pac: metadata });
    store.addUrls(id, [{ input: 'https://example.test/list', line: 1 }]);
    const oldRun = store.enqueue(id);
    const newFile = pacFile('DIRECT');
    expect((await upload(newFile)).statusCode).toBe(200);
    const newRun = store.enqueue(id);
    expect(oldRun.id).not.toEqual(newRun.id);
    expect(store.pacSnapshot(oldRun.id)?.source).toBe(first.source);
    expect(store.pacSnapshot(newRun.id)?.source).toBe(newFile.source);
    expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ pac: null });
    expect((await app.inject(otherPath)).json()).toEqual({ pac: metadata });
    expect(store.pacSnapshot(oldRun.id)?.revision).toBe(metadata.revision);
    expect(store.pacSnapshot(store.enqueue(id).id)).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: path + '/test', payload: { url: 'https://example.test/' } })).statusCode).toBe(404);
  } finally { await app.close(); store.close(); }
});

test('uses PAC in manual and scheduled runs, preserving the HTTP profile and explicit direct choice', async () => {
  let now = Date.parse('2026-11-23T08:59:00Z');
  const store = new Store(':memory:', () => now);
  const app = createApp({ store });
  let stop: (() => Promise<void>) | undefined;
  try {
    const { id } = store.createProject('Маршруты', '');
    const path = `/api/projects/${id}`;
    expect((await app.inject({ method: 'PUT', url: path + '/proxy-pac', payload: pacFile('PROXY pac.example:8080') })).statusCode).toBe(200);
    store.addUrls(id, [
      { input: 'https://example.test/with-header', line: 1 },
      { input: 'https://example.test/direct', line: 2 },
      { input: 'https://fixed.test/with-proxy', line: 3 },
      { input: 'https://ordinary.test/inherited', line: 4 },
    ]);
    const headers = [{ name: 'accept', value: 'application/json' }];
    store.saveRequestProfile(id, { name: 'Заголовок', origin: 'https://example.test', isDefault: true, headers, auth: { kind: 'none' }, proxy: null });
    store.saveRequestProfile(id, { name: 'Прокси', origin: 'https://fixed.test', isDefault: true, headers: [],
      auth: { kind: 'none' }, proxy: { url: 'https://fixed-proxy.test' } });
    store.saveRequestChoice(id, store.addresses(id)[1].id, null);
    const preview = (url: string) => app.inject({ method: 'POST', url: path + '/proxy-pac/test', payload: { url } });
    expect((await preview('https://example.test/direct')).json()).toEqual({
      routes: [{ kind: 'direct' }], source: 'direct',
    });
    expect((await preview('https://fixed.test/with-proxy')).json()).toEqual({
      routes: [{ kind: 'proxy', url: 'https://fixed-proxy.test' }], source: 'profile',
    });
    const manual = store.enqueue(id);
    expect((await app.inject({ method: 'PUT', url: path + '/proxy-pac', payload: pacFile('HTTPS later.example:8443') })).statusCode).toBe(200);
    store.saveSettings(id, { schedule: { weekdays: [1], time: '09:00', timezone: 'UTC' }, notify: 'off', email: null });
    now = Date.parse('2026-11-23T09:00:00Z');
    store.enqueueDue();
    const scheduled = store.runs(id).find(run => run.source === 'schedule')!;
    const calls = new Map<string, { proxy?: string; accept?: string; source: 'pac' | 'profile' | null }[]>();
    const errors: unknown[] = [];
    stop = startBackground(store, { reportError: error => errors.push(error), async check(url, _tls, signal, options, resolvePac) {
      const route = options?.proxy?.url ? undefined : (await resolvePac?.(new URL(url), signal))?.[0];
      const proxy = options?.proxy?.url ?? (route?.kind === 'proxy' ? route.url : undefined);
      const source = options?.proxy ? 'profile' : resolvePac ? 'pac' : null;
      const key = new URL(url).pathname;
      const seen = calls.get(key) ?? [];
      seen.push({ proxy, accept: options?.headers.accept, source });
      calls.set(key, seen);
      return { status: 'ok', httpCode: 204, durationMs: 1, finalUrl: url, redirects: 0, contentType: null,
        contentLength: null, errorKind: null, error: null, requestProxy: proxy ?? null, requestSource: source,
        requestRoute: proxy ? 'proxy' : undefined };
    } });
    await expect.poll(() => store.run(scheduled.id, id).status, { timeout: 4000 }).toBe('done');
    expect(store.run(manual.id, id).status).toBe('done');
    const routes = ['http://pac.example:8080', 'https://later.example:8443'];
    expect(calls.get('/with-header')).toEqual(routes.map(proxy => ({ proxy, accept: 'application/json', source: 'pac' })));
    expect(calls.get('/inherited')).toEqual(routes.map(proxy => ({ proxy, accept: undefined, source: 'pac' })));
    expect(calls.get('/direct')).toEqual(Array(2).fill({ proxy: undefined, accept: undefined, source: null }));
    expect(calls.get('/with-proxy')).toEqual(Array(2).fill({ proxy: 'https://fixed-proxy.test', accept: undefined, source: 'profile' }));
    expect(errors).toEqual([]);
    expect(store.runResults(manual.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.test/direct', requestRoute: 'direct', requestSource: null }),
    ]));
    const report = (await app.inject(path + '/runs/' + manual.id)).json();
    expect(JSON.stringify(report)).toContain('http://pac.example:8080');
    expect(JSON.stringify(report)).not.toContain('FindProxyForURL');
    const csv = (await app.inject(path + '/export?format=csv')).body;
    expect(csv).toContain('requestProxy');
    expect(csv).toContain('http://pac.example:8080');
  } finally {
    await stop?.();
    await app.close();
    store.close();
  }
});

test('only allows the scoped PAC commands through the Electron request bridge', () => {
  const path = '/api/projects/3/proxy-pac';
  expect(desktopRequest({ method: 'PUT', path, body: '{}' }).path).toBe(path);
  expect(desktopRequest({ method: 'PATCH', path, body: '{}' }).path).toBe(path);
  expect(desktopRequest({ method: 'POST', path: path + '/test' }).path).toBe(path + '/test');
  expect(() => desktopRequest({ method: 'PUT', path: '/api/projects/3/settings' })).toThrow();
  expect(() => desktopRequest({ method: 'GET', path: '/api/projects/0/proxy-pac' })).toThrow();
});

test('versions trusted proxy rules and keeps a desktop password until the queued run is stopped', async () => {
  const values = new Map<string, string>();
  let nextReference = 0;
  const secrets: RequestSecrets = {
    mode: 'desktop',
    async save(input) {
      if (!('value' in input)) throw new Error('Use a desktop value');
      const ref = 'desktop-00000000-0000-4000-8000-' + String(++nextReference).padStart(12, '0');
      values.set(ref, input.value);
      return ref;
    },
    async read(ref) { return values.get(ref); },
    async remove(ref) { values.delete(ref); },
  };
  const store = new Store(':memory:');
  const app = createApp({ store, requestSecrets: secrets });
  try {
    const { id } = store.createProject('Office', '');
    const other = store.createProject('Other', '').id;
    const path = `/api/projects/${id}/proxy-pac`;
    const file = pacFile('HTTPS proxy.office.test:8443');
    const upload = (url = path) => app.inject({ method: 'PUT', url, payload: file });
    const original = (await upload()).json().pac;
    await upload(`/api/projects/${other}/proxy-pac`);
    const proxy = { url: 'https://PROXY.office.test:8443/', allowPrivate: true, connectByHostname: true };
    const patch = (revision: string, replacement: unknown[]) => app.inject({
      method: 'PATCH', url: path, payload: { revision, proxies: replacement },
    });
    const first = await patch(original.revision, [{ ...proxy, auth: { username: 'alice', secret: { value: 'first-fixture-value' } } }]);
    expect(first.statusCode).toBe(200);
    expect(first.json().pac.proxies).toEqual([{ ...proxy, url: 'https://proxy.office.test:8443', auth: { username: 'alice', configured: true } }]);
    expect(first.body).not.toMatch(/first-fixture-value|desktop-00000000/);
    expect(first.json().pac.revision).not.toBe(original.revision);
    expect((await app.inject(`/api/projects/${other}/proxy-pac`)).json().pac).toEqual(original);
    expect((await upload()).json().pac).toEqual(first.json().pac);
    expect([...values.values()]).toEqual(['first-fixture-value']);
    store.addUrls(id, [{ input: 'https://public.example/', line: 1 }]);
    const run = store.enqueue(id);
    const second = await patch(first.json().pac.revision, [{ ...proxy, auth: { username: 'alice', secret: { value: 'second-fixture-value' } } }]);
    expect(second.statusCode).toBe(200);
    expect(second.json().pac.revision).not.toBe(first.json().pac.revision);
    expect(store.pacSnapshot(run.id)?.revision).toBe(first.json().pac.revision);
    expect([...values.values()]).toEqual(['first-fixture-value', 'second-fixture-value']);
    expect((await patch(first.json().pac.revision, [])).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ pac: null });
    expect([...values.values()]).toEqual(['first-fixture-value']);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/runs/${run.id}/stop` })).statusCode).toBe(200);
    expect([...values.values()]).toEqual([]);
  } finally { await app.close(); store.close(); }
});

test('validates scheme, authority and uniqueness of trusted proxies', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Office', '');
    const url = `/api/projects/${id}/proxy-pac`;
    const { revision } = (await app.inject({ method: 'PUT', url, payload: pacFile('DIRECT') })).json().pac;
    const proxy = { url: 'http://proxy.office.test:8080', allowPrivate: true, connectByHostname: true };
    for (const proxies of [
      [{ ...proxy, url: 'http://user:password@proxy.office.test:8080' }],
      [{ ...proxy, url: 'https://proxy.office.test/path' }],
      [{ ...proxy, auth: { username: 'alice', secret: { environment: 'PULSE_REQUEST_SECRET_FIXTURE' } } }],
      [proxy, { ...proxy, url: 'http://PROXY.office.test:8080/' }],
    ]) {
      expect((await app.inject({ method: 'PATCH', url, payload: { revision, proxies } })).statusCode).toBe(400);
    }
    expect((await app.inject(url)).json().pac).toEqual({ filename: 'work.pac', revision });
  } finally { await app.close(); store.close(); }
});

test('previews only literal proxy IPs permitted by the matching trust rule', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Private route', '');
    const url = `/api/projects/${id}/proxy-pac`;
    for (const [host, allowPrivate, status] of [
      ['10.1.2.3', false, 400], ['10.1.2.3', true, 200], ['127.0.0.1', true, 400], ['169.254.1.1', true, 400],
    ] as const) {
      const { revision } = (await app.inject({ method: 'PUT', url, payload: pacFile(`PROXY ${host}:8080`) })).json().pac;
      expect((await app.inject({ method: 'PATCH', url, payload: { revision, proxies: [
        { url: `http://${host}:8080`, allowPrivate, connectByHostname: true },
      ] } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: url + '/test', payload: { url: 'https://example.test/' } })).statusCode).toBe(status);
    }
  } finally { await app.close(); store.close(); }
});
