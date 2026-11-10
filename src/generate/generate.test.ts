import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarios } from "../scenarios/schema";
import { acquireLock, generationArm, parseGenerateArgs, resumeAll, runGenerate, worstCellUsd } from "./generate";
import { OPENROUTER_MAX_RETRIES } from "../llm/openrouter";
import type { LLMCall } from "../llm/analyst";

const scenarios = loadScenarios().filter((s) => ["L1", "L2"].includes(s.id));
const goodCR = (task: string) => ({
  id: `CR-${task}`, task, claims: [{ text: "c", verify_sql: "select 1", expect: "1" }],
  steps: [{ sql: "select 1", expect: { server_version: ">=0" } }],
  rehearsal: { workload: "W_prod", minutes: 2, metrics: ["p99_ms"], thresholds: { p99_ms: "<1.2x" } },
  rollback: ["select 1"], postconditions: ["p"], risk: { class_guess: "none", blast_radius: "none" },
});
const fence = (x: unknown) => "```json\n" + JSON.stringify(x) + "\n```";

function setup() {
  const out = trackTmp("gen-");
  const ctx = join(out, "context");
  mkdirSync(ctx);
  for (const s of scenarios) writeFileSync(join(ctx, `${s.id}.json`), JSON.stringify({ contextResults: [{ sql: "select 1", result: "1" }], catalogSummary: "cat" }));
  return { out, ctx };
}
const llmReturning = (f: (task: string) => string, usd = 0.01, calls: string[] = []): LLMCall => async (_i, input) => {
  const task = /## Task (\S+)/.exec(input[0]!.content)![1]!;
  calls.push(task);
  return { text: f(task), model: "resolved/model-1", usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 1, usd, provider: "P1", outcome: "ok", raw: { id: "g" } } as never;
};

test("arm name is path safe and carries the prompt", () => {
  expect(generationArm("deepseek/deepseek-v4-pro-0813", "v2")).toBe("or_deepseek_deepseek-v4-pro-0813-v2");
});

test("args: lists, all, samples, concurrency, max-usd", () => {
  const a = parseGenerateArgs(["--models", "a/b,c/d", "--scenarios", "all", "--samples", "3", "--out", "runs/", "--concurrency", "4", "--max-usd", "12.5"]);
  expect(a).toMatchObject({ models: ["a/b", "c/d"], scenarios: "all", samples: 3, out: "runs/", concurrency: 4, maxUsd: 12.5, prompt: "v2" });
  expect(() => parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "0", "--out", "r"])).toThrow(/samples/);
  expect(parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r", "--resume"]).resume).toBe(true);
  expect(parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r"]).resume).toBe(false);
  expect(() => parseGenerateArgs(["--scenarios", "all", "--samples", "1", "--out", "r"])).toThrow(/models/);
});

test("stores CR, transcript with raw response and provider, cost; resumes without calling again", async () => {
  const { out, ctx } = setup();
  const calls: string[] = [];
  const o = { models: ["x/m"], scenarios, samples: 2, out, contextDir: ctx, concurrency: 2, prompt: "v2" as const, llmFor: () => llmReturning((t) => fence(goodCR(t)), 0.01, calls) };
  const r = await runGenerate(o);
  expect(r).toMatchObject({ done: 4, skipped: 0, failed: 0 });
  const d = join(out, "generate", "L1-or_x_m-v2-s2");
  expect(JSON.parse(readFileSync(join(d, "cr.json"), "utf8")).task).toBe("L1");
  const gen = JSON.parse(readFileSync(join(d, "generation.json"), "utf8"));
  expect(gen).toMatchObject({ status: "cr", scenario: "L1", sample: 2, model_requested: "x/m", model_resolved: "resolved/model-1", providers: ["P1"] });
  const tr = JSON.parse(readFileSync(join(d, "transcript.json"), "utf8"));
  expect(tr.messages.at(-1)).toMatchObject({ provider: "P1", raw: { id: "g" }, usd: 0.01 });
  expect(JSON.parse(readFileSync(join(d, "cost.json"), "utf8"))).toMatchObject({ tokens: { input_tokens: 10, output_tokens: 5, calls: 1 }, usd: 0.01 });
  const again = await runGenerate(o);
  expect(again).toMatchObject({ done: 0, skipped: 4 });
  expect(calls).toHaveLength(4);
});

test("escalation and invalid CR are stored outcomes; thrown analyst errors are failures, retried on resume", async () => {
  const { out, ctx } = setup();
  let boom = true;
  const llm: LLMCall = async (i, input) => {
    const task = /## Task (\S+)/.exec(input[0]!.content)![1]!;
    if (task === "L2" && boom) throw new Error("OpenRouter HTTP 503");
    return llmReturning(() => task === "L1" ? fence({ escalate: { reason: "r", question: "q" } }) : "no json here")(i, input);
  };
  const o = { models: ["x/m"], scenarios, samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2" as const, llmFor: () => llm };
  expect(await runGenerate(o)).toMatchObject({ done: 1, failed: 1 });
  expect(existsSync(join(out, "generate", "L1-or_x_m-v2-s1", "escalate.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(out, "generate", "L2-or_x_m-v2-s1", "failed.json"), "utf8")).error).toContain("503");
  boom = false;
  expect(await runGenerate(o)).toMatchObject({ done: 1, skipped: 1, failed: 0 });
  const g = JSON.parse(readFileSync(join(out, "generate", "L2-or_x_m-v2-s1", "generation.json"), "utf8"));
  expect(g.status).toBe("cr_invalid");
  expect(g.errors.length).toBeGreaterThan(0);
});

test("missing context is a failure, no model call", async () => {
  const { out } = setup();
  const calls: string[] = [];
  const r = await runGenerate({ models: ["x/m"], scenarios, samples: 1, out, contextDir: join(out, "nope"), concurrency: 1, prompt: "v2", llmFor: () => llmReturning((t) => fence(goodCR(t)), 0, calls) });
  expect(r.failed).toBe(2);
  expect(calls).toHaveLength(0);
});

test("--max-usd stops starting cells once recorded cost passes the limit, counting earlier runs", async () => {
  const { out, ctx } = setup();
  const calls: string[] = [];
  const o = { models: ["x/m"], scenarios, samples: 3, out, contextDir: ctx, concurrency: 1, prompt: "v2" as const, maxUsd: 0.25, llmFor: () => llmReturning((t) => fence(goodCR(t)), 0.1, calls) };
  const r = await runGenerate(o);
  expect(r).toMatchObject({ done: 3, stopped: "max_usd" });
  expect(r.usd).toBeCloseTo(0.3);
  expect((await runGenerate(o)).done).toBe(0);
  expect(calls).toHaveLength(3);
});

test("loadStoredCR returns the stored result for an executed episode, or undefined", async () => {
  const { loadStoredCR } = await import("./generate");
  const { out, ctx } = setup();
  await runGenerate({ models: ["x/m"], scenarios, samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llmReturning((t) => fence(goodCR(t)), 0.05) });
  const s = loadStoredCR(out, "L1", "x/m", "v2", 1)!;
  expect(s).toMatchObject({ ok: true, cr: { task: "L1" }, model: "resolved/model-1", usage: { calls: 1, usd: 0.05 }, repairRounds: 0 });
  expect(s.source).toBe(join(out, "generate", "L1-or_x_m-v2-s1"));
  expect(s.transcript.messages).toHaveLength(2);
  expect(loadStoredCR(out, "L1", "x/m", "v2", 2)).toBeUndefined();
});

test("truncated answer: cell status truncated, no repair call", async () => {
  const { out, ctx } = setup();
  let n = 0;
  const llm: LLMCall = async () => { n++; return { text: "```json\n{", model: "m", usage: { input_tokens: 1, output_tokens: 32000 }, latency_ms: 1, usd: 0.5, outcome: "truncated", provider: "P", raw: {} } as never; };
  const r = await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llm });
  expect(r).toMatchObject({ done: 1, failed: 0 });
  expect(r.usd).toBeCloseTo(0.5);
  expect(n).toBe(1);
  const g = JSON.parse(readFileSync(join(out, "generate", "L1-or_x_m-v2-s1", "generation.json"), "utf8"));
  expect(g).toMatchObject({ status: "truncated", repair_needed: false });
  const { loadStoredCR } = await import("./generate");
  expect(loadStoredCR(out, "L1", "x/m", "v2", 1)).toMatchObject({ ok: false, truncated: true });
});

test("malformed answer gets at most one repair call; the cell records it", async () => {
  const { out, ctx } = setup();
  const calls: string[] = [];
  const r = await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => async (i, input) => { calls.push("c"); return llmReturning(() => "no json")(i, input); } });
  expect(r.done).toBe(1);
  expect(calls).toHaveLength(2);
  const g = JSON.parse(readFileSync(join(out, "generate", "L1-or_x_m-v2-s1", "generation.json"), "utf8"));
  expect(g).toMatchObject({ status: "cr_invalid", repair_rounds: 1, repair_needed: true });
  expect(JSON.parse(readFileSync(join(out, "generate", "L1-or_x_m-v2-s1", "cost.json"), "utf8")).usd).toBeCloseTo(0.02);
});

