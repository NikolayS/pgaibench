import { describe, expect, test } from "bun:test";
import { cellVerdict, drawSample, gateDecision, NOT_ON_CLONE, runGateRep } from "./gate-rerun";
import { snapshot, fixtureTask } from "../telemetry/fixtures";
import { goodCR } from "./fixtures/good-cr";
import type { EnvPort, LabPort, Target } from "./ports";
import type { Snapshot, TelemetryRecord } from "./types";

const ones = (n: number, v = 0.1) => Array.from({ length: n }, () => v);
function win(lock: number[] = ones(130)): Snapshot {
  const s = snapshot();
  s.lock_wait_samples = lock;
  s.stall_lock_wait_samples = lock.map(() => 0);
  s.tps_counts_1s = ones(130, 500);
  s.shape_errors = {}; s.shape_errors_s = 120;
  // W_prod on the clone: the standby shapes run on the clone port, labelled standby.
  s.latency.source = "workload";
  s.latency.shapes = { ...s.latency.shapes, q20: { calls: 1000, mean_ms: 1, p50_ms: 1, p99_ms: 6, target: "standby" } } as never;
  return s;
}

describe("gateDecision", () => {
  test("a clean change window against the clone reference passes", () => {
    const d = gateDecision(win(), win(), fixtureTask, structuredClone(goodCR), null);
    expect(d.verdict).toBe("passed");
    expect(d.fired).toEqual([]);
    expect(d.measured.lock_wait_max_s).toBeCloseTo(0.1);
  });
  test("a lock wait of 5 s or more on the clone stops the change (lock_stall)", () => {
    const a = win(); a.lock_wait_samples![50] = 6.2;
    const d = gateDecision(win(), a, fixtureTask, structuredClone(goodCR), null);
    expect(d.verdict).toBe("stopped");
    expect(d.fired).toContain("lock_stall");
    expect(d.measured.lock_wait_max_s).toBeCloseTo(6.2);
  });
  test("new failed workload statements stop the change (workload_errors) and are counted", () => {
    const a = win(); a.shape_errors = { q01: { "error:  column \"x\" does not exist": 40 } };
    const d = gateDecision(win(), a, fixtureTask, structuredClone(goodCR), null);
    expect(d.fired).toContain("workload_errors");
    expect(d.measured.new_error_statements).toBe(40);
  });
  test("checks a single-node clone cannot measure are never used", () => {
    const a = win(); a.replication.lag_s = [99]; a.replication.cancellations = 3; a.backup_verify = "fail";
    const d = gateDecision(win(), a, fixtureTask, structuredClone(goodCR), null);
    for (const k of NOT_ON_CLONE) expect(d.fired).not.toContain(k);
    expect(d.not_applicable).toEqual([...NOT_ON_CLONE]);
    expect(d.verdict).not.toBe("stopped");
  });
  test("the overall p99 check stays unscored", () => {
    const r = win(); r.latency.p99_ms = 10; const a = win(); a.latency.p99_ms = 100;
    expect(gateDecision(r, a, fixtureTask, structuredClone(goodCR), null).fired).not.toContain("latency");
  });
  test("a check that fires on the reference against itself is excluded and reported", () => {
    const r = win(); r.resources.oom_kills = 1; const a = win(); a.resources.oom_kills = 1;
    const d = gateDecision(r, a, fixtureTask, structuredClone(goodCR), null);
    expect(d.excluded).toContain("resources");
    expect(d.fired).not.toContain("resources");
  });
  test("an incomplete check without a fired one gives incomplete, never passed", () => {
    const a = win(); a.lock_wait_samples = Array.from({ length: 130 }, () => null) as never;
    const d = gateDecision(win(), a, fixtureTask, structuredClone(goodCR), null);
    expect(d.verdict).toBe("incomplete");
    expect(d.incomplete).toContain("lock_stall");
  });
});

