import { Resolver } from 'node:dns/promises';
import { setImmediate } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { createPacRouteResolver, PacError, validatePac } from '../src/server/pac.js';
import { MAX_PAC_BYTES } from '../src/shared/pac.js';

function resolve(source: string, address = 'https://example.test/', signal = new AbortController().signal) {
  return createPacRouteResolver(source)(new URL(address), signal);
}

test('uses Chromium-style HTTPS arguments and keeps PAC route order', async () => {
  const pac = `function FindProxyForURL(url, host) {
    if (url === 'https://example.test:8443/' && host === 'example.test') {
      return 'PROXY Proxy.Example:3128; HTTPS [2606:4700::1111]:8443; DIRECT;';
    }
    return 'DIRECT';
  }`;
  await expect(resolve(pac, 'https://user:pass@example.test:8443/private?id=1#secret')).resolves.toEqual([
    { kind: 'proxy', url: 'http://proxy.example:3128' },
    { kind: 'proxy', url: 'https://[2606:4700::1111]:8443' },
    { kind: 'direct' },
  ]);
  await expect(resolve(pac)).resolves.toEqual([{ kind: 'direct' }]);
});

test('uses default proxy ports and canonicalizes a trailing DNS dot', async () => {
  await expect(resolve('function FindProxyForURL() { return "PROXY Proxy.Example.; HTTPS proxys.example"; }')).resolves.toEqual([
    { kind: 'proxy', url: 'http://proxy.example' },
    { kind: 'proxy', url: 'https://proxys.example' },
  ]);
});

test('provides standard PAC matching, IPv4 and time helpers without host API access', async () => {
  const pac = `function FindProxyForURL(url, host) {
    alert('quiet');
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') return '';
    if (dnsDomainIs(host, '.test') && dnsDomainLevels(host) === 1 && shExpMatch(url, 'https://*.test/') &&
      isPlainHostName('proxy') && localHostOrDomainIs('proxy', 'proxy.test') &&
      dnsResolve('127.0.0.1') === '127.0.0.1' && isResolvable('127.0.0.1') &&
      isInNet('127.0.0.1', '127.0.0.0', '255.0.0.0') && typeof myIpAddress() === 'string' &&
      weekdayRange('SUN', 'SAT', 'GMT') && dateRange('JAN', 'DEC', 'GMT') && timeRange(0, 23, 'GMT')) {
      return 'DIRECT';
    }
    return '';
  }`;
  await expect(resolve(pac)).resolves.toEqual([{ kind: 'direct' }]);
});

test('resolves a hostname once per evaluation and supplies its IPv4 address to PAC helpers', async () => {
  const resolve4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['192.0.2.10']);
  try {
    const pac = `function FindProxyForURL(url, host) {
      if (dnsResolve(host) === '192.0.2.10' && isResolvable(host) && isInNet(host, '192.0.2.0', '255.255.255.0')) {
        return 'DIRECT';
      }
      return 'PROXY fallback.test';
    }`;
    await expect(resolve(pac)).resolves.toEqual([{ kind: 'direct' }]);
    expect(resolve4.mock.calls).toEqual([['example.test.']]);
  } finally {
    resolve4.mockRestore();
  }
});

test('validates PAC initialization and the entry point without selecting a route', async () => {
  const pac = `const FindProxyForURL = () => { throw new Error('secret ignored on upload'); };`;
  await expect(validatePac(pac)).resolves.toBeUndefined();
  await expect(validatePac('function missing() {}')).rejects.toThrow(/FindProxyForURL/);
  await expect(validatePac('function {')).rejects.toThrow(/синтаксис/);
  await expect(validatePac(' '.repeat(MAX_PAC_BYTES + 1))).rejects.toBeInstanceOf(PacError);
});

test('hides arbitrary script errors and rejects a non-string PAC return value', async () => {
  const error = await resolve('function FindProxyForURL() { throw new Error("secret"); }').catch(error => error);
  expect(error).toBeInstanceOf(PacError);
  expect(error.message).not.toContain('secret');
  await expect(resolve('async function FindProxyForURL() { return "DIRECT"; }')).rejects.toThrow(/строку/);
});

test.each([
  ['SOCKS5 proxy.example:1080; DIRECT', /PROXY, HTTPS и DIRECT/],
  ['PROXY user:secret@proxy.example:8080; DIRECT', /хост и порт/],
  ['PROXY proxy.example:8080/private; DIRECT', /хост и порт/],
  ['PROXY proxy.example:; DIRECT', /хост и порт/],
  ['PROXY proxy.example:65536; DIRECT', /хост и порт/],
  ['PROXY proxy.example:0; DIRECT', /хост и порт/],
  ['DIRECT;;DIRECT', /маршрут/],
  ['', /маршрут/],
  ['DIRECT;'.repeat(40), /лимит/],
  [' '.repeat(5_000) + 'DIRECT', /лимит/],
  ['DIRECT\0; SOCKS proxy.example:1080', /маршрут/],
])('fails closed for an invalid PAC route list %#', async (result, message) => {
  await expect(resolve(`function FindProxyForURL() { return ${JSON.stringify(result)}; }`)).rejects.toThrow(message);
});

test('bounds runaway PAC code off the checking event loop', async () => {
  const result = resolve('function FindProxyForURL() { while (true) {} }');
  await expect(Promise.race([result.catch(() => 'finished'), setImmediate('other request')])).resolves.toBe('other request');
  await expect(result).rejects.toThrow(/лимит времени/);
});

test('propagates cancellation without waiting for PAC evaluation to complete', async () => {
  const abort = new AbortController();
  const reason = new Error('run stopped');
  const result = resolve('function FindProxyForURL() { while (true) {} }', undefined, abort.signal);
  await setImmediate();
  abort.abort(reason);
  await expect(result).rejects.toBe(reason);
  await expect(validatePac('function FindProxyForURL() { return "DIRECT"; }', abort.signal)).rejects.toBe(reason);
});

test('starts with fresh PAC globals across concurrent and repeated resolutions', async () => {
  const pac = `var calls = 0;
    function FindProxyForURL(url, host) { return ++calls === 1 ? 'DIRECT' : ''; }`;
  const resolveRoute = createPacRouteResolver(pac);
  for (let batch = 0; batch < 2; batch++) {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      resolveRoute(new URL(`https://example.test/${index}`), new AbortController().signal)));
    expect(results).toEqual(Array.from({ length: 8 }, () => [{ kind: 'direct' }]));
  }
});
