import { setImmediate } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Catalog } from './database.js';
import { runImport } from './importer.js';

export type CatalogSecretRequest = { type: 'pac-secret'; id: number; ref: string };
export type CatalogSecretReply = { type: 'pac-secret'; id: number; value?: string };

const { database, id, file, kind, projectId } = workerData as {
  database: string; id: number; file?: string; kind: 'import' | 'transfer' | 'cleanup'; projectId?: number;
};
const db = new Catalog(database, 10_000);
const stop = new AbortController();
let nextRequest = 0;
const pending = new Map<number, (value: string | undefined) => void>();
parentPort?.on('message', (message: 'stop' | CatalogSecretReply) => {
  if (message === 'stop') {
    stop.abort();
    for (const done of pending.values()) done(undefined);
    pending.clear();
  } else if (message.type === 'pac-secret') {
    pending.get(message.id)?.(message.value);
    pending.delete(message.id);
  }
});
function readSecret(ref: string): Promise<string | undefined> {
  if (!parentPort || stop.signal.aborted) return Promise.resolve(undefined);
  const id = ++nextRequest;
  return new Promise(resolve => {
    pending.set(id, resolve);
    parentPort!.postMessage({ type: 'pac-secret', id, ref } satisfies CatalogSecretRequest);
  });
}
try {
  if (kind === 'cleanup') db.discardRows(id);
  else if (kind === 'transfer') {
    while (!stop.signal.aborted && db.transfers.batch(id, 512, projectId)) await setImmediate();
  } else await runImport(db, id, { file, signal: stop.signal, readSecret });
} finally {
  db.close();
  parentPort?.close();
}
