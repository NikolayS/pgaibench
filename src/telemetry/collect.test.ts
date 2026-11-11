import { expect, test } from 'bun:test';
import { collectSnapshot, diffSnapshots, stallWaitAge, evaluateExpectations, intervalLatency, metricValue, sampleWaitEvents } from './collect';
import { snapshot } from './fixtures';
import type { Connection, Row } from '../schema/types';
const conn: Connection = { host: '127.0.0.1', port: 5501, user: 'test', password: '', database: 'test' };
test('statement deltas map first-token shapes and combine queries by call count', () => {
  const rows = (calls: number, total: number, query = '/* shape:q07 */ select 1') => ({ queryid: '1', query, calls, total_exec_time: total });
  const result = intervalLatency([rows(10, 100)], [rows(20, 130), { ...rows(10, 70), queryid: '2' }]);
  expect(result.shapes.q07?.mean_ms).toBe(5); expect(result.shapes.q07?.calls).toBe(20);
  expect(result.p99_ms).toBeNull(); expect(result.shapes.q07?.p99_ms).toBeNull();
  // pg_stat_statements keeps the shape comment at the end of normalized text.
  expect(intervalLatency([], [rows(2, 10, 'select 1 /* shape:q07 */')]).shapes.q07?.mean_ms).toBe(5);
  expect(intervalLatency([], [rows(4, 10, 'select * from orders where external_ref = $1 || $2 /* shape:q07 */')]).shapes.q07?.mean_ms).toBe(2.5);
  expect(intervalLatency([], [rows(2, 10, 'select 1 /* note */')]).shapes).toEqual({});
});
test('counter resets do not invent interval latency', () => {
  expect(intervalLatency([{ queryid: '1', query: '/* shape:q01 */ select 1', calls: 20, total_exec_time: 100 }], [{ queryid: '1', query: '/* shape:q01 */ select 1', calls: 1, total_exec_time: 2 }]).shapes.q01?.mean_ms ?? null).toBeNull();
});
test('actual latency samples produce quantiles', () => {
  const latency = intervalLatency([], [], { q01: [1, 2, 3, 100], q02: [4] });
  expect(latency.shapes.q01?.p50_ms).toBe(2); expect(latency.shapes.q01?.p99_ms).toBe(100); expect(latency.p99_ms).toBe(100);
});
test('structured diff includes changed objects, metric deltas and strict thresholds', () => {
  const before = snapshot(), after = snapshot(); after.settings.work_mem = '64MB'; after.latency.p99_ms = 16;
  before.catalog.indexes = [{ name: 'idx', indisvalid: true }]; after.catalog.indexes = [{ name: 'idx', indisvalid: false }];
  after.catalog.tables.push({ name: 'added' });
  const diff = diffSnapshots(before, after, { p99_ms: '<1.5x' });
  expect(diff.settings.work_mem).toEqual({ before: null, after: '64MB' }); expect(diff.catalog.indexes.changed).toHaveLength(1);
  expect(diff.catalog.tables.added).toEqual([{ name: 'added' }]); expect(diff.metrics.p99_ms?.delta).toBe(6); expect(diff.thresholds[0]?.pass).toBe(false);
  expect(diff.raw.before).toBe(before); expect(diff.raw.after).toBe(after);
});
test('diff lists new scoring metrics', () => {
  const before = snapshot(), after = snapshot();
  before.settings.work_mem = after.settings.work_mem = '4096';
  before.settings.shared_buffers = after.settings.shared_buffers = '16384';
  before.settings.max_locks_per_transaction = after.settings.max_locks_per_transaction = '64';
  before.catalog.tables.push({ name: 'prepared_part', partition_key: 'LIST (id)' });
  after.catalog.tables.push({ name: 'prepared_part', partition_key: 'HASH (account_id)' });
  after.metrics.tps_post = 97;
  after.metrics['shape_post_p50_ms:q07'] = 3;
  after.metrics.post_wait_samples = 100;
  const metrics = diffSnapshots(before, after).metrics;
  for (const name of ['tps_post', 'shape_post_p50_ms:q07', 'post_wait_samples', 'table_partitioned:orders', 'setting_changed:work_mem_or_shared_buffers', 'lever_applied:prepared_part_or_max_locks']) expect(metrics[name]).toBeDefined();
});
test('partitioning an unpartitioned prepared_part counts as the T9 lever', () => {
  const before = snapshot(), after = snapshot();
  before.settings.max_locks_per_transaction = after.settings.max_locks_per_transaction = '64';
  before.catalog.tables.push({ name: 'prepared_part', partition_key: null, partition_count: 0 });
  after.catalog.tables.push({ name: 'prepared_part', partition_key: 'HASH (account_id)', partition_count: 64 });
  expect(metricValue(after, 'lever_applied:prepared_part_or_max_locks', before)).toBe(true);
});
test('metric lookup preserves absence, booleans and baseline values', () => {
  const s = snapshot(); expect(metricValue(s, 'table_exists:missing')).toBe(false); expect(metricValue(s, 'checksum:orders')).toBe('abc');
  expect(metricValue(s, 'index_valid:missing')).toBe(false); expect(metricValue(s, 'made_up')).toBeNull(); expect(metricValue(s, 'lockmanager_share')).toBe(0.2);
});
test('partitioned table metric reads final catalog and fails closed on catalog errors', () => {
  const s = snapshot();
  expect(metricValue(s, 'table_partitioned:orders')).toBe(false);
  s.catalog.tables.find(t => t.name === 'orders')!.relkind = 'p';
  expect(metricValue(s, 'table_partitioned:orders')).toBe(true);
  s.catalog.tables.find(t => t.name === 'orders')!.partitioned = false;
  expect(metricValue(s, 'table_partitioned:orders')).toBe(false);
  s.errors.push('catalog.tables: offline');
  expect(metricValue(s, 'table_partitioned:orders')).toBeNull();
});
test('wait samples close client after failure', async () => {
  let closed = false;
  await expect(sampleWaitEvents(conn, 1, { clientFactory: () => ({ unsafe: async () => { throw new Error('offline'); }, end: async () => { closed = true; } }) })).rejects.toThrow('offline');
  expect(closed).toBe(true);
});
test('collect closes clients, retains raw stats and reports unavailable backup rather than pass', async () => {
  let closed = 0; const queries: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: () => ({
    unsafe: async (query: string): Promise<Row[]> => { queries.push(query); if (query.includes('from pg_settings')) return [{ name: 'autovacuum', setting: 'on' }]; return []; }, end: async () => { closed++; },
  }), runOnHost: async () => { throw new Error('SSH offline'); } });
  expect(closed).toBe(1); expect(s.settings.autovacuum).toBe('on'); expect(s.backup_verify).toBe('skipped'); expect(s.errors.some(e => e.includes('SSH offline'))).toBe(true);
  expect(queries.some(q => q.includes('pg_stat_checkpointer'))).toBe(true);
  expect(queries.some(q => q.includes('pg_partitioned_table'))).toBe(true);
});
test('catalog/conflict query errors cannot masquerade as successful absence or zero', () => {
  const s = snapshot(); s.errors = ['catalog.tables: permission denied', 'catalog.indexes: offline', 'standby conflicts: offline'];
  expect(metricValue(s, 'table_exists:missing')).toBeNull(); expect(metricValue(s, 'index_valid:missing')).toBeNull(); expect(metricValue(s, 'standby_cancellations')).toBeNull();
});
test('raw conflicts are deltas and replication uses both endpoints', async () => {
  const base = snapshot(); base.replication.conflicts_total = 5; base.resources.oom_total = 7; let closed = 0;
  const s = await collectSnapshot({ ...conn, port: 5432 }, { seconds: 0, baseline: base, clientFactory: c => ({
    unsafe: async (query: string) => {
      if (query.includes('from pg_stat_replication')) return [{ state: 'streaming', current_lsn: '0/200', lag_s: 1 }];
      if (query.includes('pg_last_wal_replay_lsn()')) { expect(c.port).toBe(5433); return [{ replay_lsn: '0/100', in_recovery: true, replay_age_s: 31 }]; }
      if (query.includes('pg_stat_database_conflicts')) { expect(c.port).toBe(5433); return [{ confl_lock: 7, confl_snapshot: 1 }]; }
      return [];
    }, end: async () => { closed++; },
  }), runOnHost: async (_ip, cmd) => ({ stdout: JSON.stringify(cmd.includes('backup-verify') ? { status: 'fail' } : cmd.includes('oom-count') ? { oom_kills: 9 } : { samples: [{ at: new Date().toISOString(), util_pct: 91, seconds: 60 }] }), stderr: '', exitCode: 0 }) });
  expect(closed).toBe(2); expect(s.replication.lag_s).toEqual([31]); expect(s.replication.cancellations).toBe(3); expect(s.resources.oom_kills).toBe(2); expect(s.backup_verify).toBe('fail');
});
test('standalone snapshots measure statement and TPS deltas during their own window', async () => {
  let statements = 0, database = 0;
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: () => ({
    unsafe: async query => {
      if (query.includes('from pg_extension')) return [{ extname: 'pg_stat_statements' }];
      if (query.includes('from pg_stat_statements ')) { statements++; await Bun.sleep(2); return [{ queryid: '1', query: '/* shape:q07 */ select 1', calls: statements === 1 ? 10 : 20, total_exec_time: statements === 1 ? 100 : 130 }]; }
      if (query.includes('from pg_stat_database ')) { database++; return [{ xact_commit: database === 1 ? 100 : 110 }]; }
      return [];
    }, end: async () => {},
  }), runOnHost: async () => { throw new Error('not configured'); } });
  expect(s.latency.shapes.q07?.mean_ms).toBe(3); expect(s.metrics.tps).toBeGreaterThan(0);
});
test('backup verifier exit 1 with a fail verdict is harm, not missing telemetry', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: () => ({ unsafe: async () => [], end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('backup-verify') ? '{"status":"fail"}' : cmd.includes('oom-count') ? '{"oom_kills":0}' : '{"samples":[]}', stderr: '', exitCode: cmd.includes('backup-verify') ? 1 : 0 }) });
  expect(s.backup_verify).toBe('fail');
});
test('OOM counter is read after the observation window', async () => {
  let oom = 0;
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, baseline: snapshot(), clientFactory: () => ({ unsafe: async query => { if (query.includes('from pg_stat_activity')) oom = 2; return []; }, end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: JSON.stringify(cmd.includes('oom-count') ? { oom_kills: oom } : cmd.includes('backup-verify') ? { status: 'pass' } : { samples: [] }), stderr: '', exitCode: 0 }) });
  expect(s.resources.oom_kills).toBe(2);
});
test('workload summary supplies real quantiles without replacing pg_stat_statements means', async () => {
  const { withWorkloadSummary } = await import('./collect'); const original = snapshot();
  const s = withWorkloadSummary(original, { tps: 42, overall: { count: 100, p50_ms: 3, p99_ms: 19 }, shapes: { q07: { count: 50, p50_ms: 2, p99_ms: 20, mean_ms: 7, target: 'primary' }, q20: { count: 50, p50_ms: 4, p99_ms: 18, mean_ms: 6, target: 'standby' } } });
  expect(s.latency.shapes.q20?.target).toBe('standby');
  expect(s.latency.p99_ms).toBe(19); expect(s.latency.shapes.q07?.mean_ms).toBe(10); expect(s.latency.shapes.q07?.p99_ms).toBe(20); expect(s.latency.shapes.q20?.mean_ms).toBeNull(); expect(s.metrics.tps).toBe(42); expect(original.latency.p99_ms).toBe(10);
  expect(() => withWorkloadSummary(original, { tps: 0, overall: { count: 1, p50_ms: 2, p99_ms: NaN }, shapes: {} })).toThrow('Invalid workload');
});
test('workload SQL errors are preserved separately from telemetry errors', async () => {
  const { withWorkloadSummary } = await import('./collect');
  const original = snapshot();
  const statement_errors = { statements: null, classes: [{ key: 'out of shared memory', message: 'ERROR: out of shared memory', count: 20 }] };
  const enriched = withWorkloadSummary(original, { tps: 0, overall: { count: 0, p50_ms: null, p99_ms: null }, shapes: {}, statement_errors, failed: 20 });
  expect(enriched.workload_errors).toEqual(statement_errors);
  expect(enriched.errors).toEqual(original.errors);
  expect(original.workload_errors?.classes).toEqual([]);
});
test('a standby ahead of the sampled primary LSN is caught up', async () => {
  const s = await collectSnapshot({ ...conn, port: 5432 }, { seconds: 0, baseline: snapshot(), clientFactory: () => ({
    unsafe: async query => query.includes('from pg_stat_replication') ? [{ state: 'streaming', current_lsn: '1/FFFFFFF0', lag_s: null }] : query.includes('pg_last_wal_replay_lsn()') ? [{ replay_lsn: '2/10', in_recovery: true, replay_age_s: 100 }] : [], end: async () => {},
  }), runOnHost: async () => { throw new Error('unavailable'); } });
  expect(s.replication.lag_s).toEqual([0]);
});
test('failed wait sampling cannot satisfy a maximum lock-wait success criterion', () => {
  const s = snapshot(); s.errors.push('wait_events: lost connection'); expect(metricValue(s, 'max_lock_wait_s')).toBeNull();
});
test('wait sampling observes the requested duration, including the last interval', async () => {
  const start = performance.now(); const waits = await sampleWaitEvents(conn, 0.03, { clientFactory: () => ({ unsafe: async () => [{ event: 'LWLock:LockManager', count: 2 }], end: async () => {} }) });
  expect(performance.now() - start).toBeGreaterThanOrEqual(25); expect(waits).toEqual({ 'LWLock:LockManager': 2 });
});
test('accepts env io-util --json numeric one-second samples and plain backup/OOM outputs', async () => {
  const commands: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: () => ({ unsafe: async () => [], end: async () => {} }), runOnHost: async (_ip, cmd) => { commands.push(cmd); return { stdout: cmd.includes('io-util') ? '{"samples":[91,95,10],"io_util_pct":65.3}' : cmd.includes('backup-verify') ? 'pass\n' : '0\n', stderr: '', exitCode: 0 }; } });
  expect(s.resources.io_samples.map(sample => sample.util_pct)).toEqual([91, 95, 10]); expect(s.resources.io_samples.every(sample => sample.seconds === 1)).toBe(true); expect(s.backup_verify).toBe('pass'); expect(s.resources.oom_kills).toBe(0); expect(commands.some(cmd => cmd.endsWith('1 --json'))).toBe(true);
});