test("spend of a failed cell counts toward the USD guard; reasoning effort is recorded", async () => {
  const { out, ctx } = setup();
  let k = 0;
  const llm: LLMCall = async (i, input) => {
    if (++k === 2) throw Object.assign(new Error("OpenRouter HTTP 400"), { usd: 0.07 });
    return llmReturning(() => "no json", 0.03)(i, input);
  };
  const configFor = (m: string) => ({ id: m, vendor: "V", tier: "mid" as const, open_weights: false, provider: null, reasoning: null, default_effort: "medium" as const });
  const r = await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llm, configFor });
  expect(r.failed).toBe(1);
  expect(r.usd).toBeCloseTo(0.1);
  const { recordedUsd } = await import("./generate");
  expect(recordedUsd(out)).toBeCloseTo(0.1);
  const { out: out2, ctx: ctx2 } = setup();
  await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out: out2, contextDir: ctx2, concurrency: 1, prompt: "v2", llmFor: () => llmReturning((t) => fence(goodCR(t))), configFor });
  expect(JSON.parse(readFileSync(join(out2, "generate", "L1-or_x_m-v2-s1", "generation.json"), "utf8"))).toMatchObject({ reasoning_effort: "default", reasoning_effort_documented: "medium" });
});

test("--scenarios all skips holdout and v01: false scenarios unless --include-non-v01", async () => {
  const { selectScenarios } = await import("./generate");
  const { loadScenarios } = await import("../scenarios/schema");
  const all = loadScenarios();
  expect(selectScenarios(all, "all", false).map(s => s.id)).not.toContain("C12");
  expect(selectScenarios(all, "all", true).map(s => s.id)).toContain("C12");
  expect(selectScenarios(all, ["C12"], false).map(s => s.id)).toEqual(["C12"]);
  expect(parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r", "--include-non-v01"]).includeNonV01).toBe(true);
});

test("spend of a cell that fails on every run accumulates in the ledger", async () => {
  const { out, ctx } = setup();
  const llm: LLMCall = async () => { throw Object.assign(new Error("OpenRouter HTTP 503"), { usd: 2 }); };
  const o = { models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2" as const, llmFor: () => llm };
  for (let i = 0; i < 3; i++) await runGenerate(o);
  const { recordedUsd } = await import("./generate");
  expect(recordedUsd(out)).toBeCloseTo(6);
  const lines = readFileSync(join(out, "generate", "spend.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatchObject({ cell: "L1-or_x_m-v2-s1", usd: 2, source: "reported" });
});

test("ledger: per-attempt lines from the sink, no double count; truncated last line tolerated", async () => {
  const { out, ctx } = setup();
  const llmFor = (_m: string, sink?: (a: { attempt: number; usd: number; source: "reported" | "estimated" }) => void): LLMCall => async (i, input) => {
    sink?.({ attempt: 1, usd: 0.4, source: "estimated" });
    sink?.({ attempt: 2, usd: 0.1, source: "reported" });
    return { ...(await llmReturning((t) => fence(goodCR(t)), 0.5)(i, input)), usd: 0.5 };
  };
  await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor });
  const { recordedUsd } = await import("./generate");
  const f = join(out, "generate", "spend.jsonl");
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.attempt, l.source])).toEqual([[1, "estimated"], [2, "reported"]]);
  expect(recordedUsd(out)).toBeCloseTo(0.5);
  writeFileSync(f, readFileSync(f, "utf8") + '{"cell":"x","usd":9');
  expect(recordedUsd(out)).toBeCloseTo(0.5);
  writeFileSync(f, '{"broken\n' + readFileSync(f, "utf8"));
  expect(() => recordedUsd(out)).toThrow(/spend.jsonl/);
});

test("M2: reserves the worst case per cell, so concurrent cells cannot pass the cap", async () => {
  const { out, ctx } = setup();
  const calls: string[] = [];
  const configFor = (m: string) => ({ id: m, vendor: "V", tier: "mid" as const, open_weights: false, provider: null, reasoning: null, price_in: 0, price_out: 1, max_tokens: 16667 });
  // worst case per cell: 6 attempts x 2 calls x 16667 output tokens x 1 USD/M = 0.2 USD
  const r = await runGenerate({ models: ["x/m"], scenarios, samples: 3, out, contextDir: ctx, concurrency: 4, prompt: "v2", maxUsd: 0.5, configFor,
    llmFor: () => async (i, input) => { await Bun.sleep(5); return llmReturning((t) => fence(goodCR(t)), 0.2, calls)(i, input); } });
  expect(r.stopped).toBe("max_usd");
  expect(calls).toHaveLength(2);
  expect(r.usd).toBeLessThanOrEqual(0.5);
});

