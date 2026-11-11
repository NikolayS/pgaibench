import { expect, test } from "bun:test";
import { boundLedger } from "./bounds";
import type { TelemetryRecord } from "../run/types";

const rec = (thresholds: TelemetryRecord["diff"]["thresholds"], steps: TelemetryRecord["actor"] extends infer A ? NonNullable<A>["steps"] : never, extra: Partial<TelemetryRecord> = {}) =>
  ({ diff: { thresholds }, actor: { steps, aborted: false, rolledBack: false, rollbackErrors: [], logPath: "" }, ...extra }) as unknown as TelemetryRecord;
const cr = { steps: [{ sql: "a", expect: { backup_verify: "==1", oom_kills: "==0" } }, { config: { name: "x", value: "1" }, node: "standby", expect: { "setting:x": "==1" } }],
  rehearsal: { thresholds: { recovery_test: "==1", p99_ms: "<1.2x", "shape_post_p50_ms:q07": "<1.2x" } } } as never;

test("every bound is judged in the first context where its metric is real; one judged nowhere is counted", () => {
  const reh = rec([
    { metric: "recovery_test", expression: "==1", baseline: null, actual: "skipped", pass: true, not_judged: "not_measurable_here" },
    { metric: "p99_ms", expression: "<1.2x", baseline: 10, actual: 9, pass: true },
    { metric: "shape_post_p50_ms:q07", expression: "<1.2x", baseline: null, actual: null, pass: true, not_judged: "not_measurable_here" },
  ], [{ ok: true, not_judged: [{ metric: "backup_verify", reason: "not_measurable_here" }] }, { ok: true, skipped: "node=standby has no clone counterpart", not_judged: [{ metric: "setting:x", reason: "skipped_on_clone" }] }]);
  const prod = rec([
    { metric: "recovery_test", expression: "==1", baseline: null, actual: "pass", pass: true },
    { metric: "p99_ms", expression: "<1.2x", baseline: 10, actual: 9, pass: true },
    { metric: "shape_post_p50_ms:q07", expression: "<1.2x", baseline: null, actual: null, pass: true, not_judged: "not_measurable_here" },
  ], [{ ok: true, not_judged: [{ metric: "backup_verify", reason: "not_measurable_here" }] }, { ok: true }],
  { deferred_expectations: [{ step: 0, metric: "backup_verify", expression: "==1", baseline: null, actual: "pass", pass: true }] });
  const l = boundLedger(cr, reh, prod);
  const where = Object.fromEntries(l.bounds.map(b => [`${b.source} ${b.metric}`, b.judged_at]));
  expect(where).toEqual({
    "threshold recovery_test": "production", "threshold p99_ms": "rehearsal", "threshold shape_post_p50_ms:q07": null,
    "step 1 backup_verify": "end_of_window", "step 1 oom_kills": "rehearsal", "step 2 setting:x": "production",
  });
  expect(l).toMatchObject({ bounds_judged_rehearsal: 2, bounds_judged_production: 3, bounds_never_judged: 1 });
  expect(l.bounds.find(b => b.metric === "shape_post_p50_ms:q07")!.not_judged).toEqual([{ context: "rehearsal", reason: "not_measurable_here" }, { context: "production", reason: "not_measurable_here" }]);
});
test("production did not run: a bound left for production is pending, not never judged", () => {
  const reh = rec([{ metric: "recovery_test", expression: "==1", baseline: null, actual: "skipped", pass: true, not_judged: "not_measurable_here" }], []);
  const l = boundLedger({ steps: [], rehearsal: { thresholds: { recovery_test: "==1" } } } as never, reh, null);
  expect(l).toMatchObject({ bounds_never_judged: 0, bounds_pending_production: 1 });
});
test("a step that failed before its expectations, or was never reached, judged nothing", () => {
  const reh = rec([], [{ ok: false, error: "relation does not exist" }]);
  const l = boundLedger({ steps: [{ sql: "a", expect: { oom_kills: "==0" } }, { sql: "b", expect: { oom_kills: "==0" } }], rehearsal: { thresholds: {} } } as never, reh, null);
  expect(l.bounds.map(b => b.judged_at)).toEqual([null, null]);
  expect(l.bounds_never_judged).toBe(0);
  const breached = boundLedger({ steps: [{ sql: "a", expect: { oom_kills: "==0" } }], rehearsal: { thresholds: {} } } as never, rec([], [{ ok: false, error: "Expectation breached: oom_kills=1 expected ==0" }]), null);
  expect(breached.bounds[0]!.judged_at).toBe("rehearsal");
});
test("a null value at rehearsal (null_value_here) is counted and judged in production when production has a real value; else never judged", () => {
  const c = { steps: [], rehearsal: { thresholds: { downtime_s: "==0", "shape_mean_ms:q01": "<=50" } } } as never;
  const reh = rec([{ metric: "downtime_s", expression: "==0", baseline: 0, actual: null, pass: true, not_judged: "null_value_here" }, { metric: "shape_mean_ms:q01", expression: "<=50", baseline: 5, actual: null, pass: true, not_judged: "null_value_here" }], []);
  const prod = rec([{ metric: "downtime_s", expression: "==0", baseline: 0, actual: 0, pass: true }, { metric: "shape_mean_ms:q01", expression: "<=50", baseline: 5, actual: null, pass: true, not_judged: "null_value_here" }], []);
  const l = boundLedger(c, reh, prod);
  expect(l.bounds.map(b => [b.metric, b.judged_at])).toEqual([["downtime_s", "production"], ["shape_mean_ms:q01", null]]);
  expect(l).toMatchObject({ bounds_judged_production: 1, bounds_never_judged: 1 });
  expect(boundLedger(c, reh, null)).toMatchObject({ bounds_pending_production: 2 });
});
