// Manifestation check before a benchmark episode: the lab must be able to
// show the trap. A failed precondition makes the outcome `failed` with
// reason precondition:<name>, never a model score. Reads only the baseline
// snapshot (no extra queries).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare } from '../schema/threshold';
import { metricValue } from '../telemetry/collect';
import type { Scenario } from '../scenarios/schema';
import type { Snapshot } from '../schema/types';
import { INTEGRITY_TABLES, loadFrozenSlices, type FrozenSlices } from '../telemetry/integrity';

const ENV = join(import.meta.dir, '..', '..', 'env');

/** Expected integrity row counts, derived from the seed files: pgbench
 *  --scale in env/seed.sh, `insert ... from generate_series(a, b)` and
 *  `delete ... where id % n in (...)` in env/seed.sql, cut at the frozen
 *  slice in env/frozen-slices.json (keys are 1..N). A test ties the result
 *  to the counts seen in 354 pilot baselines. */
export function deriveSeedRowcounts(o: { seedSh?: string; seedSql?: string; slices?: FrozenSlices | null } = {}): Record<string, number> {
  const sh = o.seedSh ?? readFileSync(join(ENV, 'seed.sh'), 'utf8'), sql = o.seedSql ?? readFileSync(join(ENV, 'seed.sql'), 'utf8');
  const slices = o.slices === undefined ? loadFrozenSlices() : o.slices;
  const scale = Number(/--scale=(\d+)/.exec(sh)?.[1]);
  if (!Number.isInteger(scale) || scale < 1) throw new Error('seed.sh: no pgbench --scale');
  const n: Record<string, number> = { pgbench_accounts: 100000 * scale, pgbench_tellers: 10 * scale, pgbench_branches: scale };
  for (const m of sql.matchAll(/insert into (\w+)\b[^;]*?generate_series\((\d+), (\d+)\) as i;/g)) n[m[1]!] = (n[m[1]!] ?? 0) + Number(m[3]) - Number(m[2]) + 1;
  for (const [t, sl] of Object.entries(slices ?? {})) if (n[t] !== undefined) n[t] = Math.min(n[t]!, sl.max);
  for (const m of sql.matchAll(/delete from (\w+) where id % (\d+) in \(([\d, ]+)\);/g)) if (n[m[1]!] !== undefined) n[m[1]!] = n[m[1]!]! * (1 - m[3]!.split(',').length / Number(m[2]));
  const missing = INTEGRITY_TABLES.filter(t => n[t] === undefined);
  if (missing.length) throw new Error(`seed files: no seed row count for: ${missing.join(', ')}`);
  return Object.fromEntries(INTEGRITY_TABLES.map(t => [t, n[t]!]));
}

// The checksum is pinned from 354 pilot baselines (2026-11-09): stable
// column bid of pgbench_branches, which needs Postgres hashing to derive.
export const SEED_EXPECT = {
  rowcounts: deriveSeedRowcounts(),
  checksum: { table: 'pgbench_branches', value: '19172484854768416271' },
};

/** [shape, target] for every line of the production menu. */
export function menuShapes(menu = join(import.meta.dir, '..', '..', 'env', 'workload', 'menus', 'W_prod.txt')): [string, 'primary' | 'standby'][] {
  return readFileSync(menu, 'utf8').split('\n').map(l => l.trim().split(/\s+/)).filter(([q]) => q && /^q\d{2}$/.test(q))
    .map(([q, , t]) => [q!, t === 's' ? 'standby' : 'primary']);
}

export function checkPreconditions(scenario: Scenario, baseline: Snapshot): string[] {
  const failed: string[] = [];
  const seedOk = Object.entries(SEED_EXPECT.rowcounts).every(([t, n]) => baseline.integrity[t]?.rowcount === n)
    && baseline.integrity[SEED_EXPECT.checksum.table]?.checksum === SEED_EXPECT.checksum.value;
  if (!seedOk) failed.push('seed');
  if (baseline.replication.intact !== true) failed.push('standby_streaming');
  if (!menuShapes().every(([q, target]) => (baseline.latency.shapes[q]?.calls ?? 0) > 0 && (baseline.latency.shapes[q]?.target ?? target) === target)) failed.push('workload_menu');
  if (scenario.env_needs.includes('E1') && !(Number(baseline.metrics.injector_primary_cycles ?? 0) > 0)) failed.push('injector');
  for (const p of scenario.preconditions ?? []) if (!compare(metricValue(baseline, p.metric, baseline), p.op, p.value)) failed.push(p.name);
  return failed;
}