test("NEW-9/M2: cells whose two calls each spend all 6 attempts at max_tokens stay within --max-usd", async () => {
  const { out, ctx } = setup();
  const configFor = (m: string) => ({ id: m, vendor: "V", tier: "mid" as const, open_weights: false, provider: null, reasoning: null, price_in: 0, price_out: 1, max_tokens: 16667 });
  const per = 16667 / 1e6; // one attempt charged at max_tokens; worst cell = 12 x per (about 0.2 USD)
  const r = await runGenerate({ models: ["x/m"], scenarios, samples: 3, out, contextDir: ctx, concurrency: 4, prompt: "v2", maxUsd: 0.5, configFor,
    llmFor: (_m, sink) => { let calls = 0; return async (_i, input) => {
      const task = /## Task (\S+)/.exec(input[0]!.content)?.[1] ?? "L1";
      const first = calls++ % 2 === 0;
      // 5 timed-out attempts plus the answer: every attempt is charged.
      for (let a = 1; a <= OPENROUTER_MAX_RETRIES + 1; a++) { sink!({ attempt: a, usd: per, source: "estimated" }); await Bun.sleep(1); }
      return { text: first ? "not json" : fence(goodCR(task)), model: "resolved/model-1", usage: { input_tokens: 0, output_tokens: 16667 }, latency_ms: 1, usd: (OPENROUTER_MAX_RETRIES + 1) * per, provider: "P1", outcome: "ok" } as never;
    }; } });
  const { recordedUsd } = await import("./generate");
  const lines = readFileSync(join(out, "generate", "spend.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byCell = new Map<string, number>();
  for (const l of lines) byCell.set(l.cell, (byCell.get(l.cell) ?? 0) + 1);
  expect(r.stopped).toBe("max_usd");
  expect([...byCell.values()]).toEqual([12, 12]); // two admitted cells, each at the worst case
  expect(recordedUsd(out)).toBeCloseTo(12 * 2 * per);
  expect(recordedUsd(out)).toBeLessThanOrEqual(0.5);
});

test("M2: the cell reserve covers every retry attempt of both calls", () => {
  const cfg = { id: "m", vendor: "V", tier: "mid" as const, open_weights: false, provider: null, reasoning: null, price_in: 0, price_out: 1, max_tokens: 100000 };
  expect(OPENROUTER_MAX_RETRIES).toBe(5);
  expect(worstCellUsd(cfg, 0)).toBeCloseTo((OPENROUTER_MAX_RETRIES + 1) * 2 * 0.1);
});

test("N3: stale lock takeover is exclusive: a lock retaken by another runner meanwhile is not overwritten", () => {
  const { out } = setup();
  mkdirSync(join(out, "generate"), { recursive: true });
  const p = join(out, "generate", ".lock");
  writeFileSync(p, JSON.stringify({ pid: 2147483646 }));
  // another runner wins the takeover between our stale check and our write
  const winner = JSON.stringify({ pid: process.pid, at: "winner" });
  expect(() => acquireLock(out, () => {}, { onStale: () => writeFileSync(p, winner) })).toThrow(/lock held/);
  expect(readFileSync(p, "utf8")).toBe(winner);
  expect(existsSync(p + ".break")).toBe(false);
});

test("NEW-6: a .lock.break left by a dead runner does not block later runs", () => {
  const { out } = setup();
  mkdirSync(join(out, "generate"), { recursive: true });
  const p = join(out, "generate", ".lock");
  writeFileSync(p, JSON.stringify({ pid: 2147483646 }));
  writeFileSync(p + ".break", JSON.stringify({ pid: 2147483645 }));
  const release = acquireLock(out, () => {});
  expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid);
  expect(existsSync(p + ".break")).toBe(false);
  release();
  // a .break held by a live runner still refuses
  writeFileSync(p, JSON.stringify({ pid: 2147483646 }));
  writeFileSync(p + ".break", JSON.stringify({ pid: process.ppid }));
  expect(() => acquireLock(out, () => {})).toThrow(/\.break exists/);
});

test("lock race: a stale .break replaced by a live breaker meanwhile is not removed", () => {
  const { out } = setup();
  mkdirSync(join(out, "generate"), { recursive: true });
  const p = join(out, "generate", ".lock");
  writeFileSync(p, JSON.stringify({ pid: 2147483646 }));
  writeFileSync(p + ".break", JSON.stringify({ pid: 2147483645, at: "dead C" }));
  // After we judge C's .break stale, runner B removes it and creates its own (live) .break.
  const liveB = JSON.stringify({ pid: process.ppid, at: "B", nonce: "b" });
  expect(() => acquireLock(out, () => {}, { onStaleBreak: () => writeFileSync(p + ".break", liveB) })).toThrow(/\.break exists/);
  expect(readFileSync(p + ".break", "utf8")).toBe(liveB);
  expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(2147483646);
});

test("lock race: an empty .break is live while young, stale when old", () => {
  const { out } = setup();
  mkdirSync(join(out, "generate"), { recursive: true });
  const p = join(out, "generate", ".lock");
  writeFileSync(p, JSON.stringify({ pid: 2147483646 }));
  writeFileSync(p + ".break", "");
  expect(() => acquireLock(out, () => {})).toThrow(/\.break exists/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(p + ".break", old, old);
  const release = acquireLock(out, () => {});
  expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid);
  release();
});

test("NEW-7: release removes the lock only while it holds our own lock", () => {
  const { out } = setup();
  const p = join(out, "generate", ".lock");
  const release = acquireLock(out, () => {});
  const other = JSON.stringify({ pid: process.ppid, at: "other" });
  writeFileSync(p, other);
  release();
  expect(readFileSync(p, "utf8")).toBe(other);
});

test("NEW-8: --models all / --scenarios all resume the stored request of the out dir", () => {
  const { out } = setup();
  expect(resumeAll(out, "models", "all", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  mkdirSync(join(out, "generate"), { recursive: true });
  writeFileSync(join(out, "generate", "request.json"), JSON.stringify({ models: ["b", "a"], scenarios: ["L1"], samples: 1, prompt: "v2" }));
  // stored list equals what "all" expands to now: resumed as stored
  expect(resumeAll(out, "models", "all", ["a", "b"])).toEqual(["b", "a"]);
  // "all" now expands to more: refuse and name the difference, unless --resume
  expect(() => resumeAll(out, "models", "all", ["a", "b", "c"])).toThrow(/request\.json.*models.*"all" now adds c.*--resume/);
  expect(() => resumeAll(out, "scenarios", "all", ["L1", "L2"])).toThrow(/now adds L2/);
  expect(resumeAll(out, "models", "all", ["a", "b", "c"], true)).toEqual(["b", "a"]);
  expect(resumeAll(out, "scenarios", "all", ["L1", "L2"], true)).toEqual(["L1"]);
  // an explicit list is used as given (a different list still refuses in runGenerate)
  expect(resumeAll(out, "models", ["a"], ["a", "b", "c"])).toEqual(["a"]);
  // a stored id that is gone: the error says why
  expect(() => resumeAll(out, "models", "all", ["a", "c"])).toThrow(/request\.json.*b.*no longer/);
  expect(() => resumeAll(out, "models", "all", ["a", "c"], true)).toThrow(/no longer known.*holdout/);
});

test("M4: a second runner on the same out dir refuses; a stale lock is taken over", async () => {
  const { out, ctx } = setup();
  mkdirSync(join(out, "generate"), { recursive: true });
  writeFileSync(join(out, "generate", ".lock"), JSON.stringify({ pid: process.pid }));
  const o = { models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2" as const, llmFor: () => llmReturning((t) => fence(goodCR(t))) };
  await expect(runGenerate(o)).rejects.toThrow(/lock/);
  writeFileSync(join(out, "generate", ".lock"), JSON.stringify({ pid: 2147483646 }));
  const logs: string[] = [];
  expect((await runGenerate({ ...o, log: (s) => logs.push(s) })).done).toBe(1);
  expect(logs.some((l) => /stale lock/.test(l))).toBe(true);
  expect(existsSync(join(out, "generate", ".lock"))).toBe(false);
});

test("M6/N2: request.json is written once; a later run with a different request refuses", async () => {
  const { out, ctx } = setup();
  const calls: string[] = [];
  const o = { models: ["x/m"], scenarios, samples: 2, out, contextDir: ctx, concurrency: 1, prompt: "v2" as const, llmFor: () => llmReturning((t) => fence(goodCR(t)), 0.01, calls) };
  await runGenerate(o);
  const p = join(out, "generate", "request.json");
  expect(JSON.parse(readFileSync(p, "utf8"))).toMatchObject({ models: ["x/m"], scenarios: ["L1", "L2"], samples: 2, prompt: "v2" });
  const n = calls.length;
  for (const over of [{ samples: 1 }, { models: ["x/m", "y/n"] }, { scenarios: scenarios.slice(0, 1) }])
    await expect(runGenerate({ ...o, ...over })).rejects.toThrow(/request\.json.*differs/);
  expect(calls.length).toBe(n);
  expect(JSON.parse(readFileSync(p, "utf8")).samples).toBe(2);
  // same request in another order resumes
  expect((await runGenerate({ ...o, scenarios: [...scenarios].reverse() })).skipped).toBe(4);
  expect(existsSync(join(out, "generate", ".lock"))).toBe(false);
});

test("model outcomes are stored statuses; provider_mismatch is a retryable failure", async () => {
  const { out, ctx } = setup();
  const llm: LLMCall = async (_i, input) => {
    const task = /## Task (\S+)/.exec(input[0]!.content)![1]!;
    if (task === "L2") throw Object.assign(new Error("OpenRouter provider_mismatch"), { reason: "provider_mismatch", usd: 0.3 });
    return { text: "", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 1, usd: 0.1, outcome: "refusal", provider: "P", raw: {} } as never;
  };
  const r = await runGenerate({ models: ["x/m"], scenarios, samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llm });
  expect(r).toMatchObject({ done: 1, failed: 1 });
  expect(r.usd).toBeCloseTo(0.4);
  expect(JSON.parse(readFileSync(join(out, "generate", "L1-or_x_m-v2-s1", "generation.json"), "utf8"))).toMatchObject({ status: "refusal", repair_rounds: 0 });
  expect(JSON.parse(readFileSync(join(out, "generate", "L2-or_x_m-v2-s1", "failed.json"), "utf8"))).toMatchObject({ reason: "provider_mismatch" });
});

test("M5: cr_sha256 is recorded and verified by loadStoredCR", async () => {
  const { loadStoredCR } = await import("./generate");
  const { out, ctx } = setup();
  await runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llmReturning((t) => fence(goodCR(t))) });
  const d = join(out, "generate", "L1-or_x_m-v2-s1");
  const sha = new Bun.CryptoHasher("sha256").update(readFileSync(join(d, "cr.json"))).digest("hex");
  expect(JSON.parse(readFileSync(join(d, "generation.json"), "utf8")).cr_sha256).toBe(sha);
  expect(loadStoredCR(out, "L1", "x/m", "v2", 1)!.cr_sha256).toBe(sha);
  writeFileSync(join(d, "cr.json"), readFileSync(join(d, "cr.json"), "utf8").replace("select 1", "select 2"));
  expect(() => loadStoredCR(out, "L1", "x/m", "v2", 1)).toThrow(/sha256/);
});

test("M9: preflight sends one minimal request per model, writes the ledger, respects the cap", async () => {
  const { runPreflight, recordedUsd } = await import("./generate");
  const { out } = setup();
  const seenReq: { model: string; max_tokens: number }[] = [];
  const cfg = (id: string) => ({ id, vendor: "V", tier: "mid" as const, open_weights: true, provider: { order: ["P1"], allow_fallbacks: false as const }, reasoning: null, price_in: 1, price_out: 1 });
  const call = async (model: string, maxTokens: number, sink: (a: { attempt: number; usd: number; source: "reported" | "estimated" }) => void) => {
    seenReq.push({ model, max_tokens: maxTokens });
    if (model === "b/bad") { sink({ attempt: 1, usd: 0.001, source: "reported" }); throw Object.assign(new Error("OpenRouter provider_mismatch: served by P2"), { reason: "provider_mismatch", usd: 0.001 }); }
    sink({ attempt: 1, usd: 0.002, source: "reported" });
    return { outcome: "ok", text: "hi", model, provider: "P1", usage: { input_tokens: 5, output_tokens: 2 }, latency_ms: 1, usd: 0.002, raw: {}, attempts: 1 } as never;
  };
  const rows = await runPreflight({ models: ["a/good", "b/bad"], out, configFor: cfg, call });
  expect(seenReq).toEqual([{ model: "a/good", max_tokens: 16 }, { model: "b/bad", max_tokens: 16 }]);
  expect(rows).toEqual([
    { model: "a/good", status: "ok", provider: "P1", pin_respected: true, usd: 0.002 },
    { model: "b/bad", status: "error: OpenRouter provider_mismatch: served by P2", provider: null, pin_respected: false, usd: 0.001 },
  ]);
  expect(recordedUsd(out)).toBeCloseTo(0.003);
  const capped = await runPreflight({ models: ["a/good"], out, configFor: cfg, call, maxUsd: 0.003 });
  expect(capped[0]!.status).toMatch(/max_usd/);
});

// ---- access paths: Codex CLI and Claude Code CLI on subscriptions (fake binaries on PATH) ----
import { claudeStream, fake, fakeBoth, cleanupTmp, trackTmp } from "../llm/fake-cli-helper";
import { llmForModel, loadStoredCR, recordedUsd, runPreflight } from "./generate";
import { findModel as findRepoModel } from "../llm/openrouter";

afterAll(cleanupTmp);

const codexAnswer = (text: string, inTok = 7000) => [
  "codex banner line",
  '{"type":"item.completed","item":{"id":"i0","type":"error","message":"features.skills is ignored"}}',
  `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":${JSON.stringify(text)}}}`,
  `{"type":"turn.completed","usage":{"input_tokens":${inTok},"cached_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":20}}`,
].join("\n") + "\n";
const claudeAnswer = (text: string, o: Record<string, unknown> = {}) => claudeStream({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", total_cost_usd: 0.02,
  usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 40, output_tokens_details: { thinking_tokens: 10 } },
  modelUsage: { "claude-haiku-5-5": { canonicalModel: "claude-haiku-5-5", provider: "firstParty", thinkingTokens: 10, costUSD: 0.02 } }, ...o }, { init: { model: "claude-haiku-5-5" } });
const quick = { sleep: async () => {}, backoffMs: [1, 1] };

test("arm prefix tells the access path apart: or_ OpenRouter, cx_ Codex CLI, cc_ Claude CLI", () => {
  expect(generationArm("openai/gpt-6-luna", "v2")).toBe("cx_openai_gpt-6-luna-v2");
  expect(generationArm("anthropic/claude-haiku-5.5", "v2-checklist")).toBe("cc_anthropic_claude-haiku-5.5-v2-checklist");
  expect(generationArm("x-ai/grok-4.7", "v2")).toBe("or_x-ai_grok-4.7-v2");
});

test("args: per-access concurrency, Codex 1 by default, Claude 2", () => {
  const base = ["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r"];
  expect(parseGenerateArgs(base)).toMatchObject({ concurrency: 4, codexConcurrency: 1, claudeConcurrency: 2 });
  expect(parseGenerateArgs([...base, "--codex-concurrency", "3"])).toMatchObject({ codexConcurrency: 3 });
  expect(parseGenerateArgs([...base, "--codex-concurrency", "1", "--claude-concurrency", "3"])).toMatchObject({ codexConcurrency: 1, claudeConcurrency: 3 });
});

test("mixed run: CLI cells record access, wrapper, effort, billing subscription; 0 USD billed, list price apart; ledger untouched; repair works on the CLI path", async () => {
  const { out, ctx } = setup();
  // Codex: first answer malformed, the repair call fixes it. Claude: good at once.
  const cx = fake("codex", [codexAnswer("not json"), codexAnswer(fence(goodCR("L1")))]);
  const cc = fake("claude", [claudeAnswer(fence(goodCR("L1")))]);
  const env = fakeBoth(cx, cc);
  const models = ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"];
  const r = await runGenerate({ models, scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env, ...quick }) });
  expect(r).toMatchObject({ done: 2, failed: 0, usd: 0 });
  expect(recordedUsd(out)).toBe(0);
  const gx = JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "generation.json"), "utf8"));
  expect(gx).toMatchObject({ status: "cr", access: "codex-cli", wrapper: "codex-cli 9.9.9", cli_model: "gpt-6-luna", effort_requested: "medium", billing: "subscription", repair_rounds: 1, providers: [] });
  expect(gx.reported).toHaveLength(2);
  expect(gx.reported[0]).toMatchObject({ input_tokens: 7000, reasoning_tokens: 20 });
  expect(gx.cli_warnings).toEqual(["features.skills is ignored"]);
  const cxStdin2 = cx.rec("stdin", 2);
  expect(cxStdin2).toContain("not json"); // repair turn carries the conversation
  expect(cx.rec("instr", 2)).toBe(cx.rec("instr", 1));
  const tr = JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "transcript.json"), "utf8"));
  expect(tr.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.content)).not.toContain("codex banner line");
  const gc = JSON.parse(readFileSync(join(out, "generate", "L1-cc_anthropic_claude-haiku-5.5-v2-s1", "generation.json"), "utf8"));
  expect(gc).toMatchObject({ status: "cr", access: "claude-cli", wrapper: "claude-code 9.9.9", cli_model: "claude-haiku-5-5", effort_requested: "medium", billing: "subscription", model_resolved: "claude-haiku-5-5" });
  expect(gc.reported[0]).toMatchObject({ model: "claude-haiku-5-5", provider: "firstParty", reasoning_tokens: 10 });
  const cost = JSON.parse(readFileSync(join(out, "generate", "L1-cc_anthropic_claude-haiku-5.5-v2-s1", "cost.json"), "utf8"));
  expect(cost).toMatchObject({ usd: 0, billing: "subscription", list_price_usd_equivalent: 0.02 });
  // The lab loader finds CLI cells by model id.
  expect(loadStoredCR(out, "L1", "openai/gpt-6-luna", "v2", 1)?.cr).toMatchObject({ task: "L1" });
  const { storedCRFor } = await import("../run/batch");
  const { parseArm } = await import("../run/episode");
  expect(storedCRFor(parseArm("or_anthropic_claude-haiku-5.5-v2"), "L1", { fromGen: out, sample: 1 })?.cr).toMatchObject({ task: "L1" });
});

