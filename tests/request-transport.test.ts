import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type RequestOptions, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { checkUrl } from '../src/server/checker.js';
import { createApp } from '../src/server/app.js';
import { PacError } from '../src/server/pac.js';
import { Store } from '../src/server/store.js';
import type { ResolvedRequestOptions } from '../src/shared/request-profiles.js';
import { fixtureCertificate as cert } from './fixtures/tls-certificate.js';

const resolve = async () => [{ address: '192.0.2.10', family: 4 }];
const checkedAddress = async () => [{ address: '8.8.4.4', family: 4 }];
const profile: ResolvedRequestOptions = {
  profileName: 'Site profile',
  origin: 'https://target.example',
  headers: { 'User-Agent': 'Pulse test monitor', Authorization: 'Bearer fixture-secret', 'X-Region': 'test' },
  protectedValues: ['fixture-secret', 'Bearer fixture-secret'],
};

test.each([
  ['same origin', 'https://target.example/next', true],
  ['different scheme', 'http://target.example/next', false],
  ['different host', 'https://other.example/next', false],
  ['different port', 'https://target.example:9443/next', false],
])('applies profile headers on each hop with %s', async (_scope, next, forward) => {
  const sent: Record<string, string>[] = [];
  const result = await checkUrl('https://target.example/', {
    resolve: checkedAddress,
    requestOptions: profile,
    request: async (url, _addresses, _signal, _maxBytes, _ca, _stream, headers) => {
      sent.push(headers);
      return url.pathname === '/' ? { code: 302, headers: { location: next } } : { code: 204, headers: {} };
    },
  });
  expect(result).toMatchObject({ status: 'ok', requestProfile: 'Site profile', requestRoute: 'direct', failureStage: null });
  expect(sent).toEqual([
    { 'user-agent': 'Pulse test monitor', authorization: 'Bearer fixture-secret', accept: '*/*', connection: 'close', 'x-region': 'test' },
    forward
      ? { 'user-agent': 'Pulse test monitor', authorization: 'Bearer fixture-secret', accept: '*/*', connection: 'close', 'x-region': 'test' }
      : { 'user-agent': 'URL-Pulse/1.0', accept: '*/*', connection: 'close' },
  ]);
});

