import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../dist/server/app.js';
import { Store } from '../dist/server/store.js';

const directory = await mkdtemp(join(tmpdir(), 'pulse-worklist-history-'));
const dbFile = join(directory, 'pulse.sqlite3');
const store = new Store(dbFile);
const fixture = new DatabaseSync(dbFile);
const app = createApp({ store });
const total = 20_000;
const histories = 12;

function seed(project) {
  fixture.exec('BEGIN');
  const insert = fixture.prepare('INSERT INTO urls(project_id, url, label) VALUES (?, ?, ?)');
  for (let i = 0; i < total; i++) {
    const section = i % 30 === 0 ? 'featured' : 'detail';
    insert.run(project, `https://history.example/${String(i).padStart(5, '0')}/${section}`, 'Рабочий каталог');
  }
  fixture.prepare('UPDATE projects SET url_count=? WHERE id=?').run(total, project);
  fixture.exec('COMMIT');
  for (let i = 0; i < histories; i++) {
    const { id } = store.enqueue(project);
    assert.equal(store.claim().id, id);
    fixture.prepare(`UPDATE results SET status=CASE WHEN (id+?)%7=0 THEN 'error' ELSE 'ok' END,
      http_code=CASE WHEN (id+?)%7=0 THEN 503 ELSE 200 END, duration_ms=id%997, final_url=url,
      checked_at='2025-01-01T00:00:00.000Z' WHERE run_id=?`).run(i, i, id);
    fixture.prepare(`UPDATE runs SET completed=total, failures=(SELECT count(*) FROM results WHERE run_id=? AND status='error')
      WHERE id=?`).run(id, id);
    fixture.prepare('UPDATE runs SET available=total-failures WHERE id=?').run(id);
    store.finish(id, false);
  }
  assert.equal(fixture.prepare('SELECT count(*) AS total FROM results').get().total, total * histories);
}

const plans = new Map();
const prepare = store.db.prepare.bind(store.db);
store.db.prepare = sql => {
  if (/SELECT (COUNT\(|u\.id)/.test(sql) && !plans.has(sql)) {
    const parameters = [...sql.matchAll(/\?/g)].map(() => null);
    plans.set(sql, prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => row.detail));
  }
  return prepare(sql);
};

try {
  const project = store.createProject('Длинная история', '').id;
  const other = store.createProject('Второй проект', '').id;
  seed(project);
  const path = `/api/projects/${project}`;
  const measurements = {};
  for (const suffix of ['?view=summary', '/urls/page', '/urls/page?page=800',
    '/urls/page?sort=durationMs&direction=desc&page=800', '/urls/page?q=detail&page=750', '/urls/page?q=featured']) {
    const latencies = [];
    let data;
    for (let sample = 0; sample < 24; sample++) {
      const start = performance.now();
      const result = await app.inject(path + suffix);
      assert.equal(result.statusCode, 200);
      if (sample >= 4) latencies.push(performance.now() - start);
      data = result.json();
    }
    latencies.sort((a, b) => a - b);
    const observed = data.items ? { page: data.page, total: data.total, rows: data.items.map(row => row.id) } : data.summary;
    if (!data.items) assert.equal(data.summary.available + data.summary.failures, total);
    measurements[suffix] = { samples: latencies.length, p50: latencies[9], p95: latencies[18],
      observed, digest: createHash('sha256').update(JSON.stringify(observed)).digest('hex') };
  }
  let revision = (await app.inject(path + '?view=summary')).json().revision;
  let extraPageRequests = 0;
  for (let i = 0; i < 10; i++) {
    fixture.prepare('UPDATE projects SET description=? WHERE id=?').run(String(i), other);
    const changed = (await app.inject(`${path}?view=summary&since=${encodeURIComponent(revision)}`)).json();
    if (!changed.unchanged) {
      revision = changed.revision;
      assert.equal(revision && (await app.inject(path + '/urls/page?page=800')).statusCode, 200);
      extraPageRequests++;
    }
  }
  console.log(JSON.stringify({ urls: total, results: total * histories, measurements,
    crossProject: { updates: 10, summaryRequests: 10, extraPageRequests }, rss: process.memoryUsage().rss, plans: [...plans] }));
} finally {
  await app.close();
  fixture.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
