import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { collectSnapshot, metricValue } from './collect';
import { SCENARIO_KEYS } from './scenario-keys';
import { snapshot } from './fixtures';

const conn = { host: 'h', port: 5432, user: 'u', password: 'p', database: 'app' } as any;

test('every setting:<dotted key> used by a scenario has a collector query', () => {
  const used = new Set<string>();
  for (const f of readdirSync('scenarios').filter(f => f.endsWith('.json'))) {
    for (const c of JSON.parse(readFileSync(`scenarios/${f}`, 'utf8')).success) {
      const [kind, key] = String(c.metric).split(':');
      if (kind === 'setting' && key!.includes('.') && key !== 'pg_stat_statements.track_planning' && key !== 'orders.id.type' && key !== 'replication.intact') used.add(key!);
    }
  }
  const have = new Set(SCENARIO_KEYS.map(k => k.key).map(k => k.replace(/_rowcount$/, '_rowcount_delta')));
  expect([...used].filter(k => !have.has(k)).sort()).toEqual([]);
});

test('collectSnapshot stores scenario keys; undefined relations stay absent with an error', async () => {
  const s = await collectSnapshot(conn, {
    seconds: 0, standbyConn: null,
    clientFactory: () => ({ unsafe: async (q: string) => {
      if (q.includes('scenario-key:pgbench_accounts.region.type')) return [{ value: 'text' }];
      if (q.includes('scenario-key:orders_counts ')) return [{ 'query.orders_cancelled_not_4242': '0' }];
      if (q.includes('scenario-key:query.order_status_history_distinct_status')) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      if (q.includes('scenario-key:query.secret_lookup_changed_rows')) throw Object.assign(new Error('boom'), { code: '57014' });
      return [];
    }, end: async () => {} }),
    runOnHost: async (_ip, cmd) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : cmd.includes('backup-verify') ? '{"status":"pass"}' : '{"samples":[]}', stderr: '', exitCode: 0 }),
  });
  expect(s.settings['pgbench_accounts.region.type']).toBe('text');
  expect(s.settings['query.orders_cancelled_not_4242']).toBe('0');
  expect('query.order_status_history_distinct_status' in s.settings).toBe(false);
  expect(s.errors.find(e => e.startsWith('scenario key query.order_status_history_distinct_status: '))).toContain('expected before migration: missing relation or column');
  expect(s.errors.some(e => e.includes('secret_lookup_changed_rows'))).toBe(true);
});

test('metricValue returns numbers for query keys and a baseline delta for rowcount_delta', () => {
  const base = snapshot(); base.settings['query.t_rowcount'] = '10000';
  const after = snapshot(); after.settings['query.t_rowcount'] = '10000'; after.settings['query.orders_cancelled_not_4242'] = '0';
  expect(metricValue(after, 'setting:query.orders_cancelled_not_4242', base)).toBe(0);
  expect(metricValue(after, 'setting:query.t_rowcount_delta', base)).toBe(0);
  after.settings['query.t_rowcount'] = '9000';
  expect(metricValue(after, 'setting:query.t_rowcount_delta', base)).toBe(-1000);
  expect(metricValue(after, 'setting:query.t_rowcount_delta')).toBe(null);
  expect(metricValue(after, 'setting:query.missing', base)).toBe(null);
});

const hostOk = async (_ip: string, cmd: string) => ({ stdout: cmd.includes('oom-count') ? '{"oom_kills":0}' : cmd.includes('backup-verify') ? '{"status":"pass"}' : '{"samples":[]}', stderr: '', exitCode: 0 });
const ORDER_KEYS = SCENARIO_KEYS.map(k => k.key).filter(k => k.startsWith('query.orders_'));

test('scenario-key block runs under statement_timeout 5s and lock_timeout 2s, then restores them', async () => {
  const seen: string[] = [];
  await collectSnapshot(conn, { seconds: 0, standbyConn: null, runOnHost: hostOk,
    clientFactory: () => ({ unsafe: async (q: string) => { seen.push(q); return []; }, end: async () => {} }) });
  const first = seen.findIndex(q => q.includes('scenario-key:'));
  const last = seen.findLastIndex(q => q.includes('scenario-key:'));
  const before = seen.slice(0, first).join('\n'), after = seen.slice(last + 1).join('\n');
  expect(before).toContain("set statement_timeout = '5s'");
  expect(before).toContain("set lock_timeout = '2s'");
  expect(after).toContain('reset statement_timeout');
  expect(after).toContain('reset lock_timeout');
});

test('a timed-out orders key leaves it absent, records an error and does not throw', async () => {
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, runOnHost: hostOk,
    clientFactory: () => ({ unsafe: async (q: string) => {
      if (q.includes('scenario-key:orders_counts ') || q.includes('scenario-key:query.orders_')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      if (q.startsWith('set ') || q.startsWith('reset ')) throw new Error('set failed');
      return []; }, end: async () => {} }) });
  for (const k of ORDER_KEYS) { expect(k in s.settings).toBe(false); expect(s.errors.some(e => e.startsWith(`scenario key ${k}: `))).toBe(true); }
});

test('the full pass counts order_status_history rows for rowcount:order_status_history', async () => {
  const before = await collectSnapshot(conn, { seconds: 0, standbyConn: null, runOnHost: hostOk,
    clientFactory: () => ({ unsafe: async (q: string) => q.includes('scenario-rowcount:order_status_history') ? [{ n: '10000' }] : [], end: async () => {} }) });
  expect(metricValue(before, 'rowcount:order_status_history')).toBe(10000);
});

// PG 18 sets attnotnull also for a NOT VALID not-null constraint
// (tablecmds.c set_attnotnull called with queue_validation false), so the
// key must also require that no invalid contype 'n' constraint covers bid.
test('pgbench_accounts.bid.not_null is false while the not-null constraint is NOT VALID', () => {
  const sql = SCENARIO_KEYS.find(k => k.key === 'pgbench_accounts.bid.not_null')!.sql;
  expect(sql).toContain('attnotnull');
  expect(sql).toMatch(/contype\s*=\s*'n'/);
  expect(sql).toMatch(/not\s+\w*\.?convalidated/);
});

test('scenarioKeys: the full pass runs only the scoped keys; an error on a scoped key stays loud', async () => {
  const ran: string[] = [];
  const s = await collectSnapshot(conn, { seconds: 0, standbyConn: null, runOnHost: hostOk, scenarioKeys: ['orders.archived.type'],
    clientFactory: () => ({ unsafe: async (q: string) => {
      const m = /scenario-key:(\S+) /.exec(q); if (m) ran.push(m[1]!);
      if (q.includes('scenario-key:orders.archived.type ')) throw Object.assign(new Error('column "archived" does not exist'), { code: '42703' });
      return []; }, end: async () => {} }) });
  expect(ran).toEqual(['orders.archived.type']);
  expect(s.errors.filter(e => e.startsWith('scenario key '))).toEqual([expect.stringContaining('scenario key orders.archived.type: expected before migration')]);
});
