import type { DatabaseSync } from 'node:sqlite';

export function seedCompletedRun(db: DatabaseSync, runId: number, httpCode: number, checkedAt: string) {
  const ok = httpCode >= 200 && httpCode < 300;
  // Snapshot tests need a realistic on-disk database without a disk sync per result.
  db.exec('BEGIN IMMEDIATE');
  try {
    const { changes } = db.prepare(`UPDATE results
      SET status=?,http_code=?,duration_ms=12,final_url=url,redirects=0,error_kind=?,error=?,checked_at=?
      WHERE run_id=? AND status='pending'`).run(ok ? 'ok' : 'error', httpCode, ok ? null : 'http',
      ok ? null : `HTTP ${httpCode}`, checkedAt, runId);
    const completed = Number(changes);
    db.prepare('UPDATE runs SET completed=?,available=?,failures=? WHERE id=?')
      .run(completed, ok ? completed : 0, ok ? 0 : completed, runId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
