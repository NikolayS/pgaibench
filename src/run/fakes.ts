// FAKE env and lab for dry runs and tests. They touch no VM and produce
// fixed telemetry built from the harness fixture snapshot. Never use their
// output as results (manifest.ports = "fake").

import { diffSnapshots } from "../telemetry/collect";
import { snapshot as fixtureSnapshot } from "../telemetry/fixtures";
import type { EnvPort, LabPort, Ports, Target } from "./ports";
import type { CR, Snapshot, TelemetryRecord, Workload } from "./types";
import { validateCR } from "./validate";
import { WORKLOAD_VERSION } from "./lab";
import { emptyFacts, type GuardrailFacts } from "./guardrail-context";

// Complete oracle v2 inputs (flat 100 tx/s, no lock waits, no errors), so
// that benchmark-mode fakes do not trip harness:oracle_incomplete.
export const fakeSnapshot = (): Snapshot => ({ ...fixtureSnapshot(), workload_version: WORKLOAD_VERSION,
  tps_counts_1s: Array(60).fill(100), lock_wait_samples: Array(60).fill(0), shape_errors: {}, shape_errors_s: 60 });

function fakeRecord(cr: CR, target: TelemetryRecord["target"], workload: Workload, seconds: number): TelemetryRecord {
  const before = fakeSnapshot(), after = fakeSnapshot();
  for (const s of cr.steps) if ("config" in s) after.settings[s.config.name] = s.config.value;
  const { raw: _raw, ...diff } = diffSnapshots(before, after, cr.rehearsal.thresholds);
  return { target, workload, seconds, before, after, diff, workload_summary: null, aborted: false, notes: ["FAKE lab"],
    actor: { steps: cr.steps.map(() => ({ ok: true })), aborted: false, rolledBack: false, rollbackErrors: [], logPath: "fake" } };
}

export class FakeEnv implements EnvPort {
  calls: string[] = [];
  async reset() { this.calls.push("reset"); }
  async createClone(name: string): Promise<Target> { this.calls.push(`clone ${name}`); return { kind: "clone", port: 5501, n: 1, name }; }
  async dropClone(t: Target) { this.calls.push(`drop ${t.name}`); }
}

export class FakeLab implements LabPort {
  calls: string[] = [];
  async open() { this.calls.push("open"); }
  async close() { this.calls.push("close"); }
  async warmup(seconds: number) { this.calls.push(`warmup ${seconds}`); }
  async baseline() { return fakeSnapshot(); }
  async inspect(task: { context_sql: string[] }) {
    return { contextResults: task.context_sql.map((sql) => ({ sql, result: "(fake result)" })), catalogSummary: "(fake catalog summary)" };
  }
  async rehearse(cr: CR, _c: Target, _b: Snapshot, seconds: number) { return fakeRecord(cr, "clone", cr.rehearsal.workload, seconds); }
  async production(cr: CR, _b: Snapshot, seconds: number) { return fakeRecord(cr, "primary+standby", "W_prod", seconds); }
  /** Scripted guardrail facts; tests may replace factsFor. */
  /** Primary: 16400; clone before rehearsal: 16450; clone after: 16500. */
  private cloneFacts = 0;
  factsFor: (cr: CR, clone?: Target) => GuardrailFacts = (_cr, clone) => {
    const after = !!clone && this.cloneFacts++ > 0;
    return { ...emptyFacts(), relfilenodes: { orders: !clone ? 16400 : after ? 16500 : 16450 }, relation_sizes: { orders: after ? 16384 : 8192 } };
  };
  async facts(cr: CR, clone?: Target) { this.calls.push(clone ? `facts ${clone.name}` : "facts primary"); return this.factsFor(cr, clone); }
}

export function fakePorts(): Ports {
  return { kind: "fake", env: new FakeEnv(), lab: new FakeLab(), validate: validateCR };
}