test('keeps a target authorization failure in the target HTTP result and strips echoed secrets', async () => {
  const result = await checkUrl('https://target.example/', {
    resolve: checkedAddress,
    requestOptions: profile,
    request: async url => url.pathname === '/'
      ? { code: 302, headers: { location: '/denied?reason=Bearer%20fixture-secret' } }
      : { code: 403, headers: { 'content-type': 'text/plain; echo=fixture-secret', 'content-length': 'fixture-secret' } },
  });
  expect(result).toMatchObject({ httpCode: 403, errorKind: 'http', failureStage: 'target', proxyHttpCode: null });
  expect(result.finalUrl).toContain('/denied?reason=');
  expect(result.contentType).toContain('text/plain');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('keeps a proxy DNS rejection on the chosen route', async () => {
  const result = await checkUrl('https://target.example/', {
    resolve: host => host === 'proxy.example' ? resolve() : checkedAddress(),
    requestOptions: { ...profile, proxy: { url: 'http://proxy.example:8080' } },
    request: async () => ({ code: 204, headers: {} }),
  });
  expect(result).toMatchObject({ httpCode: null, errorKind: 'proxy', requestRoute: 'proxy', failureStage: 'proxy' });
});

test.each([
  ['http://proxy.example:8080', 'Basic fixture-proxy-auth'],
  ['https://username:password@proxy.example:8443', undefined],
])('rejects unsafe proxy configuration for %s before DNS', async (url, authorization) => {
  const hosts: string[] = [];
  const result = await checkUrl('https://target.example/', {
    resolve: async host => {
      hosts.push(host);
      return checkedAddress();
    },
    requestOptions: { ...profile, proxy: { url, authorization } },
    request: async () => ({ code: 204, headers: {} }),
  });
  expect(result).toMatchObject({ requestRoute: 'proxy', errorKind: 'configuration', failureStage: 'configuration' });
  expect(hosts).toEqual([]);
});


// These test-only credentials identify the local fixtures as target.example and proxy.example.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgmGUTLTibDhidxCvJ
SsroEs3fBm8D1l2N4rzLOw+Wv7KhRANCAAR09p0gT93bws63Qs2Sw3nmSLlxgoOI
MMvWdZ8++OlpXOPT2xpVrUeqng35tfHZT82R3lIT5V1L8e5bYSTXc2x5
-----END PRIVATE KEY-----`;
const servers: Server[] = [];
const sockets = new Set<Socket>();
const fixtureTrustRoots = getCACertificates('default');
const proxyAddress = '8.8.8.8';
const privateProxyAddress = '10.10.0.7';
const targetAddress = '8.8.4.4';
let sitemapNetwork = false;

vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: (...args: Parameters<typeof actual.lookup>) =>
    sitemapNetwork ? Promise.resolve([{ address: args[0] === 'proxy.example' ? proxyAddress : targetAddress, family: 4 }])
      : actual.lookup(...args) };
});

function fixtureProxyOptions(options: RequestOptions): RequestOptions {
  if (sitemapNetwork && options.method === 'GET' && !('createConnection' in options)) {
    throw new Error('The sitemap fixture must use its local proxy');
  }
  if (options.method !== 'CONNECT') return options;
  return {
    ...options,
    // Keep production DNS validation and pinning, then route the validated proxy IP to the local fixture.
    lookup(hostname, lookupOptions, callback) {
      if (!options.lookup) throw new Error('The proxy socket must use a pinned DNS result');
      options.lookup(hostname, { all: false }, (error, address, family) => {
        if (error || (address !== proxyAddress && address !== privateProxyAddress) || family !== 4) {
          callback(new Error('Unexpected proxy address'), '', 4);
          return;
        }
        if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      });
    },
  };
}

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, request: (options: RequestOptions, callback?: Parameters<typeof actual.request>[2]) =>
    actual.request(fixtureProxyOptions(options), callback) };
});
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: (options: RequestOptions, callback?: Parameters<typeof actual.request>[2]) =>
    actual.request(fixtureProxyOptions(options), callback) };
});

async function listen(server: Server) {
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  sitemapNetwork = false;
  setDefaultCACertificates(fixtureTrustRoots);
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const resolveFixtures = async (host: string) => [{ address: host.includes('proxy') ? proxyAddress : targetAddress, family: 4 }];
const unusedDirectRequest = async () => ({ code: 204, headers: {} });
const proxyAuthorization = 'Basic Zml4dHVyZTpmaXh0dXJlLXBhc3N3b3Jk';

vi.mock('../src/server/tls-profile.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server/tls-profile.js')>();
  return { ...actual, russianTrustRoots: () => [...fixtureTrustRoots, cert] };
});

function attachTunnelFixture(proxy: Server, targetPort: number) {
  const connections: { authority?: string; headers: IncomingHttpHeaders }[] = [];
  proxy.on('connect', (request, client, head) => {
    connections.push({ authority: request.url, headers: request.headers });
    const target = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(client).pipe(target);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    client.on('close', () => target.destroy());
  });
  return connections;
}

test('sends CONNECT to the validated target IP and isolates proxy authentication from site headers', async () => {
  setDefaultCACertificates([...fixtureTrustRoots, cert]);
  const targetHeaders: IncomingHttpHeaders[] = [];
  const targetNames: (string | false | null)[] = [];
  const targetPort = await listen(createTlsServer({ key, cert }, (request, response) => {
    targetHeaders.push(request.headers);
    targetNames.push((request.socket as TLSSocket).servername ?? null);
    response.writeHead(204).end();
  }));
  const proxy = createTlsServer({ key, cert });
  const connections = attachTunnelFixture(proxy, targetPort);
  const proxyPort = await listen(proxy);
  const origin = `https://target.example:${targetPort}`;
  const result = await checkUrl(origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    requestOptions: {
      ...profile, origin,
      proxy: { url: `https://proxy.example:${proxyPort}`, authorization: proxyAuthorization },
    },
  });
  expect(result).toMatchObject({ status: 'ok', requestRoute: 'proxy', httpCode: 204, failureStage: null });
  expect(connections).toHaveLength(1);
  expect(connections[0].authority).toBe(`${targetAddress}:${targetPort}`);
  expect(connections[0].headers).toMatchObject({
    host: `${targetAddress}:${targetPort}`,
    'proxy-authorization': proxyAuthorization,
  });
  expect(connections[0].headers).not.toHaveProperty('authorization');
  expect(connections[0].headers).not.toHaveProperty('x-region');
  expect(targetNames).toEqual(['target.example']);
  expect(targetHeaders).toEqual([{
    'user-agent': 'Pulse test monitor',
    accept: '*/*',
    connection: 'close',
    authorization: 'Bearer fixture-secret',
    host: `target.example:${targetPort}`,
    'x-region': 'test',
  }]);
});

