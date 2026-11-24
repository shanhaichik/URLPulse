import { expect, test } from 'vitest';
import * as checker from '../src/server/checker.js';

const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];

test('reports the final HTTP status, headers and redirect count', async () => {
  expect(checker).toHaveProperty('checkUrl');
  const request = async (url: URL) => url.pathname === '/'
    ? { code: 302, headers: { location: '/missing' } }
    : { code: 404, headers: { 'content-type': 'text/plain', 'content-length': '7' } };
  const checked = await checker.checkUrl('https://example.com/', { resolve, request });
  expect(checked).toMatchObject({
    status: 'error', httpCode: 404, errorKind: 'http', redirects: 1,
    finalUrl: 'https://example.com/missing', contentType: 'text/plain', contentLength: '7',
  });
  const ok = await checker.checkUrl('https://example.com/', {
    resolve, request: async () => ({ code: 204, headers: {} }),
  });
  expect(ok).toMatchObject({ status: 'ok', httpCode: 204 });
});

test('rejects a redirect that resolves to a private IP without making the second connection', async () => {
  const connected: string[] = [];
  const result = await checker.checkUrl('https://example.com/', {
    resolve: async host => [{ address: host === 'example.com' ? '93.184.216.34' : '192.168.1.5', family: 4 }],
    request: async url => {
      connected.push(url.hostname);
      return { code: 302, headers: { location: 'http://internal.example/' } };
    },
  });
  expect(connected).toEqual(['example.com']);
  expect(result).toMatchObject({ status: 'error', errorKind: 'blocked', redirects: 1 });
});

test('classifies DNS, TLS and deadline failures independently', async () => {
  for (const [code, errorKind] of [['ENOTFOUND', 'dns'], ['CERT_HAS_EXPIRED', 'tls']]) {
    const result = await checker.checkUrl('https://example.com/', {
      resolve, request: async () => { throw Object.assign(new Error(code), { code }); },
    });
    expect(result).toMatchObject({ status: 'error', errorKind });
  }
  const timeout = await checker.checkUrl('https://example.com/', {
    resolve: () => new Promise(() => {}), timeoutMs: 15,
  });
  expect(timeout).toMatchObject({ status: 'error', errorKind: 'timeout' });
});
