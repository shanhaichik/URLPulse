import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkServerIdentity, connect } from 'node:tls';

export interface Endpoint { address: string; family: number }

export function pinnedLookup(addresses: Endpoint[]): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

export class ProxyRequestError extends Error {
  constructor(message: string, readonly httpCode: number | null = null, cause?: unknown) {
    super(message, { cause });
  }
}

export function openProxyTunnel(proxy: URL, addresses: Endpoint[], authorization: string | undefined,
  target: URL, targetAddress: Endpoint, signal: AbortSignal): Promise<Duplex> {
  const address = targetAddress.family === 6 ? '[' + targetAddress.address + ']' : targetAddress.address;
  const authority = address + ':' + (target.port || '443');
  const send = proxy.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port || undefined,
      path: authority,
      method: 'CONNECT',
      agent: false,
      signal,
      lookup: pinnedLookup(addresses),
      headers: { host: authority, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
      ...(proxy.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
    });
    request.on('error', error => reject(signal.aborted ? signal.reason
      : new ProxyRequestError('Не удалось подключиться к прокси.', null, error)));
    request.once('connect', (response, socket, head) => {
      const code = response.statusCode ?? 0;
      if (code < 200 || code >= 300 || signal.aborted) {
        socket.destroy();
        reject(signal.aborted ? signal.reason : new ProxyRequestError(
          code === 407 ? 'Прокси отклонил авторизацию (HTTP 407).' : 'Прокси не открыл туннель.', code || null));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

export function connectTargetTls(socket: Duplex, host: string, ca?: string[]) {
  return connect({
    socket,
    host,
    servername: isIP(host) ? undefined : host,
    rejectUnauthorized: true,
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
    ...(ca ? { ca } : {}),
  });
}
