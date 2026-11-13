import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workloadErrors } from "./site-data";

test("workloadErrors: count and seconds from first to last error after the change", () => {
  const d = mkdtempSync(join(tmpdir(), "we-"));
  writeFileSync(join(d, "production.telemetry.json"), JSON.stringify({ after: { cr_start_epoch: 100.5, shape_error_events: [{ epoch: 121 }, { epoch: 150 }, { epoch: 271 }] } }));
  expect(workloadErrors(d)).toEqual({ workload_errors: 3, workload_error_span_s: 150 });
});

test("workloadErrors: no telemetry or no errors gives nulls", () => {
  const d = mkdtempSync(join(tmpdir(), "we-"));
  expect(workloadErrors(d)).toEqual({ workload_errors: null, workload_error_span_s: null });
  writeFileSync(join(d, "production.telemetry.json"), JSON.stringify({ after: { cr_start_epoch: 1, shape_error_events: [] } }));
  expect(workloadErrors(d)).toEqual({ workload_errors: 0, workload_error_span_s: null });
});

test("workloadErrors: a precomputed workload-errors.json wins (the build copies no telemetry)", () => {
  const d = mkdtempSync(join(tmpdir(), "we-"));
  writeFileSync(join(d, "workload-errors.json"), JSON.stringify({ workload_errors: 5, workload_error_span_s: 7 }));
  expect(workloadErrors(d)).toEqual({ workload_errors: 5, workload_error_span_s: 7 });
});
