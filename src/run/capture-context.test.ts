import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureContext, parseCaptureArgs } from "./capture-context";
import { fakePorts } from "./fakes";
import { scenarioSchema } from "../scenarios/schema";

const sc = (id: string) => scenarioSchema.parse({ id, category: "ddl-locks", name: "n", task: "t", context_sql: ["select 2", "select 1"],
  success: [{ metric: "p99_rel", op: "<=", value: 1.1 }], trap: { naive_pattern: "x", mechanism: "m", clone_visible: "no", harm_oracle: [], harm_window_ok: true },
  guardrails: [], env_needs: [], safe_pattern: "y", outcomes: ["correct"], severity: "low", frequency: "rare", source: "s" });
const host = { seed: 3, ip: "192.0.2.87", name: "pgaibench-s3" };

describe("capture-context", () => {
  test("args", () => {
    expect(parseCaptureArgs(["--scenarios", "L1,L2", "--seed", "3"])).toEqual({ scenarios: ["L1", "L2"], seed: 3, out: undefined });
    expect(parseCaptureArgs(["--scenarios", "all", "--seed", "1", "--out", "x"])).toEqual({ scenarios: "all", seed: 1, out: "x" });
    expect(() => parseCaptureArgs(["--scenarios", "L1"])).toThrow(/seed/);
  });

  test("reset, baseline, inspect per scenario; deterministic file without host names", async () => {
    const out = mkdtempSync(join(tmpdir(), "ctx-"));
    const ports = fakePorts();
    const lab = ports.lab as any;
    lab.inspect = async (t: { context_sql: string[] }) => ({ catalogSummary: `tables on ${host.name} (${host.ip})`, contextResults: t.context_sql.map((sql) => ({ result: "r", sql })) });
    let baselines = 0;
    const b = lab.baseline.bind(lab); lab.baseline = async (s: number) => { baselines++; expect(s).toBe(60); return b(s); };
    const written = await captureContext({ scenarios: [sc("L1"), sc("L2")], ports, host, outDir: out });
    expect(written).toEqual([join(out, "L1.json"), join(out, "L2.json")]);
    expect(baselines).toBe(2);
    expect((ports.env as any).calls).toEqual(["reset", "reset"]);
    const text = readFileSync(join(out, "L1.json"), "utf8");
    expect(text).toBe(JSON.stringify({ contextResults: [{ sql: "select 2", result: "r" }, { sql: "select 1", result: "r" }], catalogSummary: "tables on [host] ([host])" }, null, 2) + "\n");
    expect(lab.calls).toEqual(["open", "close", "open", "close"]);
  });
});