test("CLI refusal, empty and truncated answers are stored outcomes as on OpenRouter", async () => {
  const { out, ctx } = setup();
  const cc = fake("claude", [claudeAnswer("I won't", { stop_reason: "refusal" }), claudeAnswer(""), ]);
  const env = cc.env;
  const r = await runGenerate({ models: ["anthropic/claude-haiku-5.5"], scenarios, samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", concurrencyFor: { "claude-cli": 1 }, configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env, ...quick }) });
  expect(r.done).toBe(2);
  const st = ["L1", "L2"].map((s) => JSON.parse(readFileSync(join(out, "generate", `${s}-cc_anthropic_claude-haiku-5.5-v2-s1`, "generation.json"), "utf8")).status).sort();
  expect(st).toEqual(["empty", "refusal"]);
  const { out: o2, ctx: c2 } = setup();
  const t = fake("claude", [claudeAnswer("{", { stop_reason: "max_tokens" })]);
  await runGenerate({ models: ["anthropic/claude-haiku-5.5"], scenarios: scenarios.slice(0, 1), samples: 1, out: o2, contextDir: c2, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: t.env, ...quick }) });
  expect(JSON.parse(readFileSync(join(o2, "generate", "L1-cc_anthropic_claude-haiku-5.5-v2-s1", "generation.json"), "utf8")).status).toBe("truncated");
});

