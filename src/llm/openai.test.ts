import { describe, expect, test } from "bun:test";
import { callOpenAI } from "./openai";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const okBody = {
  model: "gpt-6-sol-2026-10-01",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: "part1 " }, { type: "output_text", text: "part2" }] },
  ],
  usage: { input_tokens: 120, output_tokens: 45, output_tokens_details: { reasoning_tokens: 30 } },
};

describe("callOpenAI", () => {
  test("returns concatenated text, usage, and exact model id", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await callOpenAI(
      { model: "gpt-6-sol", instructions: "sys", input: [{ role: "user", content: "hi" }] },
      { apiKey: "k", devAllowPaidApi: true, fetchImpl: fakeFetch(200, okBody, seen) },
    );
    expect(r.text).toBe("part1 part2");
    expect(r.model).toBe("gpt-6-sol-2026-10-01");
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 45, reasoning_tokens: 30 });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    const sent = JSON.parse(String(seen[0]!.init!.body));
    expect(sent).toEqual({ model: "gpt-6-sol", instructions: "sys", input: [{ role: "user", content: "hi" }] });
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  test("passes reasoning effort when given", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    await callOpenAI({ model: "m", input: "x", reasoningEffort: "low" }, { apiKey: "k", devAllowPaidApi: true, fetchImpl: fakeFetch(200, okBody, seen) });
    expect(JSON.parse(String(seen[0]!.init!.body)).reasoning).toEqual({ effort: "low" });
  });

  test("throws with status and body on HTTP error", async () => {
    await expect(
      callOpenAI({ model: "m", input: "x" }, { apiKey: "k", devAllowPaidApi: true, fetchImpl: fakeFetch(400, { error: { message: "bad model" } }), retries: 0 }),
    ).rejects.toThrow(/400.*bad model/);
  });

  test("retries 5xx then succeeds", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(okBody), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await callOpenAI({ model: "m", input: "x" }, { apiKey: "k", devAllowPaidApi: true, fetchImpl: f, retries: 2, backoffMs: 1 });
    expect(n).toBe(2);
    expect(r.text).toBe("part1 part2");
  });

  test("throws when no API key", async () => {
    await expect(callOpenAI({ model: "m", input: "x" }, { apiKey: "", devAllowPaidApi: true, fetchImpl: fakeFetch(200, okBody) })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  test("throws when response has no text", async () => {
    await expect(
      callOpenAI({ model: "m", input: "x" }, { apiKey: "k", devAllowPaidApi: true, fetchImpl: fakeFetch(200, { model: "m", output: [], usage: {} }) }),
    ).rejects.toThrow(/no output text/);
  });
});

test("does not retry 429 insufficient_quota", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    return new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }), { status: 429 });
  }) as unknown as typeof fetch;
  await expect(callOpenAI({ model: "m", input: "x" }, { apiKey: "k", devAllowPaidApi: true, fetchImpl: f, retries: 3, backoffMs: 1 })).rejects.toThrow(/insufficient_quota/);
  expect(n).toBe(1);
});

import { analystCall } from "./analyst";
import { backendCall } from "./auditor";
test("L2: the direct (paid) OpenAI API refuses without the explicit dev flag, before any request; analyst and auditor openai: backends too", async () => {
  let fetched = 0;
  const fetchImpl = (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch;
  const prev = process.env.PGAIBENCH_DEV_OPENAI_API;
  delete process.env.PGAIBENCH_DEV_OPENAI_API;
  try {
    await expect(callOpenAI({ model: "m", input: "x" }, { apiKey: "k", fetchImpl })).rejects.toMatchObject({ reason: "access:forbidden" });
    await expect((await analystCall("openai:gpt-x"))("i", [{ role: "user", content: "q" }])).rejects.toMatchObject({ reason: "access:forbidden" });
    await expect(backendCall({ provider: "openai", model: "m" })("p")).rejects.toMatchObject({ reason: "access:forbidden" });
    expect(fetched).toBe(0);
  } finally { if (prev !== undefined) process.env.PGAIBENCH_DEV_OPENAI_API = prev; }
});
