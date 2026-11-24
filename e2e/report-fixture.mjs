import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function addUrls(store, project, count, suffix = '') {
  for (let offset = 0; offset < count; offset += 1000) {
    const lines = Array.from({ length: Math.min(count - offset, 1000) }, (_, index) => ({
      input: `https://example.com/${offset + index}/${suffix}`, line: index + 1,
    }));
    assert.equal(store.addUrls(project, lines).added, lines.length);
  }
}

export function run(store, db, project, code) {
  const { id } = store.enqueue(project);
  assert.equal(store.claim().id, id);
  db.prepare(`UPDATE results SET status=?, http_code=?, duration_ms=12, final_url=url,
    checked_at='2025-01-01T00:00:00.000Z' WHERE run_id=?`).run(code === 200 ? 'ok' : 'error', code, id);
  db.prepare('UPDATE runs SET completed=total, available=CASE WHEN ? THEN total ELSE 0 END, failures=CASE WHEN ? THEN 0 ELSE total END WHERE id=?')
    .run(code === 200 ? 1 : 0, code === 200 ? 1 : 0, id);
  store.finish(id);
  return id;
}

export function checkSnapshot(expected, format) {
  const rows = format === 'json' ? JSON.parse(expected) : expected.trim().split('\r\n').slice(1);
  assert.equal(rows.length, 1305);
  if (format === 'json') {
    assert.equal(new Set(rows.map(row => row.id)).size, 1305);
    assert.ok(rows.every(row => row.previousHttpCode === 200 && row.previousFinalUrl === row.url));
  }
  return rows.length;
}
