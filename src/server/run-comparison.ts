import type { DatabaseSync } from 'node:sqlite';
import type { ComparisonFilters, ComparisonFlag, ComparisonRow, ComparisonSide } from '../shared/run-comparison.js';
import type { Result, Run } from '../shared/types.js';
import { selectResultFields } from './schema.js';

export interface ComparisonCoverage {
  baseline: Run;
  target: Run;
  baselineKnown: boolean;
  targetKnown: boolean;
}

export const eligibleComparisonRun = "r.status IN ('done','cancelled') AND r.completed>0";

const baselineVersion = 'COALESCE(a.version, ap.version)';
const targetVersion = 'COALESCE(b.version, bp.version)';
const baselinePresent = 'COALESCE(a.url_id, ap.url_id) IS NOT NULL';
const targetPresent = 'COALESCE(b.url_id, bp.url_id) IS NOT NULL';
const baselineChecked = "a.checked_at IS NOT NULL AND a.status IN ('ok', 'error')";
const targetChecked = "b.checked_at IS NOT NULL AND b.status IN ('ok', 'error')";
const sameCheckedVersion = `${baselineChecked} AND ${targetChecked} AND a.version=b.version`;
const delta = 'b.duration_ms-a.duration_ms';

const responseDifference = (condition: string) => `${sameCheckedVersion} AND (${condition})`;
const flagConditions: Record<ComparisonFlag, string> = {
  regression: responseDifference("a.status='ok' AND b.status='error'"),
  recovered: responseDifference("a.status='error' AND b.status='ok'"),
  httpChanged: responseDifference('a.http_code IS NOT b.http_code'),
  destinationChanged: responseDifference('a.final_url IS NOT b.final_url'),
  errorChanged: responseDifference(`a.status='error' AND b.status='error' AND (
    a.error_kind IS NOT b.error_kind OR a.tls_code IS NOT b.tls_code OR a.access_hint IS NOT b.access_hint
    OR a.failure_stage IS NOT b.failure_stage OR a.proxy_http_code IS NOT b.proxy_http_code)`),
  slower: responseDifference(`a.status='ok' AND b.status='ok' AND a.duration_ms>0
    AND ${delta}>=200 AND (${delta})*10>=a.duration_ms*3`),
  addressChanged: `${baselineVersion}<>${targetVersion}`,
  baselineOnly: `${baselinePresent} AND NOT (${targetPresent}) AND $targetKnown`,
  targetOnly: `${targetPresent} AND NOT (${baselinePresent}) AND $baselineKnown`,
  unchecked: `((${baselinePresent}) AND NOT (${baselineChecked})) OR ((${targetPresent}) AND NOT (${targetChecked}))`,
  unknownCoverage: `NOT (${baselinePresent}) AND NOT $baselineKnown OR NOT (${targetPresent}) AND NOT $targetKnown`,
};

const flags = (Object.keys(flagConditions) as ComparisonFlag[]).map((flag, index) => ({ flag, bit: 1 << index }));
const mask = flags.map(({ flag, bit }) => `CASE WHEN ${flagConditions[flag]} THEN ${bit} ELSE 0 END`).join(' + ');

function addressKeys(predicate: string) {
  return `
    SELECT url_id FROM results WHERE run_id=$baseline ${predicate}
    UNION
    SELECT url_id FROM results WHERE run_id=$target ${predicate}
    UNION
    SELECT url_id FROM stopped_run_targets WHERE run_id=$baseline ${predicate}
    UNION
    SELECT url_id FROM stopped_run_targets WHERE run_id=$target ${predicate}`;
}

const pairJoins = `
  FROM keys k
  LEFT JOIN results a ON a.run_id=$baseline AND a.url_id=k.url_id
  LEFT JOIN results b ON b.run_id=$target AND b.url_id=k.url_id
  LEFT JOIN stopped_run_targets ap ON ap.run_id=$baseline AND ap.url_id=k.url_id
  LEFT JOIN stopped_run_targets bp ON bp.run_id=$target AND bp.url_id=k.url_id`;

export function comparisonCoverage(db: DatabaseSync, baseline: Run, target: Run): ComparisonCoverage {
  const count = db.prepare(`SELECT
    (SELECT COUNT(*) FROM results WHERE run_id=?) +
    (SELECT COUNT(*) FROM stopped_run_targets WHERE run_id=?) AS known`);
  const known = (run: Run) => Number(count.get(run.id, run.id)?.known) >= run.total;
  return { baseline, target, baselineKnown: known(baseline), targetKnown: known(target) };
}