test("exhausted usage window: failed.json reason access:subscription_limit, retryable; no paid fallback", async () => {
  const { out, ctx } = setup();
  const cx = fake("codex", [], { out: '{"type":"error","message":"You\'ve hit your usage limit."}\n', code: 1 });
  let orCalls = 0;
  const r = await runGenerate({ models: ["openai/gpt-6-luna"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick, openrouterCall: async () => { orCalls++; throw new Error("no"); } }) });
  expect(r.failed).toBe(1);
  expect(JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "failed.json"), "utf8"))).toMatchObject({ reason: "access:subscription_limit", retryable: true });
  expect(orCalls).toBe(0);
});

test("llmForModel refuses an openai/anthropic id configured for OpenRouter", () => {
  expect(() => llmForModel({ ...findRepoModel("openai/gpt-6-luna")!, access: "openrouter" } as never, () => {}, {})).toThrow(/subscription/);
});

test("per-access concurrency: CLI pools are capped independently of OpenRouter", async () => {
  const { out, ctx } = setup();
  const live: Record<string, number> = {}, peak: Record<string, number> = {};
  const llmFor = (m: string): LLMCall => async (i, input) => {
    const k = m.split("/")[0]!;
    live[k] = (live[k] ?? 0) + 1; peak[k] = Math.max(peak[k] ?? 0, live[k]!);
    await Bun.sleep(15); live[k]!--;
    return llmReturning((t) => fence(goodCR(t)), 0)(i, input);
  };
  await runGenerate({ models: ["openai/a", "anthropic/b", "x/c"], scenarios, samples: 4, out, contextDir: ctx, concurrency: 5, prompt: "v2", llmFor,
    concurrencyFor: { "codex-cli": 1, "claude-cli": 2, openrouter: 5 } });
  expect(peak).toEqual({ openai: 1, anthropic: 2, x: 5 });
});

