import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli';

const base = JSON.parse(await Bun.file(join(import.meta.dir, 'fixtures', 'base-cr.json')).text());
const dir = mkdtempSync(join(tmpdir(), 'guardrails-cli-'));
const write = (name: string, v: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(v)); return p; };

function run(args: string[]) {
  let out = '', err = '';
  const code = main(args, { out: s => { out += s; }, err: s => { err += s; } });
  return { code, out, err };
}

describe('guardrails CLI', () => {
  test('prints findings JSON and exits 2 when a rule blocks', () => {
    const cr = write('bad.json', { ...base, steps: [{ sql: 'alter table orders add column x int', expect: {} }] });
    const r = run([cr]);
    expect(r.code).toBe(2);
    const report = JSON.parse(r.out);
    expect(report.residual).toBe('blocked');
    expect(report.findings.map((f: any) => f.rule)).toContain('G1.lock_timeout');
  });
  test('exits 0 for a clear CR and reads the context file', () => {
    const cr = write('good.json', base);
    const ctx = write('ctx.json', { workload_texts: {} });
    const r = run([cr, ctx]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.findings).toEqual([]);
    expect(report.residual).toBe('clear');
  });
  test('loads env workload shapes when the context has none', () => {
    const cr = write('drop.json', { ...base, steps: [{ sql: "set lock_timeout = '1s'; alter table pgbench_accounts drop column abalance", expect: {} }] });
    const r = run([cr]);
    expect(JSON.parse(r.out).findings.some((f: any) => f.rule === 'G5.workload_dependency')).toBe(true);
  });
  test('exits 1 with usage on bad input', () => {
    expect(run([]).code).toBe(1);
    expect(run([write('invalid.json', { id: 'x' })]).code).toBe(1);
  });
});
