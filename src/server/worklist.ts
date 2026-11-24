import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { ADDRESS_PAGE_SIZE, selectAddresses, type SelectedAddress } from '../shared/addresses.js';
import type { AddressFilters, AddressRow } from '../shared/types.js';

export const workingWhere = 'u.project_id=? AND u.worklist=1 AND u.removed_at IS NULL';
export const groupWhere = `u.id IN (SELECT m.url_id FROM work_group_urls m
  JOIN work_groups g ON g.id=m.group_id WHERE m.group_id=? AND g.project_id=? AND g.deleted_at IS NULL)`;
export const latestResult = `SELECT id FROM results WHERE url_id=u.id AND version=u.version
  AND checked_at IS NOT NULL ORDER BY checked_at DESC, id DESC LIMIT 1`;
export const latestResultJoin = `LEFT JOIN results r ON r.id=(${latestResult})`;
const columns = `u.id,u.url,u.label,u.version,u.removed_at AS removedAt,r.status,r.http_code AS httpCode,
  r.duration_ms AS durationMs,r.checked_at AS checkedAt`;
const sortColumns = {
  url: 'u.url COLLATE NOCASE',
  label: "NULLIF(fold_address_label(u.label),'') COLLATE NOCASE",
  status: 'r.status',
  httpCode: 'r.http_code',
  durationMs: 'r.duration_ms',
  checkedAt: 'r.checked_at',
};

type Row = Omit<AddressRow, 'latest'> & NonNullable<AddressRow['latest']>;
export function addressRow({ status, httpCode, durationMs, checkedAt, ...address }: Row): AddressRow {
  return { ...address, latest: checkedAt === null ? null : { status, httpCode, durationMs, checkedAt } };
}

export class WorklistView {
  constructor(private readonly db: DatabaseSync) {
    this.db.function('fold_address_label', { deterministic: true }, value =>
      String(value ?? '').toLocaleLowerCase('ru'));
  }

  private filter(project: number, filters: AddressFilters) {
    const where = [workingWhere];
    const params: SQLInputValue[] = [project];
    if (filters.groupId !== undefined) { where.push(groupWhere); params.push(filters.groupId, project); }
    const query = filters.q.trim().toLocaleLowerCase('ru');
    if (query) {
      where.push("(instr(lower(u.url),?)>0 OR (u.label<>'' AND instr(fold_address_label(u.label),?)>0))");
      params.push(query, query);
    }
    if (filters.status === 'unchecked') where.push('r.id IS NULL');
    else if (filters.status !== 'all') {
      where.push('r.status=?');
      params.push(filters.status);
    }
    return { where: where.join(' AND '), params };
  }

  private count(project: number) {
    return Number(this.db.prepare('SELECT url_count FROM projects WHERE id=?').get(project)?.url_count ?? 0);
  }

  private small(project: number, filters: AddressFilters) {
    const scope = filters.groupId === undefined ? [] : [filters.groupId, project];
    const rows = this.db.prepare(`SELECT ${columns} FROM urls u ${latestResultJoin}
      WHERE ${workingWhere}${scope.length ? ` AND ${groupWhere}` : ''}`).all(project, ...scope) as Row[];
    return selectAddresses(rows.map(addressRow), filters);
  }

  summary(project: number, total: number) {
    if (!total) return { total: 0, available: 0, failures: 0, unchecked: 0 };
    const completed = Number(this.db.prepare('SELECT COALESCE(SUM(completed), 0) AS total FROM runs WHERE project_id=?').get(project)!.total);
    if (!completed) return { total, available: 0, failures: 0, unchecked: total };
    const counts = `SELECT COUNT(CASE WHEN r.status='ok' THEN 1 END) AS available,
      COUNT(CASE WHEN r.status='error' THEN 1 END) AS failures`;
    // Sparse projects can have a very large unchecked worklist. With long
    // histories it is cheaper to look up the latest result once per active URL.
    const row = completed > total
      ? this.db.prepare(`${counts} FROM urls u ${latestResultJoin} WHERE ${workingWhere}`).get(project)
      : this.db.prepare(`${counts} FROM runs job CROSS JOIN results r ON r.run_id=job.id
          CROSS JOIN urls u ON u.id=r.url_id WHERE job.project_id=? AND job.completed>0 AND ${workingWhere}
            AND r.checked_at IS NOT NULL AND r.id=(${latestResult})`).get(project, project);
    const { available, failures } = row as { available: number; failures: number };
    return { total, available, failures, unchecked: total - available - failures };
  }

