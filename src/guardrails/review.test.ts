// Regression tests for guardrail rules and tokenizer edge cases.
// Fixtures in fixtures/review/ are full CRs; the rules stay generic.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCR } from '../schema/cr';
import type { CR } from '../schema/types';
import { loadShapes, main } from './cli';
import { mergeCR } from './fixtures';
import { g1 } from './g1-locks';
import { g2 } from './g2-rewrite';
import { g4 } from './g4-config';
import { g5 } from './g5-workload';
import { g6 } from './g6-dml';
import { runGuardrails } from './index';
import { crStatements, lex } from './sql';
import type { GuardrailContext } from './types';

const dir = join(import.meta.dir, 'fixtures', 'review');
const load = (name: string) => validateCR(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
const ctxOf = (name: string): GuardrailContext => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
const shapes = loadShapes();
const blocks = (fs: { rule: string; severity: string }[]) => [...new Set(fs.filter(f => f.severity === 'block').map(f => f.rule))].sort();
const warns = (fs: { rule: string; severity: string }[]) => [...new Set(fs.filter(f => f.severity === 'warn').map(f => f.rule))].sort();
/** Bypass schema validation for fields another branch adds (retries). */
const raw = (partial: Record<string, unknown>): CR => ({ ...mergeCR({ steps: [{ sql: 'select 1' }] }), ...partial }) as CR;

describe('residual is three-valued', () => {
  test('a clean static CR with all needed context is clear', () => {
    const r = runGuardrails(mergeCR({ steps: [{ sql: 'select 1' }] }), {});
    expect(r.residual).toBe('clear');
  });
  test('a blocking finding gives blocked', () => {
    expect(runGuardrails(mergeCR({ steps: [{ sql: 'alter table orders add column x int' }] })).residual).toBe('blocked');
  });
  test('a blocking-capable rule without its context gives unevaluated and names the missing fields', () => {
    const cr = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; drop table big_log" }] });
    const r = runGuardrails(cr, { workload_texts: {}, pgss_texts: [], dependents: {} });
    expect(r.residual).toBe('unevaluated');
    const ev = r.evaluations.find(e => e.rule === 'G2.drop_size')!;
    expect(ev.status).toBe('missing_context');
    expect(ev.missing).toContain('relation_sizes');
  });
  test('every rule reports its needed fields and whether it ran', () => {
    const r = runGuardrails(mergeCR({ steps: [{ sql: 'select 1' }] }), {});
    expect(r.evaluations.length).toBeGreaterThan(20);
    for (const e of r.evaluations) {
      expect(Array.isArray(e.needs)).toBe(true);
      expect(['ran', 'missing_context', 'not_applicable']).toContain(e.status);
    }
  });
});

describe('CLI exit codes', () => {
  const run = (args: string[]) => { let out = ''; const code = main(args, { out: s => { out += s; }, err: () => {} }); return { code, out }; };
  test('3 when unevaluated, 2 when blocked, 0 when clear', () => {
    expect(run([join(dir, 'drop1-naive.json')]).code).toBe(3);
    expect(run([join(dir, 'drop1-naive.json'), join(dir, 'drop1-ctx.json')]).code).toBe(2);
    expect(JSON.parse(run([join(dir, 'drop1-naive.json'), join(dir, 'drop1-ctx.json')]).out).residual).toBe('blocked');
  });
});

describe('G1 partition and constraint DDL', () => {
  const attach = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table p attach partition p_2 for values from ('2026-12-01') to ('2027-01-01')" }] });
  test('ATTACH PARTITION without a CHECK in the CR and without catalog facts is unevaluated', () => {
    const r = runGuardrails(attach, {});
    expect(blocks(r.findings)).not.toContain('G1.attach_without_check');
    expect(r.evaluations.find(e => e.rule === 'G1.attach_without_check')!.status).toBe('missing_context');
  });
  test('ATTACH PARTITION blocks when the baseline catalog has no CHECK on the candidate', () => {
    const baseline = { catalog: { constraints: [{ name: 'p_2.p_2_pkey', definition: 'PRIMARY KEY (id)' }] } } as any;
    expect(blocks(g1(attach, { baseline }))).toEqual(['G1.attach_without_check']);
  });
  test('ATTACH PARTITION passes with a valid matching CHECK in the baseline catalog', () => {
    const baseline = { catalog: { constraints: [{ name: 'p_2.r', definition: "CHECK (ts >= '2026-12-01' AND ts < '2027-01-01')" }] } } as any;
    expect(blocks(g1(attach, { baseline }))).toEqual([]);
  });
  test('ATTACH PARTITION after an added and validated CHECK passes (safe form)', () => {
    expect(blocks(g1(load('safe5-attach'), {}))).toEqual([]);
  });
  test('a CHECK whose bounds do not match the partition bound does not count', () => {
    const cr = mergeCR({ steps: [
      { sql: "set lock_timeout = '1s'; alter table p_2 add constraint r check (ts >= '2020-01-01') not valid" },
      { sql: "set lock_timeout = '1s'; alter table p_2 validate constraint r" },
      { sql: "set lock_timeout = '1s'; alter table p attach partition p_2 for values from ('2026-12-01') to ('2027-01-01')" },
    ] });
    expect(blocks(g1(cr, { baseline: { catalog: { constraints: [] } } as any }))).toEqual(['G1.attach_without_check']);
  });
  test('DETACH PARTITION without CONCURRENTLY blocks', () => {
    expect(blocks(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table p detach partition p_1" }] }), {}))).toEqual(['G1.detach_concurrently']);
    expect(blocks(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table p detach partition p_1 concurrently" }] }), {}))).toEqual([]);
  });
  test('ADD UNIQUE / PRIMARY KEY without USING INDEX blocks on a non-empty table', () => {
    expect(blocks(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table t add primary key (id)" }] }), {}))).toEqual(['G1.unique_using_index']);
    expect(blocks(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table t add constraint t_k unique using index t_k_idx" }] }), {}))).toEqual([]);
    expect(blocks(g1(mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table t add constraint t_k unique (k)" }] }), { relation_rows: { t: 0 } }))).toEqual([]);
  });
  test('LOCK TABLE needs lock_timeout', () => {
    expect(blocks(g1(load('tok15-lock-table'), {}))).toEqual(['G1.lock_timeout']);
  });
  test('lock_timeout without a retry mechanism warns; step retries or a retry loop are the safe form', () => {
    const sql = "set lock_timeout = '1s'; alter table orders add column note text";
    expect(warns(g1(raw({ steps: [{ sql, expect: {} }] }), {}))).toEqual(['G1.no_retry']);
    expect(g1(raw({ steps: [{ sql, expect: {}, retries: 3 }] }), {})).toEqual([]);
    expect(warns(g1(raw({ steps: [{ sql, expect: {}, retries: 50 }] }), {}))).toEqual(['G1.no_retry']);
  });
});

describe('G2 drop of a large relation', () => {
  test('DROP TABLE above the size threshold blocks', () => {
    expect(blocks(g2(load('drop1-naive'), ctxOf('drop1-ctx')))).toEqual(['G2.drop_size']);
  });
  test('TRUNCATE above the threshold blocks; a small table passes', () => {
    const cr = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; truncate big_t" }] });
    expect(blocks(g2(cr, { relation_sizes: { big_t: 5 * 1024 ** 3 } }))).toEqual(['G2.drop_size']);
    expect(blocks(g2(cr, { relation_sizes: { big_t: 1024 } }))).toEqual([]);
  });
});

describe('G4 GUC scope', () => {
  test('cluster-wide timeouts block (config steps, alter system)', () => {
    expect(blocks(g4(mergeCR({ steps: [{ config: { name: 'statement_timeout', value: '30s' }, node: 'both' }] }), {}))).toEqual(['G4.global_timeout']);
    expect(blocks(g4(mergeCR({ steps: [{ sql: "alter system set statement_timeout = '30s'" }] }), {}))).toEqual(['G4.global_timeout']);
  });
  test('database and role scoped timeouts warn', () => {
    for (const sql of ["alter database app set statement_timeout = '30s'", "alter role app set statement_timeout = '30s'"]) {
      expect(blocks(g4(mergeCR({ steps: [{ sql }] }), {}))).toEqual([]);
      expect(warns(g4(mergeCR({ steps: [{ sql }] }), {}))).toEqual(['G4.scoped_timeout']);
    }
  });
  test('session SET of a timeout is not a config change finding', () => {
    expect(g4(mergeCR({ steps: [{ sql: "set statement_timeout = '30s'; select 1" }] }), {})).toEqual([]);
  });
  test('disabling a timeout globally does not block', () => {
    expect(blocks(g4(mergeCR({ steps: [{ config: { name: 'statement_timeout', value: '0' }, node: 'both' }] }), {}))).toEqual([]);
  });
  test('work_mem scope: cluster and role warn, session does not', () => {
    expect(warns(g4(mergeCR({ steps: [{ sql: "alter system set work_mem = '256MB'" }] }), {}))).toEqual(['G4.memory_budget']);
    expect(warns(g4(mergeCR({ steps: [{ sql: "alter role etl set work_mem = '256MB'" }] }), {}))).toEqual(['G4.memory_budget']);
    expect(g4(mergeCR({ steps: [{ sql: "set work_mem = '256MB'; select 1" }] }), {})).toEqual([]);
  });
});

describe('G5 mention is not acceptance', () => {
  test('quoted schema-qualified rename is caught', () => {
    expect(blocks(g5(load('tok9-alter-table-qualified-quoted'), { workload_texts: shapes }))).toEqual(['G5.workload_dependency']);
  });
  test('a dependent recreated in the steps or verified by a postcondition query is handled', () => {
    const ctx = { dependents: { orders_archive: ['v_archive'] } };
    const recreate = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; drop view v_archive; drop table orders_archive" }] });
    expect(g5(recreate, ctx)).toEqual([]);
    const verified = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; drop table orders_archive" }], postconditions: ['select count(*) from v_archive'] });
    expect(g5(verified, ctx)).toEqual([]);
    const prose = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; drop table orders_archive" }], postconditions: ['v_archive is retired'] });
    expect(blocks(g5(prose, ctx))).toEqual(['G5.workload_dependency']);
  });
  test('quoted, qualified and upper-case identifiers normalize to one name', () => {
    const cr = mergeCR({ steps: [{ sql: "set lock_timeout = '1s'; alter table orders drop column legacy_flag" }] });
    for (const q of ['select "legacy_flag" from "public"."orders"', 'select legacy_flag from public.orders', 'select "Legacy_Flag" from "Orders"']) {
      expect(blocks(g5(cr, { workload_texts: { q01: q } }))).toEqual(['G5.workload_dependency']);
    }
  });
});

describe('G6 DML forms', () => {
  test('data-modifying CTE without WHERE blocks', () => {
    expect(blocks(g6(load('tok8-with-cte-update'), {}))).toEqual(['G6.no_where']);
    expect(blocks(g6(mergeCR({ steps: [{ sql: 'with d as (delete from orders returning id) select count(*) from d', expected_rows: 3 }] }), {}))).toEqual(['G6.no_where']);
  });
  test('MERGE and INSERT ... ON CONFLICT DO UPDATE need expected_rows', () => {
    expect(blocks(g6(load('tok14-merge'), {}))).toEqual(['G6.expected_rows_missing']);
    expect(blocks(g6(mergeCR({ steps: [{ sql: 'insert into t (id, v) values (1, 2) on conflict (id) do update set v = excluded.v' }] }), {}))).toEqual(['G6.expected_rows_missing']);
    expect(blocks(g6(mergeCR({ steps: [{ sql: 'insert into t (id, v) values (1, 2) on conflict (id) do nothing' }] }), {}))).toEqual([]);
  });
  test('INSERT ... SELECT needs expected_rows', () => {
    expect(blocks(g6(load('tok13-insert-select-big'), {}))).toEqual(['G6.expected_rows_missing']);
  });
  test('predicate rules apply to MERGE ON and ON CONFLICT WHERE', () => {
    expect(blocks(g6(mergeCR({ steps: [{ sql: 'merge into t using s on 1 = 1 when matched then delete', expected_rows: 1 }] }), {}))).toEqual(['G6.tautology']);
    expect(blocks(g6(mergeCR({ steps: [{ sql: 'insert into t select * from s on conflict (id) do update set v = excluded.v where t.v = t.v', expected_rows: 1 }] }), {}))).toEqual(['G6.tautology']);
  });
});

describe('tokenizer fooling cases', () => {
  test('quoted qualified names stay one identifier', () => {
    expect(lex('alter table "public"."orders" add x').map(t => t.v)).toEqual(['alter', 'table', 'public.orders', 'add', 'x']);
    expect(lex('"public".orders').map(t => t.v)).toEqual(['public.orders']);
    expect(lex('public . orders').map(t => t.v)).toEqual(['public.orders']);
    expect(lex('t.*').map(t => t.v)).toEqual(['t', '.', '*']);
  });
  test('reviewer fixtures: comments, strings, quotes, case, dollar tags', () => {
    expect(blocks(g1(load('tok1-dollar-comment'), {}))).toEqual(['G1.lock_timeout']);
    expect(blocks(g1(load('tok2-string-semicolon'), {}))).toEqual(['G1.lock_timeout']);
    expect(blocks(g1(load('tok3-quoted-ident'), {}))).toEqual(['G1.concurrently']);
    expect(blocks(g1(load('tok5-case-qualified'), {}))).toEqual([]);
    expect(blocks(g1(load('tok6-tag-dollar'), {}))).toEqual([]);
    expect(crStatements(load('tok9-alter-table-qualified-quoted')).map(s => s.text)).toContain('alter table public.orders rename column customer_id to client_id');
  });
});

describe('safe CRs from the review do not block', () => {
  for (const n of ['safe1-ddl', 'safe2-config', 'safe3-batched-update', 'safe4-index-drop', 'safe5-attach']) {
    test(n, () => expect(runGuardrails(load(n), { workload_texts: shapes }).residual).not.toBe('blocked'));
  }
});
