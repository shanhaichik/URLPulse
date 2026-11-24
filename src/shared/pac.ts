export const MAX_PAC_BYTES = 256 * 1024;

export interface PacSettings {
  filename: string;
  revision: string;
}

export type PacRoute = { kind: 'direct' } | { kind: 'proxy'; url: string };
export interface PacPreview { routes: PacRoute[]; source: 'pac' | 'profile' | 'direct' }
export type PacRouteResolver = (url: URL, signal: AbortSignal) => Promise<PacRoute[]>;