test("Codex pool runs one cell at a time unless raised (concurrent login refreshes conflict)", async () => {
  const { out, ctx } = setup();
  let live = 0, peak = 0;
  const llmFor = (): LLMCall => async (i, input) => {
    live++; peak = Math.max(peak, live);
    await Bun.sleep(15); live--;
    return llmReturning((t) => fence(goodCR(t)), 0)(i, input);
  };
  await runGenerate({ models: ["openai/a"], scenarios, samples: 4, out, contextDir: ctx, concurrency: 5, prompt: "v2", llmFor });
  expect(peak).toBe(1);
});

test("preflight covers CLI models with one tiny call each, no ledger line", async () => {
  const out = trackTmp("pf-");
  const cx = fake("codex", [codexAnswer("ok")]), cc = fake("claude", [claudeAnswer("ok")]);
  const env = fakeBoth(cx, cc);
  const { preflightCall } = await import("./generate");
  const rows = await runPreflight({ models: ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"], out, configFor: (m) => findRepoModel(m), call: (m, mt, sink) => preflightCall(findRepoModel(m)!, mt, sink, { env, ...quick }) });
  expect(rows).toMatchObject([{ model: "openai/gpt-6-luna", status: "error: marker system prompt not followed (answer \"ok\")", usd: 0 }, { model: "anthropic/claude-haiku-5.5", status: "error: marker system prompt not followed (answer \"ok\")", usd: 0 }]);
  expect(cx.rec("args")).toContain('model_reasoning_effort="medium"');
  expect(recordedUsd(out)).toBe(0);
});

test("a Codex tool item fails the cell access:tool_use_detected with raw events kept; a later run does not retry it", async () => {
  const { out, ctx } = setup();
  const tool = '{"type":"item.completed","item":{"id":"x","type":"command_execution","command":"ls ~","aggregated_output":"secret","status":"completed"}}\n';
  const cx = fake("codex", [], { out: tool + codexAnswer("ok") });
  const run = () => runGenerate({ models: ["openai/gpt-6-luna"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick }) });
  expect((await run()).failed).toBe(1);
  const dir = join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1");
  const f = JSON.parse(readFileSync(join(dir, "failed.json"), "utf8"));
  expect(f).toMatchObject({ reason: "access:tool_use_detected" });
  expect(f.retryable).toBeUndefined();
  expect(readFileSync(join(dir, "raw_events.json"), "utf8")).toContain("command_execution");
  expect(cx.calls()).toBe(1);
  expect((await run()).failed).toBe(1);
  expect(cx.calls()).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, "failed.json"), "utf8")).reason).toBe("access:tool_use_detected");
});

test("M1: possible overage on a CLI cell stops all CLI cells (billing unknown); OpenRouter cells go on", async () => {
  const { out, ctx } = setup();
  const cc = fake("claude", [], { out: claudeStream({ type: "result", subtype: "success", is_error: false, result: fence(goodCR("L1")), stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }, { rateLimit: { isUsingOverage: true } }) });
  const cx = fake("codex", [], { out: codexAnswer(fence(goodCR("L1"))) });
  const env = fakeBoth(cx, cc);
  const logs: string[] = [];
  let orCalls = 0;
  const r = await runGenerate({ models: ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna", "x/c"], scenarios, samples: 2, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m), log: (s) => logs.push(s),
    concurrencyFor: { "claude-cli": 1, "codex-cli": 1, openrouter: 1 },
    llmFor: (m, sink) => m === "x/c" ? (async (i, input) => { orCalls++; return llmReturning((t) => fence(goodCR(t)), 0)(i, input); }) : llmForModel(findRepoModel(m)!, sink, { env, ...quick }) });
  expect(r.stopped).toBe("possible_overage");
  const f = JSON.parse(readFileSync(join(out, "generate", "L1-cc_anthropic_claude-haiku-5.5-v2-s1", "failed.json"), "utf8"));
  expect(f).toMatchObject({ reason: "access:possible_overage", billing: "unknown" });
  expect(cc.calls()).toBe(1);
  expect(cx.calls()).toBeLessThanOrEqual(1);
  expect(orCalls).toBe(scenarios.length * 2);
  expect(logs.some((l) => /plan usage only/.test(l))).toBe(true);
});

test("M1: preflight records the CLI account status next to the rows", async () => {
  const out = trackTmp("pf-");
  await runPreflight({ models: ["a/x"], out, configFor: () => undefined, call: async () => ({ outcome: "ok", provider: null }), accountStatus: async () => ({ claude: { subscriptionType: "max" } }) });
  expect(JSON.parse(readFileSync(join(out, "generate", "preflight-status.json"), "utf8"))).toMatchObject({ account: { claude: { subscriptionType: "max" } }, rows: [{ model: "a/x", status: "ok" }] });
});

