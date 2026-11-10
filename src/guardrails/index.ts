import type { CR } from '../schema/types';
import { g1 } from './g1-locks';
import { g2 } from './g2-rewrite';
import { g3 } from './g3-catalog';
import { g4 } from './g4-config';
import { g5 } from './g5-workload';
import { g6 } from './g6-dml';
import { Evals, type Family, type GuardrailContext, type GuardrailReport, type GuardrailRule, type Residual } from './types';

export type { GuardrailContext, GuardrailFinding, GuardrailReport, Residual, RuleEvaluation } from './types';
export const FAMILIES: Record<Family, GuardrailRule> = { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5, G6: g6 };

export function runGuardrails(cr: CR, ctx: GuardrailContext = {}): GuardrailReport {
  const ev = new Evals();
  const findings = Object.values(FAMILIES).flatMap(rule => rule(cr, ctx, ev));
  for (const f of findings) ev.ran(f.rule);
  const evaluations = ev.list();
  const residual: Residual = findings.some(f => f.severity === 'block') ? 'blocked'
    : evaluations.some(e => e.can_block && e.status === 'missing_context') ? 'unevaluated' : 'clear';
  return { findings, residual, evaluations };
}

export const EXIT_CODES: Record<Residual, number> = { clear: 0, blocked: 2, unevaluated: 3 };
