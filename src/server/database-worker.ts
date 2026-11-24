import { parentPort, workerData } from 'node:worker_threads';
import { databaseBusy, databaseCommands, type DatabaseRequest, type DatabaseResponse } from './database-tasks.js';
import { ApiError, Store } from './store.js';

const store = new Store(workerData as string, Date.now, false, false);
parentPort?.on('message', async ({ id, command, args }: DatabaseRequest) => {
  let response: DatabaseResponse;
  try {
    const execute = databaseCommands[command] as (db: Store, ...params: unknown[]) => unknown;
    response = { id, value: await execute(store, ...args) };
  } catch (failure) {
    const status = failure instanceof ApiError ? failure.statusCode : databaseBusy(failure) ? 503 : undefined;
    response = { id, status, message: status === 503 ? 'База занята. Повторите действие через несколько секунд.'
      : (failure as Error).message };
  }
  parentPort?.postMessage(response);
});
