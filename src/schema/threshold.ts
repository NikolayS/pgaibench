import type { ComparisonOperator, MetricValue, Threshold } from './types';

export function parseThreshold(expression: string): Threshold {
  const match = /^(<=|>=|==|<|>)(-?(?:\d+(?:\.\d+)?|\.\d+))(x)?$/.exec(expression);
  if (!match || !Number.isFinite(Number(match[2]))) throw new Error(`Invalid threshold: ${expression}`);
  return { op: match[1] as ComparisonOperator, value: Number(match[2]), relative: !!match[3] };
}

export function compare(actual: MetricValue, op: ComparisonOperator, expected: MetricValue): boolean {
  if (actual == null || expected == null) return false;
  if (op === '==') return actual === expected;
  if (typeof actual !== 'number' || typeof expected !== 'number' || !Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return op === '<' ? actual < expected : op === '<=' ? actual <= expected : op === '>' ? actual > expected : actual >= expected;
}

export function evaluateThreshold(expression: string, actual: MetricValue, baseline?: MetricValue): boolean {
  const threshold = parseThreshold(expression);
  const BOOL_STRINGS: Record<string, number> = { on: 1, off: 0, true: 1, false: 0, yes: 1, no: 0, pass: 1, fail: 0 };
  const numeric = typeof actual === 'boolean' ? Number(actual) : typeof actual === 'string' && actual.toLowerCase() in BOOL_STRINGS ? BOOL_STRINGS[actual.toLowerCase()] : typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual)) ? Number(actual) : actual;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
  if (threshold.relative && (typeof baseline !== 'number' || !Number.isFinite(baseline))) return false;
  return compare(numeric, threshold.op, threshold.value * (threshold.relative ? baseline as number : 1));
}
