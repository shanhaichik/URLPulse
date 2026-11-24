import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { DatabaseTasks } from '../dist/server/database-tasks.js';
import { Store } from '../dist/server/store.js';
import { addUrls, checkSnapshot, digest, run } from './report-fixture.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pulse-export-transport-'));
const file = join(directory, 'pulse.sqlite3');
const store = new Store(file);
const db = new DatabaseSync(file, { timeout: 0 });
const tasks = new DatabaseTasks(file);
const app = createApp({ store, tasks });
const runCommand = tasks.run.bind(tasks);

function checkpoint() { return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy; }

async function awaitCheckpoint() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!checkpoint()) return;
    await setTimeout(20);
  }
  throw new Error('Snapshot still pins the WAL after export cancellation.');
}

async function pauseDownload(url) {
  const request = get(url, { agent: false });
  const [response] = await once(request, 'response');
  assert.equal(response.statusCode, 200);
  response.pause();
  response.on('error', () => {});
  return response;
}

try {
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const project = store.createProject('Export fixture', '').id;
  addUrls(store, project, 1305);
  const outcomes = [];
  for (const format of ['csv', 'excel', 'json']) {
    for (const target of ['baseline', 'current']) {
      const baseline = run(store, db, project, 200);
      const current = run(store, db, project, 503);
      const path = `/api/projects/${project}/runs/${current}/export?format=${format}&change=regression`;
      const expected = (await app.inject(path)).body;
      const rows = checkSnapshot(expected, format);
      let deleted = false;
      tasks.run = async (command, ...args) => {
        const result = await runCommand(command, ...args);
        if (!deleted && command === 'readExport') {
          assert.equal(result.length, 500);
          deleted = true;
          await runCommand('deleteRun', project, target === 'baseline' ? baseline : current);
        }
        return result;
      };
      try {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200);
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(expected));
        assert.equal(deleted, true);
      } finally { tasks.run = runCommand; }
      outcomes.push({ format, deleted: target, rows, bytes: Buffer.byteLength(expected), sha256: digest(expected) });
    }
  }
  await awaitCheckpoint();
  const pressure = store.createProject('Slow reader fixture', '').id;
  addUrls(store, pressure, 5000, 'p'.repeat(1650));
  for (let index = 0; index < 3; index++) run(store, db, pressure, 200);
  assert.equal(checkpoint(), 0);
  const url = `${origin}/api/projects/${pressure}/export?format=csv`;
  const rssBefore = process.memoryUsage().rss;
  const response = await pauseDownload(url);
  for (let i = 0; i < 32; i++) db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(String(i), pressure);
  await setTimeout(250);
  assert.equal(checkpoint(), 1);
  const rssPaused = process.memoryUsage().rss;
  const walPaused = (await stat(file + '-wal')).size;
  response.destroy();
  await awaitCheckpoint();
  assert.equal((await stat(file + '-wal')).size, 0);
  const stalled = await pauseDownload(url);
  assert.equal(stalled.readableEnded, false);
  await Promise.race([app.close(), setTimeout(5000, null, { ref: false }).then(() => assert.fail('Shutdown waits for stalled export.'))]);
  stalled.destroy();
  await awaitCheckpoint();
  console.log(JSON.stringify({ outcomes, slowReceiver: { urls: 5000, results: 15000, rssBefore, rssPaused, walPaused, walAfter: 0 }, shutdown: 'completed' }));
} finally {
  await app.close();
  await tasks.close();
  db.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