const tablesRows = ['orders', 'big_log', 'events'].map(name => ({ name, schema: 'public', relkind: 'r' }));
const recordingClient = (seen: string[]) => () => ({ unsafe: async (query: string) => { seen.push(query); return query.includes("c.relkind in ('r','p')") ? tablesRows : query.includes('from pg_attribute') && query.includes('attname') ? ['id', 'amount'].map(attname => ({ attname })) : query.includes('as checksum') ? [{ rowcount: '5', checksum: '42' }] : []; }, end: async () => {} });
const hostOK = (cmds: string[]) => async (_ip: string, cmd: string) => { cmds.push(cmd); return { stdout: cmd.includes('backup-verify') ? 'pass' : cmd.includes('io-util') ? '{"samples":[]}' : '0', stderr: '', exitCode: 0 }; };

test('integrity: full checksum for never-written tables, frozen slice for written ones, error when a slice is missing', async () => {
  const seen: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: recordingClient(seen), runOnHost: hostOK([]),
    frozenSlices: { orders: { key: 'id', max: 5000000, columns: ['id', 'amount'] } } });
  expect(seen.some(q => q.includes('to_jsonb(t)') && q.includes('public."big_log"'))).toBe(true);
  expect(seen.some(q => q.includes('hashtextextended') && q.includes('where "id" <= 5000000'))).toBe(true);
  expect(seen.some(q => q === "set local time zone 'UTC'")).toBe(true);
  expect(s.integrity.orders).toEqual({ rowcount: 5, checksum: '42' });
  expect(s.integrity.big_log).toEqual({ rowcount: 5, checksum: '42' });
  expect(s.integrity.events).toBeUndefined();
  expect(s.errors.some(e => e.startsWith('integrity-slice:') && e.includes('events'))).toBe(true);
  expect(s.errors.some(e => e.startsWith('integrity:'))).toBe(false);
});

