import { describe, expect, test } from 'bun:test';
import { mergeCR } from './fixtures';
import { g1 } from './g1-locks';
import { binaryCoercible } from './g2-rewrite';
import { g4, settingEquals } from './g4-config';
import { changedIdents } from './g5-workload';
import { g6, lossyCasts } from './g6-dml';
import { runGuardrails } from './index';

const rules = (fs: { rule: string }[]) => fs.map(f => f.rule).sort();
const blocking = <T extends { severity: string }>(fs: T[]) => fs.filter(f => f.severity === 'block');

describe('G1 edges', () => {
  test('set_config form counts as lock_timeout', () => {
    expect(blocking(g1(mergeCR({ steps: [{ sql: "select set_config('lock_timeout', '800ms', false); alter table orders add column z int" }] }), {}))).toEqual([]);
  });
  test('lock_timeout 0 is unbounded', () => {
    expect(rules(g1(mergeCR({ steps: [{ sql: 'set lock_timeout = 0; drop table big_log' }] }), {}))).toEqual(['G1.lock_timeout']);
  });
  test('DDL on a table created by the CR needs nothing', () => {
    expect(g1(mergeCR({ steps: [{ sql: 'create table t2 (id int); create index t2_idx on t2 (id); alter table t2 add constraint t2_pos check (id > 0)' }] }), {})).toEqual([]);
  });
  test('index build on an empty table is not flagged for CONCURRENTLY', () => {
    const f = g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; create index e_idx on empty_t (id)" }] }), { relation_rows: { empty_t: 0 } });
    expect(blocking(f)).toEqual([]);
  });
  test('rollback to savepoint does not close the transaction', () => {
    expect(rules(g1(mergeCR({ steps: [{ sql: 'begin; savepoint a; select 1; rollback to a' }] }), {}))).toEqual(['G1.open_transaction']);
  });
  test('semicolons inside strings do not split statements', () => {
    expect(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; comment on table orders is 'a; drop table x'" }] }), {})).toEqual([]);
  });
});

describe('G2 binary coercion table', () => {
  test.each([
    ['varchar(20)', 'varchar(40)', true], ['varchar(40)', 'varchar(20)', false], ['varchar(10)', 'text', true],
    ['numeric(10,2)', 'numeric', true], ['numeric(10,2)', 'numeric(8,2)', false], ['int', 'bigint', false],
    [undefined, 'bigint', false], [undefined, 'text', null],
  ] as const)('%s -> %s', (s, t, want) => expect(binaryCoercible(s as string | undefined, t)).toBe(want));
});

describe('G4 edges', () => {
  test('settingEquals handles units and undecidable values', () => {
    expect(settingEquals('64MB', '65536', 'kB')).toBe(true);
    expect(settingEquals('1s', '1000ms')).toBe(true);
    expect(settingEquals('64MB', '65536')).toBeNull();
    expect(settingEquals('on', 'true')).toBe(true);
  });
  test('decreasing a hot-standby GUC on the primary is allowed', () => {
    const cr = mergeCR({ steps: [{ config: { name: 'max_connections', value: '100' }, node: 'primary' }], postconditions: ['restart'] });
    expect(g4(cr, { baseline: { settings: { max_connections: '200' } } as any })).toEqual([]);
  });
  test('pg_settings context from ctx overrides the static list', () => {
    const cr = mergeCR({ steps: [{ config: { name: 'my.custom', value: '1' } }] });
    expect(rules(g4(cr, { setting_context: { 'my.custom': 'postmaster' } }))).toEqual(['G4.restart_required']);
  });
});

describe('G5 identifier extraction', () => {
  test('multiple drop targets and function signatures', () => {
    expect(changedIdents('drop table if exists a , public.b cascade').map(i => i.name)).toEqual(['a', 'b']);
    expect(changedIdents('drop function f ( int , text )').map(i => i.name)).toEqual(['f']);
    expect(changedIdents('alter table t rename column c to d , alter column e type bigint').map(i => `${i.action}:${i.table}.${i.name}`)).toEqual(['rename:t.c', 'retype:t.e']);
  });
});

describe('G6 edges', () => {
  test('between ... and is not a mixed predicate; t.id = t.id is a tautology', () => {
    expect(g6(mergeCR({ steps: [{ sql: 'delete from t where a between 1 and 5 and b = 2', expected_rows: 1 }] }), {})).toEqual([]);
    expect(rules(g6(mergeCR({ steps: [{ sql: 'update t set a = 1 where t.id = t.id', expected_rows: 1 }] }), {}))).toEqual(['G6.tautology']);
  });
  test('where inside a subquery does not count as the statement predicate', () => {
    expect(rules(g6(mergeCR({ steps: [{ sql: 'update t set a = (select max(x) from u where u.k = 1)', expected_rows: 1 }] }), {}))).toEqual(['G6.no_where']);
  });
  test('lossy cast detection', () => {
    expect(lossyCasts('a = b :: timestamp , c = d :: timestamptz , e = f :: varchar ( 10 )')).toEqual(['timestamp', 'varchar ( 10 )']);
  });
});

describe('runGuardrails on an empty context', () => {
  test('the naive add-column CR is caught by G1 only', () => {
    const report = runGuardrails(mergeCR({ steps: [{ sql: 'alter table pgbench_accounts add column region text' }] }));
    expect(report.residual).toBe('blocked');
    expect([...new Set(report.findings.map(f => f.family))]).toEqual(['G1']);
  });
});