test('reports CONNECT 407 without exposing the proxy response or checking the target directly', async () => {
  const proxy = createServer();
  proxy.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 407 fixture-secret\r\nContent-Length: 0\r\n\r\n');
  });
  const port = await listen(proxy);
  const request = vi.fn(unusedDirectRequest);
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    requestOptions: { ...profile, proxy: { url: `http://proxy.example:${port}` } },
    request,
  });
  expect(result).toMatchObject({ requestRoute: 'proxy', httpCode: null, errorKind: 'proxy', proxyHttpCode: 407, failureStage: 'proxy' });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(request).not.toHaveBeenCalled();
});

test('the overall deadline aborts an unfinished CONNECT on the proxy stage', async () => {
  const proxy = createServer();
  proxy.on('connect', () => {});
  const port = await listen(proxy);
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    timeoutMs: 50,
    requestOptions: { ...profile, proxy: { url: `http://proxy.example:${port}` } },
  });
  expect(result).toMatchObject({ requestRoute: 'proxy', httpCode: null, errorKind: 'timeout', failureStage: 'proxy' });
});

test('validates the TLS certificate against the HTTPS proxy name', async () => {
  setDefaultCACertificates([...fixtureTrustRoots, cert]);
  const proxy = createTlsServer({ key, cert });
  const port = await listen(proxy);
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    requestOptions: { ...profile, proxy: { url: `https://invalid-proxy.example:${port}` } },
  });
  expect(result).toMatchObject({
    requestRoute: 'proxy', httpCode: null, errorKind: 'proxy', failureStage: 'proxy', tlsCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
  });
});

test('removes configured credentials echoed with mixed percent escapes', async () => {
  const secret = "local'fixture+key=value";
  const result = await checkUrl('https://target.example/', {
    resolve: checkedAddress,
    requestOptions: { ...profile, headers: { 'X-Key': secret }, protectedValues: [secret] },
    request: async url => url.pathname === '/'
      ? { code: 302, headers: { location: "/next?echo=local'fixture+key=value" } }
      : { code: 200, headers: { 'content-type': "text/plain; echo=local%27fixture%2bkey=value" } },
  });
  expect(result.status).toBe('ok');
  expect(JSON.stringify(result)).not.toContain('local%27fixture');
});