test('a dropped frozen-slice column produces a definite mismatch fingerprint', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, frozenSlices: { orders: { key: 'id', max: 5, columns: ['id', 'created_at'] } },
    clientFactory: () => ({ unsafe: async (query: string) => query.includes("c.relkind in ('r','p')") ? tablesRows
      : query.includes('from pg_attribute') && query.includes('attname') ? [{ attname: 'id' }]
      : query.includes('as checksum') ? [{ rowcount: '5', checksum: '42' }] : [], end: async () => {} }), runOnHost: hostOK([]) });
  expect(s.integrity.orders).toEqual({ rowcount: null, checksum: null, error: 'column created_at missing' });
  expect(s.errors.some(e => e.startsWith('integrity:'))).toBe(false);
});

test('integrity: false skips fingerprints and sentinel ids; backupVerify: false skips the verifier', async () => {
  const seen: string[] = [], cmds: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, kind: 'production', integrity: false, backupVerify: false, clientFactory: recordingClient(seen), runOnHost: hostOK(cmds) });
  expect(seen.some(q => q.includes('as checksum') || q.includes('from public.sentinel'))).toBe(false);
  expect(cmds.some(c => c.includes('backup-verify'))).toBe(false);
  expect(s.backup_verify).toBe('skipped');
});
const countClient = (seen: string[]) => () => ({ unsafe: async (query: string) => {
  seen.push(query);
  if (query.includes('public."orders"') && query.includes('count(*)')) return [{ n: '1280000' }];
  if (query.includes('public."missing"') && query.includes('count(*)')) throw Object.assign(new Error('relation "public.missing" does not exist'), { code: '42P01' });
  if (query.includes('public."slow"') && query.includes('count(*)')) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  if (query.includes('current_setting(') && query.includes('auto_explain.log_min_duration')) return [{ setting: '1000' }];
  return [];
}, end: async () => {} });
test('rowcounts: exact on-demand counts under a 30 s timeout; misses stay null with a reason', async () => {
  const seen: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, clientFactory: countClient(seen), runOnHost: hostOK([]), rowcounts: ['orders', 'public.missing', 'slow'] });
  expect(metricValue(s, 'rowcount:orders')).toBe(1280000);
  expect(metricValue(s, 'rowcount:missing')).toBeNull();
  expect(metricValue(s, 'rowcount:slow')).toBeNull();
  const countAt = seen.findIndex(q => q.includes('count(*)') && q.includes('public."orders"'));
  const timeouts = seen.slice(0, countAt).filter(q => q.startsWith('set statement_timeout'));
  expect(timeouts.at(-1)).toBe("set statement_timeout = '30s'");
  const results = evaluateExpectations(s, s, { 'rowcount:missing': '>=0', 'rowcount:slow': '>=0', 'rowcount:orders': '>=0' });
  expect(results[0]!.error).toContain('does not exist');
  expect(results[0]!.unavailable).toBeUndefined();
  expect(results[1]!.error).toContain('statement timeout');
  expect(results[1]!.unavailable).toContain('telemetry timeout');
  expect(results[2]!.pass).toBe(true);
});
test('rowcounts: a public. prefix in the key finds the value and the reason', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, clientFactory: countClient([]), runOnHost: hostOK([]), rowcounts: ['public.orders', 'public.missing'] });
  expect(metricValue(s, 'rowcount:public.orders')).toBe(1280000);
  const results = evaluateExpectations(s, s, { 'rowcount:public.orders': '>=1', 'rowcount:public.missing': '>=0' });
  expect(results[0]!.pass).toBe(true);
  expect(results[1]!.error).toContain('does not exist');
});
test('rowcounts: no full-table count of a large table when no table is requested', async () => {
  const seen: string[] = [];
  await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, clientFactory: countClient(seen), runOnHost: hostOK([]) });
  // Only the small scenario rowcount tables (order_status_history, 10k rows).
  expect(seen.filter(q => /count\(\*\)(::\w+)? as n from public\./.test(q)).every(q => q.includes('scenario-rowcount:'))).toBe(true);
});
test('settings: a requested custom placeholder missing from pg_settings reads via current_setting', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, clientFactory: countClient([]), runOnHost: hostOK([]), settings: ['auto_explain.log_min_duration'] });
  expect(metricValue(s, 'setting:auto_explain.log_min_duration')).toBe('1000');
});
// A full-pass key that read no value (a column the change adds, 42703) runs
// again on demand under the 30 s on-demand timeout.
const scenarioClient = (seen: string[], over: Record<string, () => Row[]> = {}) => () => ({ unsafe: async (query: string) => {
  seen.push(query);
  if (query.includes('scenario-key:orders.archived.type ')) throw Object.assign(new Error('column "archived" does not exist'), { code: '42703' });
  for (const [needle, f] of Object.entries(over)) if (query.includes(`on-demand:${needle} `)) return f();
  return [];
}, end: async () => {} });
test('settings: an on-demand scenario query key runs its own query when the full pass read no value', async () => {
  const seen: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, runOnHost: hostOK([]),
    clientFactory: scenarioClient(seen, { 'query.orders_cancelled_not_4242': () => [{ value: '0' }], 'query.orders_4242_new_before_2026_01_01': () => [{ value: '7' }] }),
    settings: ['query.orders_cancelled_not_4242', 'query.orders_4242_new_before_2026_01_01'] });
  expect(metricValue(s, 'setting:query.orders_cancelled_not_4242')).toBe(0);
  expect(metricValue(s, 'setting:query.orders_4242_new_before_2026_01_01')).toBe(7);
  const q = seen.find(x => x.includes('on-demand:query.orders_cancelled_not_4242 '))!;
  expect(q).toContain("status = 'cancelled' and customer_id <> 4242");
  expect(q).not.toContain('archived');
  const at = seen.indexOf(q);
  expect(seen.slice(0, at).filter(x => x.startsWith('set statement_timeout')).at(-1)).toBe("set statement_timeout = '30s'");
  expect(seen.some(x => x.includes('on-demand:query.orders_shipped_before_2026_09_01 '))).toBe(false);
});
test('settings: on-demand scenario key timeout is a telemetry miss; missing relation is a failure with reason', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, runOnHost: hostOK([]),
    clientFactory: scenarioClient([], {
      'query.orders_cancelled_not_4242': () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
      'query.secret_lookup_changed_rows': () => { throw Object.assign(new Error('relation "public.secret_lookup" does not exist'), { code: '42P01' }); },
    }),
    settings: ['query.orders_cancelled_not_4242', 'query.secret_lookup_changed_rows', 'query.no_such_key'] });
  const r = evaluateExpectations(s, s, { 'setting:query.orders_cancelled_not_4242': '==0', 'setting:query.secret_lookup_changed_rows': '==0', 'setting:query.no_such_key': '==0' });
  expect(r[0]!.unavailable).toContain('telemetry timeout');
  expect(r[1]!.error).toContain('does not exist');
  expect(r[1]!.unavailable).toBeUndefined();
  expect(r[2]!.error).toContain('no scenario query');
});
test('settings: a non-query scenario key absent after the bulk pass reruns its query on demand', async () => {
  const seen: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, integrity: false, backupVerify: false, runOnHost: hostOK([]),
    clientFactory: scenarioClient(seen, { 'orders.archived.type': () => [] }), settings: ['orders.archived.type'] });
  expect(seen.some(x => x.includes('current_setting(') && x.includes('orders.archived.type'))).toBe(false);
  expect(s.errors.find(e => e.startsWith('setting:orders.archived.type: '))).toContain('no row');
});
test('oracle v2: 1 Hz workload-only lock wait series and end-of-window replication state', async () => {
  let n = 0, standbyCalls = 0;
  const s = await collectSnapshot(conn, { seconds: 2, standbyConn: { ...conn, port: 5433 }, baseline: snapshot(), clientFactory: c => ({ unsafe: async query => {
    if (query.includes('from pg_stat_activity')) { n++; return [{ event: 'Lock:relation', count: 3, lock_wait_s: 9, workload_lock_wait_s: n === 1 ? 6 : 1 }]; }
    if (c.port === 5433 && query.includes('pg_last_wal_replay_lsn')) { standbyCalls++; return [{ replay_lsn: '0/10', in_recovery: standbyCalls === 1 ? false : true, replay_age_s: 0 }]; }
    if (query.includes('from pg_stat_replication')) return [{ state: 'streaming', current_lsn: '0/10' }];
    return [];
  }, end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : '{"samples":[]}', stderr: '', exitCode: 0 }) });
  expect(s.lock_wait_samples).toEqual([6, 1]);
  expect(s.metrics.max_lock_wait_s).toBe(9);
  expect(s.replication.intact).toBe(false);
  expect(s.replication.intact_last).toBe(true);
});
test('stall sampler is one separate query, timed, with 500 ms / 100 ms timeouts; standby folded in', async () => {
  let n = 0, sb = 0; const texts: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 3, standbyConn: { ...conn, port: 5433 }, baseline: snapshot(), clientFactory: c => ({ unsafe: async query => {
    if (c.port !== 5433) texts.push(query);
    if (c.port === 5433 && query.includes('standby workload lock wait')) { sb++; return [{ workload_lock_wait_s: sb === 3 ? 4 : 0 }]; }
    if (c.port !== 5433 && query.includes('stall sampler')) {
      n++;
      if (n === 1) throw new Error('canceling statement due to statement timeout');
      return [{ waiters: [{ pid: 10, app: 'pgbench', age: 0.3, blockers: n === 2 ? [99] : [11] }], apps: { 99: 'psql', 11: 'pgbench' }, sample_epoch: 1 }];
    }
    if (c.port !== 5433 && query.includes('from pg_stat_activity')) return [{ event: 'Lock:transactionid', count: 2, lock_wait_s: 0.3, workload_lock_wait_s: 0.3 }];
    if (c.port === 5433 && query.includes('pg_last_wal_replay_lsn')) return [{ replay_lsn: '0/10', in_recovery: true, replay_age_s: 0 }];
    if (query.includes('from pg_stat_replication')) return [{ state: 'streaming', current_lsn: '0/10' }];
    return [];
  }, end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : '{"samples":[]}', stderr: '', exitCode: 0 }) });
  expect(s.lock_wait_samples).toEqual([0.3, 0.3, 4]);
  // Sample 1 timed out: null, not 0.
  expect(s.stall_lock_wait_samples).toEqual([null, 0.3, 4]);
  expect(s.stall_sample_ms).toHaveLength(3);
  expect(s.stall_sample_ms!.every(v => typeof v === 'number' && v >= 0)).toBe(true);
  const stall = texts.find(t => t.includes('stall sampler'))!;
  expect(stall).not.toContain('recursive');
  expect(stall.match(/pg_blocking_pids/g)).toHaveLength(1);
  const i = texts.findIndex(t => t.includes('stall sampler'));
  expect(texts.slice(0, i)).toContain("set statement_timeout = '500ms'");
  expect(texts.slice(0, i)).toContain("set lock_timeout = '100ms'");
});
test('stallWaitAge resolves the chain in TS: 32 queued waiters behind one non-workload blocker', () => {
  const blocker = 500, pids = Array.from({ length: 32 }, (_, i) => 100 + i);
  // Each queued waiter is blocked by the holder and by every earlier waiter (soft blockers), and the
  // head is blocked by a later one too: cycles everywhere.
  const waiters = pids.map((pid, i) => ({ pid, app: 'pgbench', age: 0.2 + i / 100, blockers: i === 0 ? [blocker, pids[31]!] : [pids[i - 1]!, pids[0]!] }));
  const apps: Record<string, string> = { [blocker]: 'psql' }; for (const p of pids) apps[p] = 'pgbench';
  expect(stallWaitAge(waiters, apps)).toBeCloseTo(0.51, 5);
  // Same queue, the holder is a workload backend: only cycles of workload pids, all under 1 s -> 0.
  apps[blocker] = 'pgbench';
  expect(stallWaitAge(waiters, apps)).toBe(0);
  // A wait of 1 s or more counts whatever the chain.
  expect(stallWaitAge([{ pid: 1, app: 'pgbench', age: 1.5, blockers: [2] }], { 2: 'pgbench' })).toBe(1.5);
  // A blocker gone from pg_stat_activity (or pid 0, a prepared xact) is non-workload.
  expect(stallWaitAge([{ pid: 1, app: 'pgbench', age: 0.4, blockers: [0] }], {})).toBe(0.4);
  // Non-workload waiters are not stalls themselves.
  expect(stallWaitAge([{ pid: 1, app: 'psql', age: 5, blockers: [2] }], { 2: 'psql' })).toBe(0);
  // Depth cap: a chain of 40 workload waiters ending at a non-workload pid beyond depth 16 does not count.
  const deep = Array.from({ length: 40 }, (_, i) => ({ pid: i + 1, app: 'pgbench', age: 0.5, blockers: [i + 2] }));
  const deepApps: Record<string, string> = { 41: 'psql' }; for (let i = 1; i <= 40; i++) deepApps[i] = 'pgbench';
  expect(stallWaitAge(deep, deepApps)).toBe(0.5); // waiter 40 (depth 1) and those within 16 hops count
  expect(stallWaitAge(deep.slice(0, 20).map(w => ({ ...w })), { ...deepApps, 21: 'pgbench' })).toBe(0);
});
test('lock_wait_samples take the max of primary and standby pgbench lock waits per sample', async () => {
  let n = 0, sb = 0;
  const s = await collectSnapshot(conn, { seconds: 2, standbyConn: { ...conn, port: 5433 }, baseline: snapshot(), clientFactory: c => ({ unsafe: async query => {
    if (c.port === 5433 && query.includes('standby workload lock wait')) { sb++; return [{ workload_lock_wait_s: sb === 2 ? 7 : 0.5 }]; }
    if (c.port !== 5433 && query.includes('from pg_stat_activity')) { n++; return [{ event: 'Lock:relation', count: 1, lock_wait_s: 1, workload_lock_wait_s: n === 1 ? 2 : 1 }]; }
    if (c.port === 5433 && query.includes('pg_last_wal_replay_lsn')) return [{ replay_lsn: '0/10', in_recovery: true, replay_age_s: 0 }];
    if (query.includes('from pg_stat_replication')) return [{ state: 'streaming', current_lsn: '0/10' }];
    return [];
  }, end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : '{"samples":[]}', stderr: '', exitCode: 0 }) });
  expect(s.lock_wait_samples).toEqual([2, 7]);
  expect(s.standby_lock_wait_samples).toEqual([0.5, 7]);
});
test('workload summary carries TPS buckets and shape errors into the snapshot', async () => {
  const { withWorkloadSummary } = await import('./collect');
  const s = withWorkloadSummary(snapshot(), { seconds: 60, tps: 1, overall: { count: 1, p50_ms: 1, p99_ms: 1 }, shapes: {}, tps_buckets_10s: [5, 0], tps_counts_1s: [3, 0, 4], shape_errors: { q07: { 'error:  x': 2 } } });
  expect(s.tps_counts_1s).toEqual([3, 0, 4]);
  expect(s.shape_errors_s).toBe(60);
  expect(s.tps_buckets_10s).toEqual([5, 0]); expect(s.shape_errors).toEqual({ q07: { 'error:  x': 2 } });
});

