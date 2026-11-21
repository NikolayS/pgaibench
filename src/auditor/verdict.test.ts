import { expect, test } from "bun:test";
import { parseVerdict, reviewCR } from "./verdict";

const ok = { verdict: "request_changes", risks: [{ what: "lock", where: 1, why: "queue", severity: "high" }], required_changes: ["add lock_timeout"], confidence: "high", summary: "s" };

test("parseVerdict accepts the strict shape in a fence", () => {
  const r = parseVerdict("thinking\n```json\n" + JSON.stringify(ok) + "\n```");
  expect(r.ok && r.value.verdict).toBe("request_changes");
});

test("parseVerdict rejects bad verdicts, extra keys, empty required_changes", () => {
  expect(parseVerdict(JSON.stringify({ ...ok, verdict: "maybe" })).ok).toBe(false);
  expect(parseVerdict(JSON.stringify({ ...ok, extra: 1 })).ok).toBe(false);
  expect(parseVerdict(JSON.stringify({ ...ok, required_changes: [] })).ok).toBe(false);
  expect(parseVerdict(JSON.stringify({ ...ok, verdict: "approve", required_changes: [], risks: [{ ...ok.risks[0], where: null }] })).ok).toBe(true);
  expect(parseVerdict("no json").ok).toBe(false);
});

const res = (text: string, outcome = "ok") => ({ text, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 1, outcome });

test("reviewCR: one repair turn, then invalid", async () => {
  const calls: unknown[] = [];
  const llm = async (_i: string, input: unknown[]) => { calls.push(input); return res(calls.length === 1 ? "bad" : "```json\n" + JSON.stringify(ok) + "\n```") as never; };
  const r = await reviewCR({ llm, system: "S", user: "U" });
  expect(r.status).toBe("verdict");
  expect(r.repairRounds).toBe(1);
  expect((calls[1] as { content: string }[]).length).toBe(3);
  const bad = await reviewCR({ llm: async () => res("bad") as never, system: "S", user: "U" });
  expect(bad.status).toBe("no_verdict");
  expect(bad.repairRounds).toBe(1);
});

test("reviewCR: truncated or empty is retried once, then no_verdict", async () => {
  let n = 0;
  const r = await reviewCR({ llm: async () => { n++; return res("", "truncated") as never; }, system: "S", user: "U" });
  expect([r.status, r.invalid_reason, n]).toEqual(["no_verdict", "truncated", 2]);
  let m = 0;
  const ok2 = await reviewCR({ llm: async () => { m++; return (m === 1 ? res("", "empty") : res("```json\n" + JSON.stringify(ok) + "\n```")) as never; }, system: "S", user: "U" });
  expect([ok2.status, m, ok2.retries]).toEqual(["verdict", 2, 1]);
});

test("reviewCR: a thrown provider error is retried once, then no_verdict", async () => {
  let n = 0;
  const r = await reviewCR({ llm: async () => { n++; throw new Error("HTTP 502"); }, system: "S", user: "U" });
  expect([r.status, r.invalid_reason, n]).toEqual(["no_verdict", "provider_error", 2]);
});