test('validates the target certificate against the original hostname after CONNECT', async () => {
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const proxy = createServer();
  const connections = attachTunnelFixture(proxy, targetPort);
  const proxyPort = await listen(proxy);
  const origin = `https://different-target.example:${targetPort}`;
  const result = await checkUrl(origin, {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    requestOptions: { ...profile, origin, proxy: { url: `http://proxy.example:${proxyPort}` } },
  });
  expect(connections).toHaveLength(1);
  expect(result).toMatchObject({ errorKind: 'tls', failureStage: 'target', tlsCode: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('does not give the additional project TLS roots to an HTTPS proxy', async () => {
  const proxyPort = await listen(createTlsServer({ key, cert }));
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    requestOptions: { ...profile, proxy: { url: `https://proxy.example:${proxyPort}` } },
  });
  expect(result).toMatchObject({ errorKind: 'proxy', failureStage: 'proxy', tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
});

test('validates redirect DNS before opening another tunnel', async () => {
  const port = await listen(createTlsServer({ key, cert }, (_request, response) =>
    response.writeHead(302, { location: 'https://refused-target.example/other' }).end()));
  const proxy = createServer();
  const connections = attachTunnelFixture(proxy, port);
  const proxyPort = await listen(proxy);
  const origin = `https://target.example:${port}`;
  const result = await checkUrl(origin, {
    resolve: host => host === 'refused-target.example' ? resolve() : resolveFixtures(host),
    tlsProfile: 'russian-ca',
    requestOptions: { ...profile, origin, proxy: { url: `http://proxy.example:${proxyPort}` } },
  });
  expect(connections).toHaveLength(1);
  expect(result).toMatchObject({ requestRoute: 'proxy', redirects: 1, httpCode: null, errorKind: 'blocked', failureStage: 'target' });
});

test('aborting an already open tunnel closes the connection to the proxy', async () => {
  const controller = new AbortController();
  const proxy = createServer();
  const tunnel = new Promise<Duplex>(resolve => proxy.on('connect', (_request, socket) => {
    socket.once('error', () => {});
    socket.once('end', () => socket.end());
    socket.once('data', () => resolve(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.resume();
  }));
  const proxyPort = await listen(proxy);
  const checking = checkUrl(profile.origin, {
    resolve: resolveFixtures,
    signal: controller.signal,
    requestOptions: { ...profile, proxy: { url: `http://proxy.example:${proxyPort}` } },
  });
  const socket = await tunnel;
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  controller.abort();
  const result = await checking;
  await closed;
  expect(result).toMatchObject({ requestRoute: 'proxy', httpCode: null, failureStage: 'target' });
});

test('re-evaluates PAC for the normalized redirect and tunnels the chosen HTTPS hop', async () => {
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const proxy = createServer();
  const connections = attachTunnelFixture(proxy, targetPort);
  const proxyPort = await listen(proxy);
  const target = `https://target.example:${targetPort}/next`;
  const endpoint = `http://proxy.example:${proxyPort}`;
  const evaluated: string[] = [];
  const result = await checkUrl('https://first.example/', {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    request: async () => ({ code: 302, headers: { location: target + '#ignored' } }),
    pac: async url => {
      evaluated.push(url.href);
      return url.hostname === 'first.example' ? [{ kind: 'direct' }] : [{ kind: 'proxy', url: endpoint }];
    },
  });
  expect(evaluated).toEqual(['https://first.example/', target]);
  expect(connections.map(connection => connection.authority)).toEqual([`${targetAddress}:${targetPort}`]);
  expect(result).toMatchObject({ status: 'ok', requestSource: 'pac', requestRoute: 'proxy', requestProxy: endpoint, httpCode: 204 });
});

test('uses an explicit DIRECT after a PAC proxy DNS failure', async () => {
  const result = await checkUrl(profile.origin, {
    resolve: host => host === 'missing-proxy.example' ? Promise.resolve([]) : resolveFixtures(host),
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: 'http://missing-proxy.example:8080' }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({ status: 'ok', requestSource: 'pac', requestRoute: 'direct', requestProxy: null, httpCode: 204 });
});

test('uses the next PAC route after a proxy connection times out with time remaining', async () => {
  const proxy = createServer();
  proxy.on('connect', () => {});
  const port = await listen(proxy);
  const endpoint = `http://proxy.example:${port}`;
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    timeoutMs: 500,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({ status: 'ok', requestSource: 'pac', requestRoute: 'direct', httpCode: 204 });
});

test('uses the next PAC proxy after a connection ends before its CONNECT response', async () => {
  const unavailable = createServer();
  unavailable.on('connect', (_request, socket) => socket.destroy());
  const first = `http://proxy.example:${await listen(unavailable)}`;
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const available = createServer();
  const connections = attachTunnelFixture(available, targetPort);
  const second = `http://proxy.example:${await listen(available)}`;
  const result = await checkUrl(`https://target.example:${targetPort}`, {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    pac: async () => [{ kind: 'proxy', url: first }, { kind: 'proxy', url: second }],
  });
  expect(connections).toHaveLength(1);
  expect(result).toMatchObject({ status: 'ok', requestRoute: 'proxy', requestProxy: second, httpCode: 204 });
});

test('downloads the root and nested sitemap via the configured project PAC in the quick import API', async () => {
  sitemapNetwork = true;
  setDefaultCACertificates([...fixtureTrustRoots, cert]);
  const requests: string[] = [];
  const targetServer = createTlsServer({ key, cert }, (request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/xml');
    response.end(request.url === '/index.xml'
      ? `<sitemapindex><sitemap><loc>https://target.example:${targetPort}/nested.xml</loc></sitemap></sitemapindex>`
      : '<urlset><url><loc>https://example.test/from-pac</loc></url></urlset>');
  });
  const targetPort = await listen(targetServer);
  const tlsProxy = createTlsServer({ key, cert });
  const connections = attachTunnelFixture(tlsProxy, targetPort);
  const proxyPort = await listen(tlsProxy);
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Sitemaps', '');
    const path = `/api/projects/${id}`;
    const uploaded = await app.inject({ method: 'PUT', url: path + '/proxy-pac', payload: {
      filename: 'office.pac', source: `function FindProxyForURL() { return 'HTTPS proxy.example:${proxyPort}'; }`,
    } });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const result = await app.inject({ method: 'POST', url: path + '/urls/sitemap',
      payload: { url: `https://target.example:${targetPort}/index.xml` } });
    expect(result.json()).toMatchObject({ added: 1, documents: 2 });
    expect(requests).toEqual(['/index.xml', '/nested.xml']);
    expect(connections.map(entry => entry.authority)).toEqual(Array(2).fill(`${targetAddress}:${targetPort}`));
  } finally { await app.close(); store.close(); }
});

test('uses CONNECT by hostname for a matching private corporate PAC proxy', async () => {
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const proxy = createServer();
  const connections = attachTunnelFixture(proxy, targetPort);
  const endpoint = `http://proxy.example:${await listen(proxy)}`;
  const rule = { url: endpoint, allowPrivate: true, connectByHostname: true };
  const options = {
    tlsProfile: 'russian-ca' as const,
    resolve: async (host: string) => [{ address: host === 'proxy.example' ? privateProxyAddress : targetAddress, family: 4 }],
    pac: async () => [{ kind: 'proxy' as const, url: endpoint }],
  };
  const url = `https://target.example:${targetPort}/`;
  const result = await checkUrl(url, {
    ...options, pacProxy: { rules: new Map([[endpoint, rule]]), async readSecret() { return undefined; } },
  });
  expect(result).toMatchObject({ httpCode: 204, requestRoute: 'proxy', requestProxy: endpoint });
  expect(connections.map(entry => entry.authority)).toEqual([`target.example:${targetPort}`]);
  const differentScheme = endpoint.replace('http:', 'https:');
  const mismatch = await checkUrl(url, {
    ...options, pacProxy: { rules: new Map([[differentScheme, { ...rule, url: differentScheme }]]), async readSecret() { return undefined; } },
  });
  expect(mismatch).toMatchObject({ errorKind: 'proxy', failureStage: 'proxy', httpCode: null });
  expect(connections).toHaveLength(1);
  const loopback = await checkUrl(url, {
    ...options,
    resolve: async (host: string) => [{ address: host === 'proxy.example' ? '127.0.0.1' : targetAddress, family: 4 }],
    pacProxy: { rules: new Map([[endpoint, rule]]), async readSecret() { return undefined; } },
  });
  expect(loopback).toMatchObject({ errorKind: 'proxy', failureStage: 'proxy', httpCode: null });
  expect(connections).toHaveLength(1);
});

test('sends Basic over TLS only to its matching PAC proxy, even on fallback', async () => {
  setDefaultCACertificates([...fixtureTrustRoots, cert]);
  const tlsProxy = createTlsServer({ key, cert });
  const received: IncomingHttpHeaders[] = [];
  tlsProxy.on('connect', (request, socket) => { received.push(request.headers); socket.destroy(); });
  const first = `https://proxy.example:${await listen(tlsProxy)}`;
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const next = createServer();
  const connections = attachTunnelFixture(next, targetPort);
  const second = `http://proxy.example:${await listen(next)}`;
  const rule = { url: first, allowPrivate: false, connectByHostname: false, auth: { username: 'fixture', ref: 'proxy-credential' } };
  const target = `https://target.example:${targetPort}/`;
  const options = {
    resolve: resolveFixtures,
    pac: async () => [{ kind: 'proxy' as const, url: first }, { kind: 'proxy' as const, url: second }],
  };
  const result = await checkUrl(target, {
    ...options, pacProxy: { rules: new Map([[first, rule]]), async readSecret(ref) {
      return ref === 'proxy-credential' ? 'fixture-password' : undefined;
    } },
  });
  expect(result).toMatchObject({ httpCode: 204, requestProxy: second });
  expect(received[0]?.['proxy-authorization']).toBe(proxyAuthorization);
  expect(connections[0].headers).not.toHaveProperty('proxy-authorization');
  expect(JSON.stringify(result)).not.toContain('fixture-password');
  const missing = await checkUrl(target, {
    ...options, pacProxy: { rules: new Map([[first, rule]]), async readSecret() { return undefined; } },
  });
  expect(missing).toMatchObject({ errorKind: 'configuration', failureStage: 'configuration', requestProxy: first });
  expect(received).toHaveLength(1);
  expect(connections).toHaveLength(1);
});

test('authenticates the HTTPS proxy identity independently of the CONNECT target name', async () => {
  setDefaultCACertificates([...fixtureTrustRoots, cert]);
  const proxy = createTlsServer({ key, cert });
  const names: (string | false | null)[] = [];
  const connects: { authority?: string; authorization?: string }[] = [];
  proxy.on('secureConnection', socket => names.push(socket.servername));
  proxy.on('connect', (request, socket) => {
    connects.push({ authority: request.url, authorization: request.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const endpoint = `https://proxy.example:${await listen(proxy)}`;
  const rule = { url: endpoint, allowPrivate: false, connectByHostname: true, auth: { username: 'fixture', ref: 'credential' } };
  const result = await checkUrl('https://different-target.example/', {
    resolve: resolveFixtures, pac: async () => [{ kind: 'proxy', url: endpoint }],
    pacProxy: { rules: new Map([[endpoint, rule]]), async readSecret() { return 'fixture-password'; } },
  });
  expect(result).toMatchObject({ proxyHttpCode: 407, httpCode: null, failureStage: 'proxy' });
  expect(names).toEqual(['proxy.example']);
  expect(connects).toEqual([{ authority: 'different-target.example:443', authorization: proxyAuthorization }]);
});

test('does not fall back to DIRECT without an explicit PAC directive', async () => {
  const endpoint = 'http://missing-proxy.example:8080';
  const result = await checkUrl(profile.origin, {
    resolve: host => host === 'missing-proxy.example' ? Promise.resolve([]) : resolveFixtures(host),
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }],
  });
  expect(result).toMatchObject({
    status: 'error', requestSource: 'pac', requestRoute: 'proxy', requestProxy: endpoint,
    errorKind: 'proxy', failureStage: 'proxy', httpCode: null,
  });
});

test.each([407, 502])('stops PAC fallback after a CONNECT HTTP %i response', async code => {
  const proxy = createServer();
  proxy.on('connect', (_request, socket) => socket.end(`HTTP/1.1 ${code} fixture-secret\r\nContent-Length: 0\r\n\r\n`));
  const endpoint = `http://proxy.example:${await listen(proxy)}`;
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestSource: 'pac', requestRoute: 'proxy', requestProxy: endpoint,
    errorKind: 'proxy', failureStage: 'proxy', httpCode: null, proxyHttpCode: code,
  });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('stops PAC fallback if a proxy sends an informational response and then stalls', async () => {
  const proxy = createServer();
  proxy.on('connect', (_request, socket) => socket.write('HTTP/1.1 103 Early Hints\r\n\r\n'));
  const endpoint = `http://proxy.example:${await listen(proxy)}`;
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    timeoutMs: 500,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestRoute: 'proxy', failureStage: 'proxy', proxyHttpCode: 103,
  });
});

test('stops PAC fallback after the HTTPS proxy certificate fails verification', async () => {
  const endpoint = `https://proxy.example:${await listen(createTlsServer({ key, cert }))}`;
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestRoute: 'proxy', requestProxy: endpoint,
    errorKind: 'proxy', failureStage: 'proxy', tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
});

test('stops PAC fallback if a proxy DNS result is non-public', async () => {
  const endpoint = 'http://proxy.example:8080';
  const result = await checkUrl(profile.origin, {
    resolve: host => host === 'proxy.example' ? resolve() : resolveFixtures(host),
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestRoute: 'proxy', requestProxy: endpoint, errorKind: 'proxy', failureStage: 'proxy',
  });
});

test('keeps a tunneled site HTTP error on the chosen PAC route', async () => {
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(403).end()));
  const proxy = createServer();
  attachTunnelFixture(proxy, targetPort);
  const endpoint = `http://proxy.example:${await listen(proxy)}`;
  const result = await checkUrl(`https://target.example:${targetPort}`, {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestRoute: 'proxy', requestProxy: endpoint, errorKind: 'http', failureStage: 'target', httpCode: 403,
  });
});

test('reports PAC selection errors without exposing script text', async () => {
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    pac: async () => { throw new Error('fixture-secret'); },
  });
  expect(result).toMatchObject({
    status: 'error', requestSource: 'pac', requestRoute: null, requestProxy: null, failureStage: 'pac', httpCode: null,
  });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('reports safe PAC diagnostics when route selection fails', async () => {
  const error = 'PAC вернул неподдерживаемый маршрут.';
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    pac: async () => { throw new PacError(error); },
  });
  expect(result).toMatchObject({ status: 'error', failureStage: 'pac', errorKind: 'configuration', error });
});

test('clears the previous route when PAC cannot select a route after a redirect', async () => {
  const target = 'https://next.example/path';
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: async () => ({ code: 302, headers: { location: target } }),
    pac: async url => {
      if (url.hostname === 'next.example') throw new PacError('PAC вернул пустой маршрут.');
      return [{ kind: 'direct' }];
    },
  });
  expect(result).toMatchObject({
    finalUrl: target, redirects: 1, requestSource: 'pac', requestRoute: null, requestProxy: null, failureStage: 'pac',
  });
});

