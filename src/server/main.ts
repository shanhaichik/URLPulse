import { DatabaseTasks } from './database-tasks.js';
import { ownDatabase, prepareProfileDirectory } from './database-owner.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { CatalogService } from './catalog/service.js';
import { envRequestSecrets } from './request-secrets.js';
import { Store } from './store.js';
import { smtpSender, startBackground } from './worker.js';
import { webAccessKey } from './web-access.js';

const port = 8731;
const origin = `http://127.0.0.1:${port}`;
const databasePath = process.env.URL_PULSE_DB || resolve('data', 'pulse.sqlite3');
const dev = process.argv.includes('--dev');
const accessKey = webAccessKey(process.env.PULSE_WEB_ACCESS_KEY);
const send = smtpSender(process.env, origin);
const requestSecrets = envRequestSecrets();
prepareProfileDirectory(dirname(databasePath), !process.env.URL_PULSE_DB);
const { path: database, release: releaseDatabase } = ownDatabase(databasePath);
const store = new Store(database, Date.now, false);
const catalog = new CatalogService(database, undefined, { store, secrets: requestSecrets });
const tasks = new DatabaseTasks(database);
const app = createApp({
  store, catalog, tasks, origin, requestSecrets, webAccessKey: accessKey, logger: true, smtpConfigured: !!send,
  onRunStopped: runId => stop.cancelRun(runId),
  staticRoot: dev ? undefined : fileURLToPath(new URL('../client/', import.meta.url)),
});
try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  await catalog.close();
  await tasks.close();
  store.close();
  releaseDatabase();
  throw error;
}
store.recover();
catalog.start();
const stop = startBackground(store, { tasks, send, requestSecrets, reportError: error => app.log.error(error) });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const outcomes = await Promise.allSettled([app.close(), stop(), catalog.close()]);
  try { await tasks.close(); }
  finally {
    try { store.close(); }
    finally { releaseDatabase(); }
  }
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      app.log.error(outcome.reason);
      process.exitCode = 1;
    }
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
console.log(`Пульс URL · ${dev ? 'http://127.0.0.1:5173' : origin}/#access=${accessKey}`);
