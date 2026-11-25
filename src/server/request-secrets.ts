import type { RequestSecretInput } from '../shared/request-profiles.js';

export interface RequestSecrets {
  mode: 'desktop' | 'environment';
  save(input: RequestSecretInput): Promise<string>;
  read(reference: string): Promise<string | undefined>;
  remove(reference: string): Promise<void>;
}

export function validRequestSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}

const environmentAlias = /^PULSE_REQUEST_SECRET_[A-Z0-9_]+$/;
const desktopReference = /^desktop-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isDesktopRequestSecret(reference: string) { return desktopReference.test(reference); }

export function isRequestSecretReference(reference: unknown) {
  return typeof reference === 'string' && (isDesktopRequestSecret(reference) || environmentAlias.test(reference));
}

export function envRequestSecrets(env: NodeJS.ProcessEnv = process.env): RequestSecrets {
  return {
    mode: 'environment',
    async save(input) {
      if (!('environment' in input) || 'value' in input || typeof input.environment !== 'string'
        || !environmentAlias.test(input.environment)) {
        throw new Error('Укажите переменную окружения с именем PULSE_REQUEST_SECRET_…');
      }
      return input.environment;
    },
    async read(reference) {
      if (environmentAlias.test(reference) && Object.hasOwn(env, reference)) return env[reference] || undefined;
    },
    async remove() { /* Environment values are managed by the operator. */ },
  };
}