test('redacts embedded credentials when a PAC-routed redirect is rejected', async () => {
  const result = await checkUrl(profile.origin, {
    resolve: resolveFixtures,
    request: async () => ({
      code: 302,
      headers: { location: 'https://username:fixture-secret@target.example/next' },
    }),
    pac: async () => [{ kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestSource: 'pac', requestRoute: null, finalUrl: 'https://target.example/next',
  });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('reports HTTPS-only PAC proxy routing without falling back for an HTTP URL', async () => {
  const endpoint = 'http://proxy.example:8080';
  const result = await checkUrl('http://target.example', {
    resolve: resolveFixtures,
    request: unusedDirectRequest,
    pac: async () => [{ kind: 'proxy', url: endpoint }, { kind: 'direct' }],
  });
  expect(result).toMatchObject({
    status: 'error', requestSource: 'pac', requestRoute: 'proxy', requestProxy: endpoint,
    errorKind: 'configuration', failureStage: 'pac',
  });
});

test('uses the fixed proxy even when PAC would fail', async () => {
  const targetPort = await listen(createTlsServer({ key, cert }, (_request, response) => response.writeHead(204).end()));
  const proxy = createServer();
  attachTunnelFixture(proxy, targetPort);
  const endpoint = `http://proxy.example:${await listen(proxy)}`;
  const origin = `https://target.example:${targetPort}`;
  const result = await checkUrl(origin, {
    resolve: resolveFixtures,
    tlsProfile: 'russian-ca',
    requestOptions: { ...profile, origin, proxy: { url: endpoint } },
    pac: async () => { throw new Error('PAC should not be evaluated'); },
  });
  expect(result).toMatchObject({
    status: 'ok', requestProfile: 'Site profile', requestSource: 'profile', requestRoute: 'proxy', requestProxy: endpoint,
  });
});