describe("cellVerdict", () => {
  test("majority of completed repetitions; ties are mixed", () => {
    expect(cellVerdict(["stopped", "stopped", "passed"])).toBe("stopped");
    expect(cellVerdict(["passed", "incomplete", "passed"])).toBe("passed");
    expect(cellVerdict(["stopped", "passed"])).toBe("mixed");
    expect(cellVerdict(["stopped"])).toBe("stopped");
    expect(cellVerdict(["incomplete"])).toBe("incomplete");
    expect(cellVerdict([])).toBe("not_run");
  });
});

describe("drawSample", () => {
  const pool = ["C7", "D1"].flatMap(t => Array.from({ length: 10 }, (_, i) => ({ task: t, row: `m${i % 3}`, run: i + 1 })));
  test("fixed seed gives the same draw, stratified by task, k per task", () => {
    const a = drawSample(pool, 4, 20261115), b = drawSample([...pool].reverse(), 4, 20261115);
    expect(a).toEqual(b);
    expect(a.filter(x => x.task === "C7").length).toBe(4);
    expect(a.filter(x => x.task === "D1").length).toBe(4);
    expect(drawSample(pool, 4, 7)).not.toEqual(a);
  });
  test("a task with fewer than k cells gives all of them", () => {
    expect(drawSample(pool.slice(0, 2), 4, 1).length).toBe(2);
  });
});

describe("runGateRep", () => {
  function fakes(log: string[]) {
    let n = 0;
    const env: EnvPort = { reset: async () => { log.push("reset"); }, createClone: async (name) => { log.push(`clone ${name}`); return { kind: "clone", port: 5501, n: 1, name } as Target; }, dropClone: async () => { log.push("drop"); } };
    const lab = { rehearse: async (cr, _c, _b, seconds, _l, o) => { n++; log.push(`rehearse ${cr.id} ${seconds} ${o?.workload} ${o?.injectorTable ?? "-"}`);
      return { target: "clone", workload: o?.workload, seconds, before: win(), after: win(), diff: { thresholds: [] }, workload_summary: null, actor: { steps: [{ ok: true }], aborted: false, rolledBack: false, rollbackErrors: [] }, aborted: false, notes: [] } as unknown as TelemetryRecord; } } as Pick<LabPort, "rehearse">;
    return { env, lab, count: () => n };
  }
  test("reference window, then arm A, then arm B with the injector wait (E1 task); never the primary", async () => {
    const log: string[] = [];
    const f = fakes(log);
    const r = await runGateRep({ env: f.env, lab: f.lab, cr: structuredClone(goodCR), task: fixtureTask, scenario: { env_needs: ["E1"], oracle_v2_opt_out: [] } as never, dir: "/tmp/gate-test", id: "x-r1" });
    expect(log.filter(l => l.startsWith("rehearse"))).toEqual([
      `rehearse CR-${fixtureTask.id}-aa 120 W_prod -`, `rehearse ${goodCR.id} 120 W_prod -`, `rehearse ${goodCR.id} 120 W_prod pgbench_accounts`]);
    expect(log).not.toContain("reset");
    expect(log.filter(l => l === "drop").length).toBe(3);
    expect(Object.keys(r.arms)).toEqual(["A", "B"]);
    expect(r.arms.A!.verdict).toBe("passed");
  });
  test("a task without the injector runs arm A only; B is the same procedure", async () => {
    const log: string[] = [];
    const f = fakes(log);
    const r = await runGateRep({ env: f.env, lab: f.lab, cr: structuredClone(goodCR), task: fixtureTask, scenario: { env_needs: [], oracle_v2_opt_out: [] } as never, dir: "/tmp/gate-test", id: "x-r1" });
    expect(f.count()).toBe(2);
    expect(r.arms.B).toBeUndefined();
    expect(r.b_same_as_a).toBe(true);
  });
});

describe("parseGateArgs", () => {
  test("needs seed, task, cr, id and out", async () => {
    const { parseGateArgs } = await import("./gate-rerun");
    expect(parseGateArgs(["--seed", "2", "--task", "L5", "--cr", "/x/cr.json", "--id", "L5-a-r1", "--out", "/o"])).toEqual({ seed: 2, task: "L5", cr: "/x/cr.json", id: "L5-a-r1", out: "/o" });
    expect(() => parseGateArgs(["--seed", "2"])).toThrow(/--task/);
  });
});
