import { isComparisonKind, type ComparisonInput } from '../shared/run-comparison.js';
import { ApiError } from './store.js';

function runId(value: unknown) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, 'Выберите два прогона для сравнения.');
  }
  return id;
}

export function parseComparisonInput(input: unknown): ComparisonInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Выберите два прогона для сравнения.');
  }
  const { baseline, target, q, kind } = input as Record<string, unknown>;
  const first = runId(baseline);
  const second = runId(target);
  if (first === second) throw new ApiError(400, 'Выберите разные прогоны.');
  if (q !== undefined && (typeof q !== 'string' || q.length > 512 || /[\x00-\x1f]/.test(q))) {
    throw new ApiError(400, 'Введите до 512 символов для поиска.');
  }
  if (kind !== undefined && !isComparisonKind(kind)) throw new ApiError(400, 'Выберите тип расхождения.');
  return { baseline: first, target: second, q: q?.trim() || undefined, kind };
}
