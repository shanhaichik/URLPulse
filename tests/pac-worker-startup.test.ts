import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const workers = vi.hoisted(() => [] as FakeWorker[]);

class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => {
    await Promise.resolve();
    this.emit('exit', 1);
    return 1;
  });

  constructor() {
    super();
    workers.push(this);
  }

  ref() {}
  unref() {}
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

beforeEach(() => {
  vi.resetModules();
  workers.length = 0;
  vi.useFakeTimers();
});

afterEach(() => { vi.useRealTimers(); });

async function startValidation() {
  const { validatePac } = await import('../src/server/pac.js');
  const result = validatePac('function FindProxyForURL() { return "DIRECT"; }').catch((error: unknown) => error);
  return { worker: workers[0], result };
}

test('validates a PAC file after a slow worker startup', async () => {
  const { worker, result } = await startValidation();
  await vi.advanceTimersByTimeAsync(2_800);
  worker.emit('message', { ready: true });
  worker.emit('message', { value: '' });
  expect(await result).toBeUndefined();
  expect(worker.terminate).not.toHaveBeenCalled();
});

test('bounds execution once a slowly starting worker is ready', async () => {
  const { worker, result } = await startValidation();
  await vi.advanceTimersByTimeAsync(2_800);
  worker.emit('message', { ready: true });
  await vi.advanceTimersByTimeAsync(2_499);
  expect(worker.terminate).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ message: 'PAC превысил лимит времени выполнения.' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

test('reports a runtime error when the worker never becomes ready', async () => {
  const { worker, result } = await startValidation();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toMatchObject({ message: 'Не удалось запустить изолированную проверку PAC.' });
  expect(worker.terminate).toHaveBeenCalledOnce();
});