describe("M5: old run dirs with paid OpenRouter cells for subscription vendors", () => {
  const llmFor = () => llmReturning((t) => fence(goodCR(t)), 0);
  test("resume refuses when an or_openai_* or or_anthropic_* cell exists", async () => {
    for (const old of ["L1-or_openai_gpt-6-luna-v2-s1", "L1-or_anthropic_claude-haiku-5.5-v2-s1"]) {
      const { out, ctx } = setup();
      mkdirSync(join(out, "generate", old), { recursive: true });
      writeFileSync(join(out, "generate", old, "generation.json"), "{}");
      await expect(runGenerate({ models: ["x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor })).rejects.toThrow(/paid OpenRouter cells.*new --out/s);
    }
  });
  test("request.json records the access path per model; a stored request without it, or with another path, refuses", async () => {
    const { out, ctx } = setup();
    await runGenerate({ models: ["openai/a", "x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor });
    const req = join(out, "generate", "request.json");
    expect(JSON.parse(readFileSync(req, "utf8")).access).toEqual({ "openai/a": "codex-cli", "x/m": "openrouter" });
    const r = JSON.parse(readFileSync(req, "utf8"));
    writeFileSync(req, JSON.stringify({ ...r, access: { ...r.access, "openai/a": "openrouter" } }));
    await expect(runGenerate({ models: ["openai/a", "x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor })).rejects.toThrow(/access/);
    const { access: _, ...noAccess } = r;
    writeFileSync(req, JSON.stringify(noAccess));
    await expect(runGenerate({ models: ["openai/a", "x/m"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor })).rejects.toThrow(/access/);
  });
});

test("M6: generation.json has effort_requested, effort_confirmed, model_served and reasoning_tokens; null when not reported, never 0 by default", async () => {
  const { out, ctx } = setup();
  const noReasoning = ['{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":' + JSON.stringify(fence(goodCR("L1"))) + "}}", '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5}}'].join("\n") + "\n";
  const cx = fake("codex", [noReasoning]);
  const cc = fake("claude", [claudeAnswer(fence(goodCR("L1")))]);
  const env = fakeBoth(cx, cc);
  await runGenerate({ models: ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "x/c"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => m === "x/c" ? llmReturning((t) => fence(goodCR(t)), 0) : llmForModel(findRepoModel(m)!, sink, { env, ...quick }) });
  const g = (cell: string) => JSON.parse(readFileSync(join(out, "generate", cell, "generation.json"), "utf8"));
  expect(g("L1-cx_openai_gpt-6-luna-v2-s1")).toMatchObject({ effort_requested: "medium", effort_confirmed: null, model_served: null, reasoning_tokens: null, service_tier: "default", service_tier_reported: null });
  expect(g("L1-cc_anthropic_claude-haiku-5.5-v2-s1")).toMatchObject({ service_tier: null });
  expect(g("L1-cc_anthropic_claude-haiku-5.5-v2-s1")).toMatchObject({ effort_requested: "medium", effort_confirmed: null, model_served: "claude-haiku-5-5", reasoning_tokens: 10 });
  const o = g("L1-or_x_c-v2-s1");
  expect(o).toHaveProperty("effort_confirmed", null);
  expect(o).toHaveProperty("reasoning_tokens", null);
});

test("L1: llmForModel refuses a router id or a subscription vendor field on the OpenRouter path", () => {
  const base = { tier: "small", open_weights: false, provider: null, access: "openrouter" } as never;
  expect(() => llmForModel({ ...(base as object), id: "openrouter/auto", vendor: "OpenRouter" } as never, () => {}, {})).toThrow(/router id/);
  expect(() => llmForModel({ ...(base as object), id: "x/alias", vendor: "OpenAI" } as never, () => {}, {})).toThrow(/subscription/);
});

test("generation.json labels quantization as requested and served", async () => {
  const { out, ctx } = setup();
  const llm: LLMCall = async (i, input) => ({ ...(await llmReturning((t) => fence(goodCR(t)), 0)(i, input)), quantization_requested: "fp8", quantization_served: null } as never);
  await runGenerate({ models: ["deepseek/deepseek-v4-pro-0813"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m), llmFor: () => llm });
  const g = JSON.parse(readFileSync(join(out, "generate", "L1-or_deepseek_deepseek-v4-pro-0813-v2-s1", "generation.json"), "utf8"));
  expect(g).toMatchObject({ quantization_requested: "fp8", quantization_served: null });
  expect(g).not.toHaveProperty("quantization");
});

test("preflight (CLI): a marker system prompt must come back, and input tokens stay under the ceiling (base prompt replaced)", async () => {
  const { preflightCall, CLI_PREFLIGHT_INPUT_CEILING } = await import("./generate");
  const run = async (codexOut: (marker: string) => string, claudeOut: (marker: string) => string) => {
    const out = trackTmp("pf-");
    const cx = fake("codex", []), cc = fake("claude", []);
    const env = fakeBoth(cx, cc);
    // The fakes answer with whatever marker the instructions file holds.
    const rows = await runPreflight({ models: ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"], out, configFor: (m) => findRepoModel(m), call: async (m, mt, sink) => {
      const marker = "PF-TEST-MARKER";
      writeFileSync(join(m.startsWith("openai") ? cx.d : cc.d, "out.last"), m.startsWith("openai") ? codexOut(marker) : claudeOut(marker));
      return preflightCall(findRepoModel(m)!, mt, sink, { env, ...quick }, marker);
    } });
    return { rows, cx, cc };
  };
  const good = await run((mk) => codexAnswer(mk, 900), (mk) => claudeAnswer(mk));
  expect(good.rows).toMatchObject([{ status: "ok", input_tokens: 900, reasoning_tokens: 20, provider: "codex-cli 9.9.9" }, { status: "ok", reasoning_tokens: 10, provider: "claude-code 9.9.9 claude-haiku-5-5" }]);
  expect(good.cx.rec("instr")).toContain("PF-TEST-MARKER");
  const big = await run((mk) => codexAnswer(mk, CLI_PREFLIGHT_INPUT_CEILING["codex-cli"] + 1), (mk) => claudeAnswer(mk));
  expect(big.rows[0]!.status).toMatch(/input tokens .* over the ceiling/);
});

test("N1: preflight fails a Codex model whose offline request carries a tool, before any model call", async () => {
  const { preflightCall } = await import("./generate");
  const out = trackTmp("pf-");
  const cx = fake("codex", [codexAnswer("ok")]);
  writeFileSync(join(cx.d, "capture.body"), JSON.stringify({ model: "gpt-6-luna", tools: [], input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }] }] }] }));
  const rows = await runPreflight({ models: ["openai/gpt-6-luna"], out, configFor: (m) => findRepoModel(m), call: (m, mt, sink) => preflightCall(findRepoModel(m)!, mt, sink, { env: cx.env, ...quick }) });
  expect(rows[0]!.status).toMatch(/error: .*functions\.apply_patch/);
  expect(cx.calls()).toBe(0);
});

test("N1: a model that fails the isolation check gets failed cells (access:isolation_failed) and no call; others run", async () => {
  const { out, ctx } = setup();
  const called: string[] = [];
  const r = await runGenerate({ models: ["openai/a", "x/c"], scenarios: scenarios.slice(0, 1), samples: 2, out, contextDir: ctx, concurrency: 1, prompt: "v2",
    isolation: async (m) => { if (m === "openai/a") throw Object.assign(new Error("tools offered: functions.apply_patch"), { reason: "access:isolation_failed" }); },
    llmFor: (m) => async (i, input) => { called.push(m); return llmReturning((t) => fence(goodCR(t)), 0)(i, input); } });
  expect(r.failed).toBe(2);
  expect(called.every((m) => m === "x/c")).toBe(true);
  const f = JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_a-v2-s1", "failed.json"), "utf8"));
  expect(f).toMatchObject({ reason: "access:isolation_failed" });
  expect(f.error).toContain("apply_patch");
});

describe("N4: CLI start gate", () => {
  const tested = { codex: ["0.164.0"], claude: ["2.1.322"], codex_features: ["shell_tool", "fast_mode"] };
  test("an untested CLI stops the run before any call; --allow-untested-cli runs the isolation preflight first and needs every row ok", async () => {
    const { cliStartGate } = await import("./generate");
    const cx = fake("codex", []);
    let pf = 0;
    const ok = async () => { pf++; return [{ model: "openai/gpt-6-luna", status: "ok", provider: null, pin_respected: null, usd: 0 }]; };
    await expect(cliStartGate({ models: ["openai/gpt-6-luna", "x/c"], env: cx.env, tested, preflight: ok })).rejects.toThrow(/codex-cli 9\.9\.9 is not a tested version/);
    expect(pf).toBe(0);
    await cliStartGate({ models: ["openai/gpt-6-luna"], env: cx.env, tested, allowUntested: true, preflight: ok });
    expect(pf).toBe(1);
    await expect(cliStartGate({ models: ["openai/gpt-6-luna"], env: cx.env, tested, allowUntested: true,
      preflight: async () => [{ model: "openai/gpt-6-luna", status: "error: tools", provider: null, pin_respected: null, usd: 0 }] })).rejects.toThrow(/isolation preflight failed/);
    await cliStartGate({ models: ["openai/gpt-6-luna"], env: cx.env, tested: { ...tested, codex: ["9.9.9"] }, preflight: async () => { throw new Error("not called"); } });
    await cliStartGate({ models: ["x/c"], env: cx.env, tested, preflight: async () => { throw new Error("not called"); } });
    expect(cx.calls()).toBe(0);
  });
  test("parseGenerateArgs reads --allow-untested-cli", () => {
    expect(parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r", "--allow-untested-cli"]).allowUntestedCli).toBe(true);
    expect(parseGenerateArgs(["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r"]).allowUntestedCli).toBe(false);
  });
});

test("N3: a Codex login conflict stops the Codex cells loudly; other paths go on", async () => {
  const { out, ctx } = setup();
  const cx = fake("codex", [], { out: codexAnswer(fence(goodCR("L1"))) });
  writeFileSync(join(cx.d, "sourcepath"), join(cx.home, ".codex", "auth.json"));
  writeFileSync(join(cx.d, "refresh.1"), '{"tokens":"MINE"}');
  writeFileSync(join(cx.d, "sourcechange.1"), '{"tokens":"OTHER"}');
  const logs: string[] = [];
  let orCalls = 0;
  const r = await runGenerate({ models: ["openai/gpt-6-luna", "x/c"], scenarios, samples: 2, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m), log: (s) => logs.push(s),
    concurrencyFor: { "codex-cli": 1, openrouter: 1 },
    llmFor: (m, sink) => m === "x/c" ? (async (i, input) => { orCalls++; return llmReturning((t) => fence(goodCR(t)), 0)(i, input); }) : llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick, codexLoginStash: join(out, "generate", "codex-login") }) });
  expect(r.stopped).toBe("codex_login_conflict");
  expect(cx.calls()).toBe(1);
  expect(orCalls).toBe(scenarios.length * 2);
  expect(JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "failed.json"), "utf8")).reason).toBe("access:login_conflict");
  expect(logs.some((l) => /STOP codex-cli/.test(l) && /codex login status/.test(l))).toBe(true);
  expect(readFileSync(join(cx.home, ".codex", "auth.json"), "utf8")).toBe('{"tokens":"OTHER"}');
});

