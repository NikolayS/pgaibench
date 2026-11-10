import { describe, expect, test } from 'bun:test';
import { crSchema } from './cr';
import { evaluateThreshold, parseThreshold } from './threshold';

export const validCR = () => ({ id: 'cr-1', task: 'T1', claims: [],
  steps: [{ sql: 'drop table big_log', expect: { replication_lag_s: '<30' } }],
  rehearsal: { workload: 'W_prod', minutes: 2, metrics: ['p99_ms'], thresholds: { p99_ms: '<1.2x' } },
  rollback: ['select 1'], postconditions: ['archiving_on'], risk: { class_guess: 'none', blast_radius: 'big_log' } });

describe('CR schema', () => {
  test('accepts the exact SQL/config/shell union', () => {
    expect(crSchema.parse(validCR()).task).toBe('T1');
    const cr: any = validCR(); cr.task = 'T5';
    cr.steps = [{ config: { name: 'work_mem', value: '64MB' }, expect: {} }, { shell: 'env/upgrade.sh', expect: {} }];
    expect(crSchema.safeParse(cr).success).toBe(true);
  });
  test.each([['free text'], [{ sql: 'select 1', config: { name: 'x', value: 'x' }, expect: {} }], [{ shell: 'env/reset.sh', expect: {} }], [{ shell: 'env/upgrade.sh', expect: {} }]])('rejects malformed/disallowed steps %j', (step) => {
    expect(crSchema.safeParse({ ...validCR(), steps: [step] }).success).toBe(false);
  });
  test('rejects empty rollback, unknown metrics and malformed thresholds', () => {
    expect(crSchema.safeParse({ ...validCR(), rollback: [] }).success).toBe(false);
    expect(crSchema.safeParse({ ...validCR(), rollback: ['  '] }).success).toBe(false);
    expect(crSchema.safeParse({ ...validCR(), steps: [{ sql: 'select 1', expect: { made_up: '<3' } }] }).success).toBe(false);
    expect(crSchema.safeParse({ ...validCR(), steps: [{ sql: 'select 1', expect: { p99_ms: 'fast' } }] }).success).toBe(false);
  });
});

describe('thresholds', () => {
  test.each([['<5', 4, true], ['<5', 5, false], ['<=5', 5, true], ['>5', 5, false], ['>=5', 5, true], ['==5', 5, true], ['==-1.2', -1.2, true]])('%s at %s', (expr, value, ok) => expect(evaluateThreshold(expr, value)).toBe(ok));
  test('relative thresholds and missing/nonfinite values', () => {
    expect(evaluateThreshold('<1.2x', 11, 10)).toBe(true);
    expect(evaluateThreshold('<1.2x', 12, 10)).toBe(false);
    expect(evaluateThreshold('<1.2x', 10)).toBe(false);
    expect(evaluateThreshold('<1.2x', 0, 0)).toBe(false);
    expect(evaluateThreshold('<30', null)).toBe(false);
    expect(evaluateThreshold('>=0', Infinity)).toBe(false);
    expect(evaluateThreshold('==0', false)).toBe(true);
  });
  test.each(['', '<NaN', '<Infinity', '1', '=1', '<1x junk', '<1e309', '<1;select 1'])('rejects %s', expr => expect(() => parseThreshold(expr)).toThrow());
});
