import type { DatabaseSync } from 'node:sqlite';
import type { CatalogTransfer } from '../../shared/catalog.js';
import { ApiError } from '../store.js';

export class CatalogTransfers {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  latest(projectId: number) {
    return this.db.prepare(`SELECT id,state,added,existing,added+existing AS processed,total,error
      FROM catalog_transfers WHERE project_id=? ORDER BY id DESC LIMIT 1`).get(projectId) as unknown as CatalogTransfer | undefined;
  }

  enqueue(projectId: number) {
    return this.transaction(() => {
      const active = this.latest(projectId);
      if (active?.state === 'queued' || active?.state === 'running') return active;
      const sources = this.db.prepare(`SELECT current_id AS id,count FROM catalog_sources
        WHERE project_id=? AND current_id IS NOT NULL AND count>0`).all(projectId) as { id: number; count: number }[];
      if (!sources.length) throw new ApiError(400, 'В опубликованном каталоге проекта пока нет адресов.');
      const job = this.db.prepare('INSERT INTO catalog_transfers(project_id,created_at,total) VALUES (?,?,?)')
        .run(projectId, new Date().toISOString(), sources.length === 1 ? sources[0].count : null);
      const pin = this.db.prepare('INSERT INTO catalog_transfer_sources(transfer_id,import_id) VALUES (?,?)');
      for (const source of sources) pin.run(job.lastInsertRowid, source.id);
      return this.latest(projectId)!;
    });
  }

  next() {
    return this.db.prepare("SELECT id,project_id AS projectId FROM catalog_transfers WHERE state='queued' ORDER BY id LIMIT 1")
      .get() as { id: number; projectId: number } | undefined;
  }

  stop(projectId: number, id: number) {
    return this.transaction(() => {
      const transfer = this.latest(projectId);
      if (!transfer || transfer.id !== id) throw new ApiError(404, 'Перенос адресов не найден.');
      if (transfer.state === 'cancelled') return transfer;
      if (transfer.state !== 'queued' && transfer.state !== 'running') {
        throw new ApiError(409, 'Перенос адресов уже завершился.');
      }
      this.db.prepare("UPDATE catalog_transfers SET state='cancelled' WHERE id=?").run(id);
      this.db.prepare('DELETE FROM catalog_transfer_sources WHERE transfer_id=?').run(id);
      return this.latest(projectId)!;
    });
  }

  batch(id: number, limit: number, projectId?: number) {
    return this.transaction(() => {
      const job = this.db.prepare(`SELECT project_id,created_at,last_import,cursor FROM catalog_transfers
        WHERE id=? AND state IN ('queued','running')`).get(id) as { project_id: number; created_at: string; last_import: number; cursor: string } | undefined;
      if (!job || (projectId !== undefined && projectId !== job.project_id)) return false;
      const current = this.db.prepare(`SELECT import_id FROM catalog_transfer_sources
        WHERE transfer_id=? AND import_id>=? ORDER BY import_id LIMIT 1`).get(id, job.last_import)?.import_id as number | undefined;
      if (current === undefined) {
        this.db.prepare("UPDATE catalog_transfers SET state='done',total=added+existing WHERE id=?").run(id);
        this.db.prepare('DELETE FROM catalog_transfer_sources WHERE transfer_id=?').run(id);
        return false;
      }

      const rows = this.db.prepare(`SELECT url FROM catalog_urls WHERE import_id=? AND url>?
        ORDER BY url LIMIT ?`).all(current, current === job.last_import ? job.cursor : '', limit) as { url: string }[];
      const appearedEarlier = this.db.prepare(`
        SELECT 1 FROM catalog_urls prior INDEXED BY catalog_url_sources
        CROSS JOIN catalog_transfer_sources s ON s.transfer_id=? AND s.import_id=prior.import_id
        WHERE prior.url=? AND prior.import_id<? LIMIT 1
      `);
      const lookup = this.db.prepare('SELECT id,worklist FROM urls WHERE project_id=? AND url=? AND removed_at IS NULL');
      const archived = this.db.prepare(`SELECT id FROM urls WHERE project_id=? AND url=? AND removed_at IS NOT NULL
        ORDER BY worklist DESC,id DESC LIMIT 1`);
      const restore = this.db.prepare('UPDATE urls SET removed_at=NULL,worklist=1 WHERE id=?');
      const retireDuplicate = this.db.prepare("UPDATE urls SET removed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?");
      const insert = this.db.prepare("INSERT INTO urls(project_id,url,label) VALUES (?,?,'')");
      const version = this.db.prepare('INSERT INTO url_versions VALUES (?,1,?,?)');
      let existing = 0, added = 0;
      const hasPrior = Boolean(this.db.prepare('SELECT 1 FROM catalog_transfer_sources WHERE transfer_id=? AND import_id<? LIMIT 1').get(id, current));
      for (const { url } of rows) {
        if (hasPrior && appearedEarlier.get(id, url, current)) continue;
        const record = lookup.get(job.project_id, url) as { id: number; worklist: number } | undefined;
        if (record?.worklist) existing++;
        else {
          const prior = archived.get(job.project_id, url) as { id: number } | undefined;
          if (prior && record) retireDuplicate.run(record.id);
          const target = prior ?? record;
          if (target) restore.run(target.id);
          else version.run(insert.run(job.project_id, url).lastInsertRowid, url, job.created_at);
          added++;
        }
      }
      if (added) this.db.prepare('UPDATE projects SET url_count=url_count+?,worklist_revision=worklist_revision+1 WHERE id=?')
        .run(added, job.project_id);
      const finishedDocument = rows.length < limit;
      this.db.prepare(`UPDATE catalog_transfers SET state='running',last_import=?,cursor=?,
        added=added+?,existing=existing+? WHERE id=?`).run(
        finishedDocument ? current + 1 : current, finishedDocument ? '' : rows.at(-1)!.url,
        added, existing, id);
      return true;
    });
  }

  fail(projectId: number, id: number, message: string) {
    this.transaction(() => {
      const failed = this.db.prepare("UPDATE catalog_transfers SET state='failed',error=? WHERE id=? AND project_id=? AND state IN ('queued','running')")
        .run(message.slice(0, 500), id, projectId);
      if (failed.changes) this.db.prepare('DELETE FROM catalog_transfer_sources WHERE transfer_id=?').run(id);
    });
  }
}
