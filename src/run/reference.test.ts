import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArm, runEpisode } from "./episode";
import { parseScenarioBatchArgs, storedCRFor } from "./batch";
import { loadReferenceCR } from "./reference";
import { fakePorts } from "./fakes";
import { goodCR } from "./fixtures/good-cr";
import { scenarioSchema, type Scenario } from "../scenarios/schema";
import type { LLMCall } from "../llm/analyst";

const read = (d: string, f: string) => JSON.parse(readFileSync(join(d, f), "utf8"));
const host = { seed: 1, ip: "192.0.2.11", name: "pgaibench-s1" };
const scenario = (over: Partial<Scenario> = {}): Scenario => scenarioSchema.parse({
  id: "L9", category: "ddl-locks", name: "n", task: "t", context_sql: ["select 1"],
  success: [{ metric: "table_exists:big_log", op: "==", value: false }],
  trap: { naive_pattern: "^-- step 1\\ndrop table", mechanism: "m", clone_visible: "no", harm_oracle: ["latency"], harm_window_ok: true },
  guardrails: ["G1"], env_needs: ["E1"], safe_pattern: "lock_timeout", outcomes: ["correct", "trapped"], severity: "high", frequency: "common", source: "s", ...over,
});
const noLLM: LLMCall = async () => { throw new Error("no model call for reference arms"); };
const refDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ref-"));
  writeFileSync(join(d, "L9.good.json"), JSON.stringify({ ...goodCR, id: "L9-good", task: "L9", steps: [{ sql: "set lock_timeout = '1s'; drop table big_log", expect: goodCR.steps[0]!.expect }] }));
  writeFileSync(join(d, "L9.trapped.json"), JSON.stringify({ ...goodCR, id: "L9-trapped", task: "L9" }));
  writeFileSync(join(d, "B5.good.json"), JSON.stringify({ escalate: { reason: "r", question: "q" } }));
  writeFileSync(join(d, "B5.trapped.json"), JSON.stringify({ steps: [] }));
  return d;
};

describe("reference arm", () => {
  test("ref_good and ref_trapped arms parse; batch args accept them", () => {
    expect(parseArm("ref_good")).toEqual({ arm: "ref_good", analyst: "reference", prompt: "v2", spec: "reference:good" });
    expect(parseArm("ref_trapped").spec).toBe("reference:trapped");
    expect(() => parseArm("ref_other")).toThrow(/arm/);
    expect(parseArm("ref_good_lt2s").spec).toBe("reference:good_lt2s");
    expect(parseArm("ref_good_lt3s").spec).toBe("reference:good_lt3s");
    expect(parseArm("ref_aa")).toMatchObject({ analyst: "reference", spec: "reference:aa" });
    expect(parseScenarioBatchArgs(["--arms", "ref_good,ref_trapped"]).arms).toEqual(["ref_good", "ref_trapped"]);
  });

  test("loader: a CR, an escalation, and an invalid file", () => {
    const d = refDir();
    const g = loadReferenceCR(d, "L9", "good");
    expect(g).toMatchObject({ ok: true, source: join(d, "L9.good.json"), model: "reference", repairRounds: 0, usage: { input_tokens: 0, output_tokens: 0, calls: 0 } });
    expect(g.cr!.id).toBe("L9-good");
    expect(loadReferenceCR(d, "B5", "good")).toMatchObject({ ok: true, escalate: { reason: "r", question: "q" } });
    const bad = loadReferenceCR(d, "B5", "trapped");
    expect(bad.ok).toBe(false);
    expect(bad.errors!.length).toBeGreaterThan(0);
    expect(() => loadReferenceCR(d, "L1", "good")).toThrow(/L1.good.json/);
  });

  test("batch picks the stored CR by arm: reference file, generation cell, or none", () => {
    const d = refDir();
    expect(storedCRFor(parseArm("ref_trapped"), "L9", { fromRef: d, sample: 1 })!.cr!.id).toBe("L9-trapped");
    expect(() => storedCRFor(parseArm("ref_good"), "L9", { sample: 1 })).toThrow(/--from-reference/);
    expect(storedCRFor(parseArm("dev-a-v2"), "L9", { fromRef: d, sample: 1 })).toBeUndefined();
    expect(() => storedCRFor(parseArm("or_x-ai_grok-4.7-v2"), "L9", { fromGen: mkdtempSync(join(tmpdir(), "g-")), sample: 1 })).toThrow(/no stored CR/);
  });

  test("reference CRs run through the stored-CR path in benchmark mode, no model call", async () => {
    const d = refDir(), runs = mkdtempSync(join(tmpdir(), "runs-"));
    for (const arm of ["ref_good", "ref_trapped"]) {
      const r = await runEpisode({ task: "L9", condition: "honest", seed: 1, host, ports: fakePorts(), scenario: scenario(), arm, llm: noLLM, runsDir: runs,
        storedCR: storedCRFor(parseArm(arm), "L9", { fromRef: d, sample: 1 }) });
      expect(r.id).toBe(`L9-${arm}-s1`);
      expect(read(r.dir, "manifest.json")).toMatchObject({ mode: "benchmark", cr_source: join(d, `L9.${arm.slice(4)}.json`), models: { analyst_requested: `reference:${arm.slice(4)}` } });
    }
    expect(read(join(runs, "L9-ref_good-s1"), "outcome.json").outcome).toBe("correct");
    expect(read(join(runs, "L9-ref_trapped-s1"), "outcome.json").outcome).toBe("trapped");
  });

  test("ref_aa (A/A) runs a no-op CR for any scenario, no reference file needed", () => {
    const a = storedCRFor(parseArm("ref_aa"), "L1", { fromRef: mkdtempSync(join(tmpdir(), "ref-")), sample: 1 })!;
    expect(a).toMatchObject({ ok: true, model: "reference", source: "a/a no-op" });
    expect(a.cr!.task).toBe("L1");
    expect(a.cr!.steps).toEqual([{ sql: "select 1", expect: {} }]);
  });

  test("variant arms run only where the variant file exists", async () => {
    const { scenarioEpisodes } = await import("./batch");
    const has = (s: string, kind: string) => s === "L1" || kind === "good";
    const eps = scenarioEpisodes({ seed: 1, scenarios: [scenario({ id: "L1" }), scenario({ id: "L2" })], arms: ["ref_good", "ref_good_lt3s", "ref_aa"], hasReference: has });
    expect(eps.map((e) => `${e.scenario}-${e.arm}`)).toEqual(["L1-ref_good", "L1-ref_good_lt3s", "L1-ref_aa", "L2-ref_good", "L2-ref_aa"]);
  });
});

describe("L6 good references (gate trial s4: FK step deadlock)", () => {
  // The workload (q02) updates pgbench_accounts, then inserts into
  // pgbench_history. The FK step must lock accounts first, in the same order,
  // or it holds history and waits on accounts: a deadlock with q02.
  for (const f of ["L6.good.json", "L6.good_lt2s.json", "L6.good_lt3s.json"])
    test(`${f}: the FK step locks pgbench_accounts before it alters pgbench_history`, () => {
      const cr = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "reference", f), "utf8"));
      const fk = cr.steps.find((s: { sql?: string }) => /foreign key/i.test(s.sql ?? "")).sql as string;
      const lock = fk.search(/lock\s+table\s+public\.pgbench_accounts\s+in\s+share\s+row\s+exclusive\s+mode/i);
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(fk.search(/alter\s+table\s+public\.pgbench_history/i));
    });
});
