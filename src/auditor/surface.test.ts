import { expect, test } from "bun:test";
import { surfaceFeatures, bestSurfaceRule, bestTwoFeatureRule, shuffledTwoFeatureMedian } from "./surface";

test("features of a shown CR", () => {
  const f = surfaceFeatures({ id: "x", task: "T", steps: [{ sql: "a", retries: 3, expect: { a: "1", b: "2" } }, { sql: "b", expect: {} }], rehearsal: { metrics: ["p"], thresholds: { p: "<1" } }, rollback: ["r"] });
  expect(f).toMatchObject({ steps: 2, rollback: 1, thresholds: 1, metrics: 1, expect_keys: 2, has_retries: 1, "has_field:steps": 1, "has_field:claims": 0 });
  expect(f.json_length).toBeGreaterThan(50);
});

test("best rule: finds the separating cut, direction and its H - F", () => {
  const items = [
    { truth: "block" as const, cr: { steps: [{ sql: "x" }] } }, { truth: "block" as const, cr: { steps: [{ sql: "y" }] } },
    { truth: "approve" as const, cr: { steps: [{ sql: "x" }, { sql: "y" }, { sql: "z" }] } }, { truth: "approve" as const, cr: { steps: [{ sql: "a" }, { sql: "b" }] } },
  ];
  const r = bestSurfaceRule(items);
  expect(r.score).toBe(100);
  expect(r.hits).toEqual({ k: 2, n: 2 });
  expect(r.false_alarms).toEqual({ k: 0, n: 2 });
  expect(r.rule).toMatch(/block when \w+ (<|>) /);
});

test("token features and the best two-feature rule", () => {
  const f = surfaceFeatures({ steps: [{ sql: "DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ALTER TABLE t ADD COLUMN c int; END $$", retries: 10 }] });
  expect(f).toMatchObject({ tok_lock_timeout: 1, tok_do_block: 1, has_retries: 1 });
  const items = [
    { truth: "block" as const, cr: { steps: [{ sql: "upd a" }] } }, { truth: "block" as const, cr: { steps: [{ sql: "upd b", retries: 3 }, { sql: "x" }] } },
    { truth: "approve" as const, cr: { steps: [{ sql: "a", retries: 3 }] } }, { truth: "approve" as const, cr: { steps: [{ sql: "b" }, { sql: "c" }] } },
  ];
  const one = bestSurfaceRule(items), two = bestTwoFeatureRule(items);
  expect(two.score).toBeGreaterThanOrEqual(one.score);
  expect(two.rule).toMatch(/ AND /);
});

test("shuffled-label reference for the fitted two-feature rule is deterministic", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ truth: (i % 2 ? "block" : "approve") as "block" | "approve", cr: { steps: Array.from({ length: 1 + (i % 3) }, () => ({ sql: "x" })) } }));
  const a = shuffledTwoFeatureMedian(items, { rounds: 20, seed: 5 }), b = shuffledTwoFeatureMedian(items, { rounds: 20, seed: 5 });
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(0);
});

test("surface features: statement count, ALTER, DO", () => {
  const f = surfaceFeatures({ steps: [{ sql: "ALTER TABLE t ADD c int; DO $$ BEGIN NULL; END $$;" }, { sql: "SELECT 1" }] });
  expect(f.statements).toBe(4); // ALTER; DO $$ BEGIN NULL; END $$; plus SELECT 1
  expect(f.tok_alter).toBe(1);
  expect(f.tok_do).toBe(1);
  expect(surfaceFeatures({ steps: [{ sql: "DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ALTER TABLE t DROP COLUMN c; END $$" }] }).statements).toBe(3);
});
