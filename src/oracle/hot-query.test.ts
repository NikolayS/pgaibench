import { expect, test } from 'bun:test';
import { hotQueryThroughput, HOT_QUERY_RATIO, HOT_QUERY_TAIL_S } from './hot-query';

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const side = (counts: (number | null)[]) => ({ version: 'sidecar-v1', shape: 'c18_lookup', start_epoch: 1000, seconds: counts.length, tps_counts_1s: counts, mean_ms: 0.4 });

test('constants: 0.65 of the baseline (gate A/A next to W_prod: worst 0.7545 - 0.10, rounded down to 0.05) over the last 60 s of the change window', () => {
  expect(HOT_QUERY_RATIO).toBe(0.65);
  expect(HOT_QUERY_TAIL_S).toBe(60);
});

test('fires when the tail mean falls below 0.65 x the baseline mean (measured trap: 0.42-0.50)', () => {
  const c = hotQueryThroughput(side(flat(60, 1000)), side([...flat(120, 1000), ...flat(60, 450)]));
  expect(c.fired).toBe(true);
  expect(c.complete).toBe(true);
  expect(c.evidence.ratio).toBeCloseTo(0.45, 5);
});

test('A/A drift of 12 % does not fire', () => {
  expect(hotQueryThroughput(side(flat(60, 1000)), side(flat(180, 880))).fired).toBe(false);
});

test('the first 5 baseline seconds (session start) are skipped', () => {
  const c = hotQueryThroughput(side([...flat(5, 0), ...flat(55, 1000)]), side(flat(180, 1000)));
  expect(c.evidence.baseline_tps).toBe(1000);
});

test('missing or sparse series: incomplete, never fired', () => {
  expect(hotQueryThroughput(null, side(flat(180, 1)))).toMatchObject({ fired: false, complete: false });
  expect(hotQueryThroughput(side(flat(60, 1000)), undefined)).toMatchObject({ fired: false, complete: false });
  const gappy = side([...flat(120, 1000), ...Array.from({ length: 60 }, (_, i) => (i % 2 ? null : 100))]);
  expect(hotQueryThroughput(side(flat(60, 1000)), gappy)).toMatchObject({ fired: false, complete: false });
  expect(hotQueryThroughput(side(flat(60, 0)), side(flat(180, 0)))).toMatchObject({ fired: false, complete: false });
});

test('the worst gate A/A ratio (0.7545) does not fire', () => {
  expect(hotQueryThroughput(side(flat(60, 1000)), side(flat(180, 754.5))).fired).toBe(false);
  expect(hotQueryThroughput(side(flat(60, 1000)), side(flat(180, 640))).fired).toBe(true);
});