function comparisonBindings(coverage: ComparisonCoverage) {
  return {
    $baseline: coverage.baseline.id, $target: coverage.target.id,
    $baselineKnown: Number(coverage.baselineKnown), $targetKnown: Number(coverage.targetKnown),
  };
}

export function comparisonTotals(db: DatabaseSync, coverage: ComparisonCoverage) {
  const counters = flags.map(({ flag, bit }) => `COUNT(*) FILTER (WHERE mask & ${bit}) AS ${flag}`).join(', ');
  const result = db.prepare(`
    WITH keys AS (${addressKeys('')}), flagged AS MATERIALIZED (SELECT ${mask} AS mask ${pairJoins})
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE mask<>0) AS differences, ${counters} FROM flagged
  `).get(comparisonBindings(coverage)) as Record<'total' | 'differences' | ComparisonFlag, number>;
  const { total, differences, ...counts } = result;
  return { total, differences, counts };
}

type RawRow = Record<string, unknown> & { urlId: number; mask: number; durationDeltaMs: number | null };

function comparisonSide(row: RawRow, side: 'a' | 'b', coverageKnown: boolean): ComparisonSide {
  const prefix = side + '_';
  const field = (name: string) => row[prefix + name];
  const pending = (name: string) => row[side + 'p_' + name];
  if (typeof field('checkedAt') === 'string' && (field('status') === 'ok' || field('status') === 'error')) {
    const result = Object.fromEntries(Object.entries(row)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name.slice(prefix.length), value])) as unknown as Result;
    return { state: 'checked', result };
  }
  const url = field('url') ?? pending('url');
  if (typeof url === 'string') return {
    state: 'unchecked', url, label: String(field('label') ?? pending('label')),
    version: Number(field('version') ?? pending('version')),
  };
  return coverageKnown ? { state: 'absent' } : { state: 'unknown' };
}

function comparisonRow(row: RawRow, coverage: ComparisonCoverage): ComparisonRow {
  const { urlId, durationDeltaMs } = row;
  return { urlId, durationDeltaMs, baseline: comparisonSide(row, 'a', coverage.baselineKnown),
    target: comparisonSide(row, 'b', coverage.targetKnown),
    flags: flags.filter(({ bit }) => row.mask & bit).map(({ flag }) => flag) };
}

export function comparisonRows(db: DatabaseSync, coverage: ComparisonCoverage, filters: ComparisonFilters, after: number, limit: number) {
  const { kind = 'differences', q } = filters;
  const filter = kind === 'all' ? '1' : kind === 'differences' ? 'mask<>0' : kind === 'same' ? 'mask=0'
    : `mask & ${flags.find(({ flag }) => flag === kind)?.bit ?? 0}`;
  const search = q?.trim().toLocaleLowerCase('ru');
  const matchesSearch = search ? `AND (
    instr(lower(COALESCE(a.url, ap.url)), $search)>0
    OR (COALESCE(a.label, ap.label)<>'' AND instr(fold_address_label(COALESCE(a.label, ap.label)), $search)>0)
    OR instr(lower(COALESCE(b.url, bp.url)), $search)>0
    OR (COALESCE(b.label, bp.label)<>'' AND instr(fold_address_label(COALESCE(b.label, bp.label)), $search)>0)
  )` : '';
  const rows = db.prepare(`
    WITH keys AS (${addressKeys('AND url_id>$after')})
    SELECT k.url_id AS urlId, ${mask} AS mask,
      CASE WHEN ${sameCheckedVersion} THEN ${delta} END AS durationDeltaMs,
      ${selectResultFields('a.', 'a_')}, ${selectResultFields('b.', 'b_')},
      ap.url AS ap_url, ap.label AS ap_label, ap.version AS ap_version,
      bp.url AS bp_url, bp.label AS bp_label, bp.version AS bp_version
    ${pairJoins} WHERE (${filter}) ${matchesSearch}
    ORDER BY k.url_id LIMIT $limit
  `).all({ ...comparisonBindings(coverage), $after: after, $limit: limit, ...(search ? { $search: search } : {}) }) as RawRow[];
  return rows.map(row => comparisonRow(row, coverage));
}
