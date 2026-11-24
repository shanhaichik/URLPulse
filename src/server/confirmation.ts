import { createHash } from 'node:crypto';

export function scopeConfirmation(scope: unknown): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

export function isScopeConfirmation(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