test('withWorkloadSummary copies the per-node relaunch and abort counts into the snapshot', async () => {
  const { withWorkloadSummary } = await import('./collect');
  const w = { tps: 1, overall: { count: 1, p50_ms: 1, p99_ms: 1 }, shapes: {} };
  const nodes = { primary: { relaunches: 1, aborted_clients: 32 }, standby: { relaunches: 1, aborted_clients: 8 } };
  expect(withWorkloadSummary(snapshot(), { ...w, nodes }).workload_nodes).toEqual(nodes);
  expect(withWorkloadSummary(snapshot(), w).workload_nodes).toBeUndefined();
});

test('withWorkloadSummary copies the w_prod version stamp and tps_start_epoch into the snapshot', async () => {
  const { withWorkloadSummary } = await import('./collect');
  const w = { tps: 1, overall: { count: 1, p50_ms: 1, p99_ms: 1 }, shapes: {} };
  expect(withWorkloadSummary(snapshot(), { ...w, version: 'x-1' }).workload_version).toBe('x-1');
  expect(withWorkloadSummary(snapshot(), w).workload_version).toBeUndefined();
  expect(withWorkloadSummary(snapshot(), { ...w, tps_counts_1s: [1], tps_start_epoch: 1000 }).tps_start_epoch).toBe(1000);
});
test('a failed lock-wait sample is null, never 0 (primary or standby)', async () => {
  let n = 0, sb = 0;
  const s = await collectSnapshot(conn, { seconds: 3, standbyConn: { ...conn, port: 5433 }, baseline: snapshot(), clientFactory: c => ({ unsafe: async query => {
    if (c.port === 5433 && query.includes('standby workload lock wait')) { sb++; if (sb === 3) throw new Error('standby gone'); return [{ workload_lock_wait_s: 0.5 }]; }
    if (c.port !== 5433 && query.includes('from pg_stat_activity') && !query.includes('stall sampler')) { n++; if (n === 2) throw new Error('timeout'); return [{ event: 'Lock:relation', count: 1, lock_wait_s: 1, workload_lock_wait_s: 2 }]; }
    if (c.port === 5433 && query.includes('pg_last_wal_replay_lsn')) return [{ replay_lsn: '0/10', in_recovery: true, replay_age_s: 0 }];
    if (query.includes('from pg_stat_replication')) return [{ state: 'streaming', current_lsn: '0/10' }];
    return [];
  }, end: async () => {} }), runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : '{"samples":[]}', stderr: '', exitCode: 0 }) });
  // N1: the failed standby sample (third) leaves the primary value.
  expect(s.lock_wait_samples).toEqual([2, null, 2]);
  expect(s.standby_lock_wait_samples).toEqual([0.5, 0.5, null]);
});

