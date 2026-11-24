import { setImmediate } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Catalog } from './database.js';
import { runImport } from './importer.js';

const { database, id, file, kind, projectId } = workerData as {
  database: string; id: number; file?: string; kind: 'import' | 'transfer' | 'cleanup'; projectId?: number;
};
const db = new Catalog(database, 10_000);
const stop = new AbortController();
parentPort?.once('message', () => stop.abort());
try {
  if (kind === 'cleanup') db.discardRows(id);
  else if (kind === 'transfer') {
    while (!stop.signal.aborted && db.transfers.batch(id, 512, projectId)) await setImmediate();
  } else await runImport(db, id, { file, signal: stop.signal });
} finally {
  db.close();
  parentPort?.close();
}