  page(project: number, filters: AddressFilters, requested: number) {
    this.db.exec('BEGIN');
    try {
      const count = this.count(project);
      if (count <= 5_000) {
        const list = this.small(project, filters);
        const page = this.pageNumber(requested, list.length);
        const start = (page - 1) * ADDRESS_PAGE_SIZE;
        return { items: list.slice(start, start + ADDRESS_PAGE_SIZE), total: list.length, page };
      }
      const { where, params } = this.filter(project, filters);
      const total = filters.q || filters.status !== 'all' || filters.groupId !== undefined
        ? this.db.prepare(`SELECT COUNT(*) AS total FROM urls u ${filters.status === 'all' ? '' : latestResultJoin}
          WHERE ${where}`).get(...params)!.total as number : count;
      const page = this.pageNumber(requested, total);
      if (total <= 5_000) {
        const matches = this.db.prepare(`SELECT ${columns} FROM urls u ${latestResultJoin} WHERE ${where}`)
          .all(...params) as Row[];
        const start = (page - 1) * ADDRESS_PAGE_SIZE;
        const sorted = selectAddresses(matches.map(addressRow), filters);
        return { items: sorted.slice(start, start + ADDRESS_PAGE_SIZE), total, page };
      }
      const order = sortColumns[filters.sort];
      const direction = filters.direction === 'desc' ? 'DESC' : 'ASC';
      const items = this.db.prepare(`
        SELECT ${columns} FROM urls u ${latestResultJoin} WHERE ${where}
        ORDER BY ${filters.sort === 'url' ? '' : `(${order}) IS NULL,`} ${order} ${direction}, u.id
        LIMIT ? OFFSET ?
      `).all(...params, ADDRESS_PAGE_SIZE, (page - 1) * ADDRESS_PAGE_SIZE) as Row[];
      return { items: items.map(addressRow), total, page };
    } finally { this.db.exec('ROLLBACK'); }
  }

  selection(project: number, filters: AddressFilters, limit: number) {
    const { where, params } = this.filter(project, filters);
    const rows = this.db.prepare(`SELECT u.id FROM urls u ${filters.status === 'all' ? '' : latestResultJoin}
      WHERE ${where} ORDER BY u.id LIMIT ?`).all(...params, limit + 1) as { id: number }[];
    return { ids: rows.length > limit ? [] : rows.map(row => row.id), exceeded: rows.length > limit };
  }

  selectionPreview(project: number, filters: AddressFilters, ids: number[]): SelectedAddress[] {
    const { where, params } = this.filter(project, filters);
    const rows = this.db.prepare(`SELECT u.id, u.url, u.version, (${where}) AS matchesFilter
      FROM urls u ${filters.status === 'all' ? '' : latestResultJoin}
      WHERE ${workingWhere} AND u.id IN (SELECT value FROM json_each(?)) ORDER BY u.id`)
      .all(...params, project, JSON.stringify(ids)) as (Omit<SelectedAddress, 'matchesFilter'> & { matchesFilter: number | null })[];
    return rows.map(row => ({ ...row, matchesFilter: Boolean(row.matchesFilter) }));
  }

  private pageNumber(requested: number, total: number) {
    return Math.min(requested, Math.max(1, Math.ceil(total / ADDRESS_PAGE_SIZE)));
  }
}
