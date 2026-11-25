import type { RequestSecretInput, RequestSecretView } from './request-profiles.js';

export const MAX_PAC_BYTES = 256 * 1024;

export interface PacProxyRule {
  url: string;
  allowPrivate: boolean;
  connectByHostname: boolean;
}

export interface PacProxyInput extends PacProxyRule {
  auth?: { username: string; secret?: RequestSecretInput };
}

export interface PacProxyView extends PacProxyRule {
  auth?: { username: string } & RequestSecretView;
}

export interface PacSettings {
  filename: string;
  revision: string;
  proxies?: PacProxyView[];
}

export type PacRoute = { kind: 'direct' } | { kind: 'proxy'; url: string };
export interface PacPreview { routes: PacRoute[]; source: 'pac' | 'profile' | 'direct' }
export type PacRouteResolver = (url: URL, signal: AbortSignal) => Promise<PacRoute[]>;