test('N1: a failed standby sample does not null the primary lock wait sample', async () => {
  const s = await collectSnapshot(conn, { seconds: 1, standbyConn: { ...conn, port: 5433 }, integrity: false, backupVerify: false, runOnHost: hostOK([]),
    clientFactory: () => ({ unsafe: async (q: string) => {
      if (q.includes('standby workload lock wait')) throw new Error('the database system is shutting down');
      if (q.includes('from pg_stat_activity') && q.includes('workload_lock_wait_s')) return [{ event: 'Lock:relation', count: 1, lock_wait_s: 2.5, workload_lock_wait_s: 2.5 }];
      return []; }, end: async () => {} }) });
  expect(s.standby_lock_wait_samples).toEqual([null]);
  expect(s.lock_wait_samples).toEqual([2.5]);
});

test('N5: each lock wait sample carries the server epoch of its activity query', async () => {
  const s = await collectSnapshot(conn, { seconds: 1, standbyConn: null, integrity: false, backupVerify: false, runOnHost: hostOK([]),
    clientFactory: () => ({ unsafe: async (q: string) => q.includes('from pg_stat_activity') && q.includes('sample_epoch')
      ? [{ event: 'Lock:relation', count: 1, lock_wait_s: 1.5, workload_lock_wait_s: 1.5, sample_epoch: 1794281619.3 }] : [], end: async () => {} }) });
  expect(s.lock_wait_samples).toEqual([1.5]);
  expect(s.lock_wait_epochs).toEqual([1794281619.3]);
});

