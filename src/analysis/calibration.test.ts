import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "../telemetry/fixtures";
import { calibrationRatio, maxAbsDeviation, medianRatio, summarizeCalibration } from "./calibration";

test("ratio is post divided by baseline; maximum uses absolute deviation", () => {
  expect(calibrationRatio(100, 97)).toBe(0.97);
  expect(calibrationRatio(10, 15)).toBe(1.5);
  expect(maxAbsDeviation([0.97, 1.5, 1.1])).toBe(0.5);
  expect(maxAbsDeviation([])).toBeNull();
  expect(calibrationRatio(0, 1)).toBeNull();
});

test("summary reads each task's baseline and post metric", () => {
  const runs = mkdtempSync(join(tmpdir(), "calibration-"));
  const make = (task: string, baseline: number, post: number) => {
    const d = join(runs, `${task}-noop-s1-1`);
    mkdirSync(d);
    const b = snapshot(), a = snapshot();
    if (task === "T10") { b.metrics.tps = baseline; a.metrics.tps_post = post; }
    if (task === "T2") { b.latency.shapes.q07 = { calls: 1, mean_ms: baseline, p50_ms: baseline, p99_ms: baseline }; a.metrics["shape_post_p50_ms:q07"] = post; }
    if (task === "T9") { b.wait_events = { "LWLock:LockManager": baseline * 100, "CPU:active": (1 - baseline) * 100 }; a.wait_events = { "LWLock:LockManager": post * 100, "CPU:active": (1 - post) * 100 }; }
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ noop: true, status: "complete" }));
    writeFileSync(join(d, "baseline.telemetry.json"), JSON.stringify(b));
    writeFileSync(join(d, "production.telemetry.json"), JSON.stringify({ after: a }));
  };
  make("T10", 100, 97);
  make("T2", 10, 15);
  make("T9", 0.2, 0.1);
  const rows = summarizeCalibration(runs);
  expect(rows.T10?.[0]?.ratio).toBe(0.97);
  expect(rows.T2?.[0]?.ratio).toBe(1.5);
  expect(rows.T9?.[0]?.ratio).toBe(0.5);
});
