// Interval and test primitives for per-model rates (stats review 2026-11-10).
// One sample per scenario: every published rate uses the Wilson score
// interval; a paired difference between two models uses the exact McNemar
// test on the discordant scenarios, with Holm over a stated family.

const Z95 = 1.959963984540054;

/** Wilson score 95 % interval for k successes of n. */
export function wilson(k: number, n: number, z = Z95): [number, number] {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) throw new Error(`wilson: bad count ${k} of ${n}`);
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [k === 0 ? 0 : Math.max(0, mid - half), k === n ? 1 : Math.min(1, mid + half)];
}

function binomPmf(k: number, n: number): number {
  let lg = 0;
  for (let i = 1; i <= k; i++) lg += Math.log((n - k + i) / i);
  return Math.exp(lg - n * Math.LN2);
}

/** Exact two-sided McNemar p: b = scenarios where only A is right, c = only B. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  let tail = 0;
  for (let k = 0; k <= m; k++) tail += binomPmf(k, n);
  return Math.min(1, 2 * tail);
}

/** Holm step-down adjusted p values, in input order. */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ps.length);
  let run = 0;
  order.forEach(([p, i], r) => { run = Math.max(run, Math.min(1, (ps.length - r) * p)); out[i] = run; });
  return out;
}