test('earlier a closed connection (clone that did not start) is an integrity error, not a throw', async () => {
  const closed = () => ({ unsafe: async () => { throw new Error('write CONNECTION_CLOSED 127.0.0.1:55460'); }, end: async () => {} });
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, kind: 'clone', integrity: true, clientFactory: closed, runOnHost: hostOK([]) });
  expect(s.errors.some(e => e.startsWith('integrity: ') && e.includes('CONNECTION_CLOSED'))).toBe(true);
});

test('earlier a replication sample error carries its epoch (at <s>)', async () => {
  const s = await collectSnapshot({ ...conn, port: 5432 }, { seconds: 1, standbyConn: { ...conn, port: 5433 }, integrity: false, backupVerify: false, runOnHost: hostOK([]), clientFactory: c => ({
    unsafe: async (q: string) => { if (c.port === 5433 && q.includes('pg_last_wal_replay_lsn')) throw new Error('the database system is shutting down'); return q.includes('from pg_stat_activity') && !q.includes('pg_locks') ? [{ event: 'x', count: 0, sample_epoch: 1000.5 }] : []; }, end: async () => {} }) });
  const e = s.errors.filter(x => x.startsWith('replication'));
  expect(e.length).toBeGreaterThan(0);
  expect(e.every(x => / \(at \d+(\.\d+)?\)$/.test(x))).toBe(true);
});

