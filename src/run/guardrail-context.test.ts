import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGuardrailContext, collectFacts, crGucs, crIdentifiers, emptyFacts, loadWorkloadTexts, pgssTexts, type GuardrailFacts } from './guardrail-context';
import { goodCR } from './fixtures/good-cr';
import { snapshot } from '../telemetry/fixtures';
import type { CR, Row, TelemetryRecord } from './types';

const cr = (sql: string[], config: [string, string][] = []): CR => ({ ...structuredClone(goodCR), steps: [
  ...sql.map(s => ({ sql: s, expect: {} })), ...config.map(([name, value]) => ({ config: { name, value }, expect: {} })) ] });

describe('identifiers', () => {
  test('relation names from DDL and DML, schema stripped, keywords dropped', () => {
    expect(crIdentifiers(cr([
      'ALTER TABLE public.orders ADD COLUMN region text',
      'create index concurrently if not exists orders_region_idx on orders (region)',
      'update pgbench_accounts set abalance = 0 where aid < 10',
      'insert into audit_log select * from orders',
      'drop view if exists v_orders; create or replace function f_total() returns int language sql as $$ select 1 $$',
    ]))).toEqual(['audit_log', 'f_total', 'orders', 'orders_region_idx', 'pgbench_accounts', 'v_orders']);
  });
  test('quoted names keep their case and spaces; rename targets are included', () => {
    expect(crIdentifiers(cr([
      'alter table "Order Items" add column c int',
      'alter table public."Orders" rename to orders_old',
      'alter table t rename column a to b',
    ]))).toEqual(['Order Items', 'Orders', 'orders_old', 't']);
  });
  test('facts queries carry a pgaibench-facts tag so pg_stat_statements analysis can filter them', async () => {
    const seen: string[] = [];
    await collectFacts({ unsafe: async (q: string) => { seen.push(q); return []; } }, ['orders'], []);
    const facts = seen.filter(q => q.startsWith('--'));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every(q => /^-- pgaibench-facts \w+\n/.test(q))).toBe(true);
  });
  test('GUC names from config steps and SET statements', () => {
    expect(crGucs(cr(['set lock_timeout = 500', "SET LOCAL statement_timeout TO '1s'"], [['work_mem', '64MB']]))).toEqual(['lock_timeout', 'statement_timeout', 'work_mem']);
  });
});

describe('collectFacts', () => {
  test('runs read-only catalog queries for the identifiers and maps rows', async () => {
    const seen: string[] = [];
    const rows: Record<string, Row[]> = {
      relations: [{ relname: 'orders', relfilenode: 16400, size: '8192', reltuples: 100 }],
      settings: [{ name: 'work_mem', context: 'user', unit: 'kB', pending_restart: false, setting: '4096' }],
      dependents: [{ object: 'orders', dependent: 'v_orders' }],
      definitions: [{ name: 'v_orders', definition: 'SELECT 1' }],
      volatility: [{ name: 'f_total', provolatile: 's' }],
      columns: [{ key: 'orders.region', type: 'text' }],
      indexes: [{ name: 'orders_region_idx', valid: false }],
      constraints: [{ name: 'orders_fk', table: 'orders', validated: false }],
      detach: [{ name: 'orders_p1' }],
      views: [{ name: 'v_orders' }],
    };
    const client = { unsafe: async (q: string) => { seen.push(q); const tag = /^-- pgaibench-facts (\w+)/.exec(q)?.[1] ?? ''; return rows[tag] ?? []; }, end: async () => {} };
    const f = await collectFacts(client, ['orders', "o'x"], ['work_mem']);
    expect(seen[0]).toBe('begin transaction read only');
    expect(seen.at(-1)).toBe('rollback');
    expect(seen.join('\n')).toContain("'o''x'");
    expect(f).toEqual({ relfilenodes: { orders: 16400 }, relation_sizes: { orders: 8192 }, relation_rows: { orders: 100 },
      setting_context: { work_mem: 'user' }, setting_units: { work_mem: 'kB' }, pending_restart: { work_mem: false }, settings: { work_mem: '4096' },
      dependents: { orders: ['v_orders'] }, definitions: { v_orders: 'SELECT 1' }, function_volatility: { f_total: 's' },
      column_types: { 'orders.region': 'text' }, index_valid: { orders_region_idx: false }, constraint_validated: { orders_fk: false },
      detach_pending: ['orders_p1'], views: ['v_orders'], errors: [] });
  });
  test('a failing query is recorded and does not stop the others', async () => {
    const client = { unsafe: async (q: string) => { if (q.startsWith('-- pgaibench-facts settings')) throw new Error('nope'); if (q.startsWith('-- pgaibench-facts views')) return [{ name: 'v' }]; return []; }, end: async () => {} };
    const f = await collectFacts(client, ['orders'], ['work_mem']);
    expect(f.errors).toEqual(['settings: nope']);
    expect(f.views).toEqual(['v']);
  });
});

describe('context', () => {
  test('workload texts drop pgbench meta-commands', () => {
    const d = mkdtempSync(join(tmpdir(), 'shapes-'));
    writeFileSync(join(d, 'q01.sql'), '/* shape:q01 */ \\set aid random(1, 10)\n/* shape:q01 */ select 1 from t where id = :aid;\n');
    writeFileSync(join(d, 'README.md'), 'x');
    expect(loadWorkloadTexts(d)).toEqual({ q01: '/* shape:q01 */ select 1 from t where id = :aid;' });
  });
  test('pg_stat_statements texts come from the baseline snapshot, unique', () => {
    const s = snapshot();
    s.stats.pg_stat_statements = [{ query: 'select 1' }, { query: 'select 1' }, { query: 'select 2' }, { calls: 3 }];
    expect(pgssTexts(s)).toEqual(['select 1', 'select 2']);
  });
  test('pre-rehearsal context has static facts only; post adds rehearsal facts', () => {
    const before: GuardrailFacts = { ...emptyFacts(), relfilenodes: { orders: 1 }, relation_sizes: { orders: 10 }, views: ['v1'], dependents: { orders: ['v1'] } };
    const after: GuardrailFacts = { ...emptyFacts(), relfilenodes: { orders: 2 }, relation_sizes: { orders: 20 }, views: [], pending_restart: { work_mem: false }, detach_pending: ['p1'] };
    const base = snapshot();
    const pre = buildGuardrailContext({ baseline: base, before, workloadTexts: { q01: 'x' } });
    expect(pre).toMatchObject({ baseline: base, relation_sizes: { orders: 10 }, dependents: { orders: ['v1'] }, workload_texts: { q01: 'x' } });
    expect(pre.relfilenodes).toBeUndefined();
    expect(pre.rehearsal).toBeUndefined();
    const reh = { after: snapshot(), actor: { steps: [{ ok: true, rows_affected: 4, setting_primary: '64MB' }, { ok: false }], aborted: true, rolledBack: true, rollbackErrors: [], logPath: '' } } as unknown as TelemetryRecord;
    const post = buildGuardrailContext({ baseline: base, before, after, rehearsal: reh });
    expect(post).toMatchObject({ relfilenodes: { before: { orders: 1 }, after: { orders: 2 } }, views: { before: ['v1'], after: [] },
      pending_restart: { work_mem: false }, detach_pending: ['p1'], steps: [{ ok: true, rows_affected: 4, setting_primary: '64MB' }, { ok: false }], rehearsed_through_step: 1, rehearsal: reh.after });
  });
});
