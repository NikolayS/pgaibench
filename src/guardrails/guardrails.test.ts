import { describe, expect, test } from 'bun:test';
import { loadFixtures } from './fixtures';
import { FAMILIES, runGuardrails } from './index';
import type { Family } from './types';

const key = (f: { rule: string; step_index: number | null; severity: string }) => `${f.rule}@${f.step_index}:${f.severity}`;

for (const family of Object.keys(FAMILIES) as Family[]) {
  describe(`${family} golden fixtures`, () => {
    const fixtures = loadFixtures(family);
    test('has at least 3 passing and 3 failing fixtures', () => {
      expect(fixtures.filter(f => f.expect.length === 0).length).toBeGreaterThanOrEqual(3);
      expect(fixtures.filter(f => f.expect.some(e => e.severity === 'block')).length).toBeGreaterThanOrEqual(3);
    });
    for (const fx of fixtures) {
      test(`${fx.name}: ${fx.description}`, () => {
        const findings = FAMILIES[family](fx.cr, fx.ctx);
        for (const f of findings) {
          expect(f.family).toBe(family);
          expect(f.message.length).toBeGreaterThan(0);
        }
        expect(findings.map(key).sort()).toEqual(fx.expect.map(key).sort());
      });
    }
  });
}

describe('runGuardrails', () => {
  test('residual is not blocked when no finding blocks', () => {
    const [fx] = loadFixtures('G1').filter(f => f.expect.length === 0);
    expect(runGuardrails(fx.cr, fx.ctx).residual).not.toBe('blocked');
  });
  test('residual is false when any family blocks', () => {
    const fx = loadFixtures('G1').find(f => f.expect.some(e => e.severity === 'block'))!;
    const report = runGuardrails(fx.cr, fx.ctx);
    expect(report.residual).toBe('blocked');
    expect(report.findings.some(f => f.family === 'G1' && f.severity === 'block')).toBe(true);
  });
  test('context-dependent rules without context report unevaluated, not clear', () => {
    const fx = loadFixtures('G3').find(f => f.name === 'fail-invalid-index')!;
    const r = runGuardrails(fx.cr, {});
    expect(r.findings.filter(f => f.family === 'G3')).toEqual([]);
    expect(r.residual).not.toBe('clear');
    expect(r.evaluations.find(e => e.rule === 'G3.invalid_index')!.status).toBe('missing_context');
  });
});