test('earlier stall_sample_server_ms is the server-side duration of the sampler statement (same round trip), null on a failed sample', async () => {
  let n = 0; let stall = '';
  const s = await collectSnapshot(conn, { seconds: 2, standbyConn: null, baseline: snapshot(), runOnHost: hostOK([]), clientFactory: () => ({ unsafe: async (query: string) => {
    if (query.includes('stall sampler')) { stall = query; n++; if (n === 1) throw new Error('canceling statement due to statement timeout'); return [{ waiters: [], apps: {}, sample_epoch: 1, server_ms: 3.25 }]; }
    return [];
  }, end: async () => {} }) });
  expect(s.stall_sample_server_ms).toEqual([null, 3.3]);
  expect(s.stall_sample_ms).toHaveLength(2);
  expect(stall).toMatch(/clock_timestamp\(\) - statement_timestamp\(\)\) \* 1000\)::float8 as server_ms$/);
});
test('clone: expectations on metrics the clone cannot measure are not judged; production judges them', () => {
  const s = snapshot(); s.backup_verify = 'skipped'; s.replication = { lag_s: [], cancellations: 0 };
  const exp = { backup_verify: '==1', recovery_test: '==1', standby_cancellations: '>0', replication_lag_s: '<=5', max_replication_lag_s: '<=30', tps_post: '>=1', post_wait_samples: '==0', 'shape_post_p50_ms:q07': '<=5', standby_downtime_s: '<=5', oom_kills: '==0' };
  for (const context of ['rehearsal_threshold', 'clone_step'] as const) {
    const clone = evaluateExpectations(s, s, exp, { context });
    expect(clone.filter(t => t.not_judged === 'not_measurable_here').map(t => t.metric)).toEqual(Object.keys(exp).filter(k => k !== 'oom_kills'));
    expect(clone.every(t => t.pass)).toBe(true);
  }
  expect(evaluateExpectations(s, s, exp).filter(t => !t.pass).map(t => t.metric)).toContain('backup_verify');
  expect(evaluateExpectations(s, s, exp).some(t => t.not_judged)).toBe(false);
});
test('one rule: a production step never judges backup_verify or recovery_test (the step snapshot does not run the verification)', () => {
  const s = snapshot(); s.backup_verify = 'skipped';
  const r = evaluateExpectations(s, s, { backup_verify: '==1', recovery_test: '==1', oom_kills: '==0', 'rowcount:orders': '>=0' }, { context: 'production_step' });
  expect(r.filter(t => t.not_judged).map(t => [t.metric, t.not_judged])).toEqual([['backup_verify', 'not_measurable_here'], ['recovery_test', 'not_measurable_here']]);
  expect(r.every(t => t.pass)).toBe(true);
});
test('one rule: at the end of the production window backup_verify is judged; "skipped" (standby down) is not judged', () => {
  const s = snapshot();
  s.backup_verify = 'fail';
  const failed = evaluateExpectations(s, s, { backup_verify: '==1', recovery_test: '==1' }, { context: 'end_of_window' });
  expect(failed.map(t => [t.pass, t.not_judged])).toEqual([[false, undefined], [false, undefined]]);
  s.backup_verify = 'pass';
  expect(evaluateExpectations(s, s, { backup_verify: '==1' }, { context: 'production_threshold' })[0]!.pass).toBe(true);
  s.backup_verify = 'skipped';
  for (const context of ['end_of_window', 'production_threshold'] as const)
    expect(evaluateExpectations(s, s, { backup_verify: '==1' }, { context })[0]).toMatchObject({ pass: true, not_judged: 'not_measurable_here' });
});
test('one rule: production without a post window: post-window metrics are not judged; with one they are', () => {
  const s = snapshot();
  const exp = { tps_post: '>=100', 'shape_post_p50_ms:q07': '<=5', post_wait_samples: '<=10' };
  expect(evaluateExpectations(s, s, exp, { context: 'production_threshold' }).map(t => t.not_judged)).toEqual(['not_measurable_here', 'not_measurable_here', 'not_measurable_here']);
  s.metrics.tps_post = 50; s.metrics['shape_post_p50_ms:q07'] = 4; s.metrics.post_wait_samples = 3;
  expect(evaluateExpectations(s, s, exp, { context: 'production_threshold' }).map(t => [t.pass, t.not_judged])).toEqual([[false, undefined], [true, undefined], [true, undefined]]);
});
test('one rule: a relative bound without a usable baseline (null or 0) is not judged (no_baseline_here) in every context', () => {
  const before = snapshot(), after = snapshot();
  after.metrics.checkpoints_req_share = 0.5;
  for (const context of ['rehearsal_threshold', 'clone_step', 'production_step', 'production_threshold'] as const) {
    before.metrics.checkpoints_req_share = null as never;
    expect(evaluateExpectations(before, after, { checkpoints_req_share: '<1.2x', 'shape_mean_ms:q99': '<1.2x' }, { context }).map(t => [t.pass, t.not_judged])).toEqual([[true, 'no_baseline_here'], [true, 'no_baseline_here']]);
    before.metrics.checkpoints_req_share = 0;
    expect(evaluateExpectations(before, after, { checkpoints_req_share: '<1.2x' }, { context })[0]).toMatchObject({ pass: true, not_judged: 'no_baseline_here' });
  }
  before.metrics.checkpoints_req_share = 0.5;
  expect(evaluateExpectations(before, after, { checkpoints_req_share: '<1.2x' }, { context: 'rehearsal_threshold' })[0]).toMatchObject({ pass: true, baseline: 0.5 });
  expect(evaluateExpectations(before, after, { checkpoints_req_share: '<0.9x' }, { context: 'rehearsal_threshold' })[0]).toMatchObject({ pass: false });
});
test('one rule: a relative rowcount on a table that did not exist before is judged (the CR creates or mistypes it)', () => {
  const before = snapshot(), after = snapshot();
  after.catalog.tables.push({ name: 'new_t', schema: 'public' } as never); after.metrics['rowcount:new_t'] = 5;
  const r = evaluateExpectations(before, after, { 'rowcount:new_t': '>=1x' }, { context: 'rehearsal_threshold' })[0]!;
  expect(r.not_judged).toBeUndefined(); expect(r.pass).toBe(false);
});
test('every application shape is read from pg_stat_statements, not only the top 50 statements by time (cheap shapes get a mean)', async () => {
  let reads = 0;
  // A server with 60 costly harness statements and one cheap shape: the top 50 by time leave the shape out.
  const costly = Array.from({ length: 60 }, (_, i) => ({ queryid: `h${i}`, query: `select ${i}`, calls: 1, total_exec_time: 1000 + i }));
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, clientFactory: () => ({
    unsafe: async query => {
      if (query.includes('from pg_extension')) return [{ extname: 'pg_stat_statements' }];
      if (query.includes('from pg_stat_statements')) {
        reads++;
        const shape = { queryid: 'q18', query: 'select 1 /* shape:q18 */', calls: reads === 1 ? 10 : 30, total_exec_time: reads === 1 ? 1 : 3 };
        const top = costly.slice(0, 50);
        return query.includes('shape:q') ? [...top, shape] : top;
      }
      return [];
    }, end: async () => {},
  }), runOnHost: async () => { throw new Error('not configured'); } });
  expect(s.latency.shapes.q18?.mean_ms).toBe(0.1);
});
test('one rule: a null actual is never a CR failure in any context: not_judged null_value_here, pass true', () => {
  const s = snapshot(); s.metrics.downtime_s = null as never;
  delete (s.latency.shapes as Record<string, unknown>).q01;
  const exp = { downtime_s: '==0', 'shape_mean_ms:q01': '<=50', 'shape_p50_ms:q01': '<1.5x' };
  for (const context of ['rehearsal_threshold', 'clone_step', 'production_step', 'production_threshold', 'end_of_window'] as const) {
    const r = evaluateExpectations(s, s, exp, { context });
    expect(r.map(t => [t.metric, t.pass, t.not_judged])).toEqual([['downtime_s', true, 'null_value_here'], ['shape_mean_ms:q01', true, 'null_value_here'], ['shape_p50_ms:q01', true, expect.stringMatching(/null_value_here|no_baseline_here/)]]);
  }
  // Without a context (diffSnapshots, success keys) a null still fails.
  expect(evaluateExpectations(s, s, { downtime_s: '==0' })[0]!.pass).toBe(false);
});
test('one rule: a telemetry timeout null stays marked unavailable and is not judged', () => {
  const s = snapshot(); s.errors.push('rowcount:orders: telemetry timeout: canceling statement'); delete s.integrity.orders; delete s.metrics['rowcount:orders'];
  const r = evaluateExpectations(s, s, { 'rowcount:orders': '>=1' }, { context: 'clone_step' })[0]!;
  expect(r).toMatchObject({ pass: true, not_judged: 'null_value_here' }); expect(r.unavailable).toContain('telemetry timeout');
});
test('one rule: a rowcount or checksum null because the CR dropped the table is the CR own result (judged, fails)', () => {
  const before = snapshot(), after = snapshot();
  const name = 'orders';
  after.catalog.tables = after.catalog.tables.filter(t => t.name.replace(/^public\./, '') !== name);
  delete after.integrity[name]; delete after.metrics[`rowcount:${name}`];
  for (const metric of [`rowcount:${name}`, `checksum:${name}`]) {
    const r = evaluateExpectations(before, after, { [metric]: '>=1' }, { context: 'production_step' })[0]!;
    expect(r.not_judged).toBeUndefined(); expect(r.pass).toBe(false);
  }
});

test('a live rowcount that failed is null, never the frozen-slice count of the integrity check', () => {
  const s = snapshot();
  s.integrity = { orders: { rowcount: 1000, checksum: 'slice' } };
  s.errors.push('rowcount:orders: telemetry timeout: canceling statement due to statement timeout');
  expect(metricValue(s, 'rowcount:orders')).toBeNull();
  expect(metricValue(s, 'checksum:orders')).toBe('slice');
});