test("stores the exact first request: system prompt and user message once per hash, sha256 per cell", async () => {
  const { out, ctx } = setup();
  const seen: { i: string; u: string }[] = [];
  const llm: LLMCall = async (i, input) => { seen.push({ i, u: input[0]!.content }); return llmReturning((t) => fence(goodCR(t)), 0)(i, input); };
  await runGenerate({ models: ["x/m"], scenarios, samples: 2, out, contextDir: ctx, concurrency: 1, prompt: "v2", llmFor: () => llm });
  const { createHash } = await import("node:crypto");
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const sc of ["L1", "L2"]) {
    const gen = JSON.parse(readFileSync(join(out, "generate", `${sc}-or_x_m-v2-s1`, "generation.json"), "utf8"));
    const first = seen.find((s) => s.u.startsWith(`## Task ${sc}\n`))!;
    expect(gen.request).toEqual({ system_sha256: h(first.i), user_sha256: h(first.u) });
    expect(readFileSync(join(out, "wire", `system-${gen.request.system_sha256}.md`), "utf8")).toBe(first.i);
    expect(readFileSync(join(out, "wire", `user-${sc}-${gen.request.user_sha256}.md`), "utf8")).toBe(first.u);
  }
});

test("M7: the checklist prompt is experimental, not part of v0.1 generation", () => {
  const base = ["--models", "all", "--scenarios", "all", "--samples", "1", "--out", "r"];
  expect(parseGenerateArgs(base).prompt).toBe("v2");
  expect(() => parseGenerateArgs([...base, "--prompt", "v2-checklist"])).toThrow(/experimental/);
  expect(parseGenerateArgs([...base, "--prompt", "v2-checklist", "--experimental-checklist"]).prompt).toBe("v2-checklist");
});

describe("effort confirmed at the isolation preflight", () => {
  const cxOk = () => ['{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":' + JSON.stringify(fence(goodCR("L1"))) + "}}", '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5}}'].join("\n") + "\n";
  test("generation.json records effort_confirmed and text_verbosity from the offline capture", async () => {
    const { isolationCheck } = await import("./generate");
    const { out, ctx } = setup();
    const cx = fake("codex", [cxOk()]);
    writeFileSync(join(cx.d, "capture.body"), JSON.stringify({ model: "gpt-6-luna", tools: [], reasoning: { effort: "medium" }, text: { verbosity: "low" }, input: [] }));
    await runGenerate({ models: ["openai/gpt-6-luna"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
      isolation: (m) => isolationCheck(findRepoModel(m)!, { env: cx.env }), llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick }) });
    const g = JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "generation.json"), "utf8"));
    expect(g).toMatchObject({ effort_requested: "medium", effort_confirmed: "medium", text_verbosity: "low" });
  });
  test("a captured effort that differs from the requested one fails that model's cells with no call", async () => {
    const { isolationCheck } = await import("./generate");
    const { out, ctx } = setup();
    const cx = fake("codex", [cxOk()]);
    writeFileSync(join(cx.d, "capture.body"), JSON.stringify({ model: "gpt-6-luna", tools: [], reasoning: { effort: "low" }, input: [] }));
    const r = await runGenerate({ models: ["openai/gpt-6-luna"], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
      isolation: (m) => isolationCheck(findRepoModel(m)!, { env: cx.env }), llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick }) });
    expect(r.failed).toBe(1);
    expect(cx.calls()).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "failed.json"), "utf8"))).toMatchObject({ reason: "access:isolation_failed" });
  });
});

test("generation.json records codex_catalog_base for a Codex cell", async () => {
  const { out, ctx } = setup();
  const cfg = findRepoModel("openai/gpt-6-luna")!;
  const cx = fake("codex", [['{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":' + JSON.stringify(fence(goodCR("L1"))) + "}}", '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5}}'].join("\n") + "\n"]);
  await runGenerate({ models: [cfg.id], scenarios: scenarios.slice(0, 1), samples: 1, out, contextDir: ctx, concurrency: 1, prompt: "v2", configFor: (m) => findRepoModel(m),
    llmFor: (m, sink) => llmForModel(findRepoModel(m)!, sink, { env: cx.env, ...quick }) });
  const g = JSON.parse(readFileSync(join(out, "generate", "L1-cx_openai_gpt-6-luna-v2-s1", "generation.json"), "utf8"));
  expect(g).toHaveProperty("codex_catalog_base", cfg.codex_catalog_base ?? null);
});
