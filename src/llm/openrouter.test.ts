import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOpenRouter, loadModels, modelConfigSchema, modelSlug, pinMatches, requiredAccess, vendorOf, type ModelConfig } from "./openrouter";
import { analystCall, parseAnalystBackend } from "./analyst";

// Local fake OpenRouter; tests never call the network.
type Handler = (body: any, req: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response("unset", { status: 500 });
const seen: { body: any; auth: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) { const body = await req.json(); seen.push({ body, auth: req.headers.get("authorization") }); return handler(body, req); } });
  baseUrl = `http://localhost:${server.port}/api/v1`;
});
afterAll(() => server.stop(true));

const ok = (content: unknown, extra: Record<string, unknown> = {}) => Response.json({
  id: "gen-1", model: "deepseek/deepseek-v4-pro-0813", provider: "DeepInfra",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042, completion_tokens_details: { reasoning_tokens: 7 } }, ...extra,
});
const KEY = "sk-or-test-secret";
const pinned: ModelConfig = { id: "deepseek/deepseek-v4-pro-0813", vendor: "DeepSeek", tier: "large", open_weights: true,
  provider: { order: ["DeepInfra"], allow_fallbacks: false }, reasoning: { effort: "high" } };
const base = { apiKey: KEY, get baseUrl() { return baseUrl; }, backoffMs: 1, sleep: async () => {}, random: () => 0 };
const req = { model: pinned.id, instructions: "sys", input: [{ role: "user" as const, content: "hi" }] };

describe("callOpenRouter", () => {
  test("sends chat request with provider pin, reasoning and usage accounting; records provider, model, usage, cost, raw", async () => {
    seen.length = 0;
    handler = () => ok("hello");
    const r = await callOpenRouter(req, { ...base, config: pinned });
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toEqual({
      model: pinned.id, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      max_tokens: 32000, usage: { include: true }, provider: { order: ["DeepInfra"], allow_fallbacks: false }, reasoning: { effort: "high" },
    });
    expect(r).toMatchObject({ outcome: "ok", text: "hello", model: "deepseek/deepseek-v4-pro-0813", provider: "DeepInfra", usd: 0.00042,
      usage: { input_tokens: 120, output_tokens: 30, reasoning_tokens: 7 } });
    expect((r.raw as any).id).toBe("gen-1");
  });

  test("no provider or reasoning keys when the config leaves them null", async () => {
    seen.length = 0;
    handler = () => ok("x");
    await callOpenRouter(req, { ...base, config: { ...pinned, provider: null, reasoning: null } });
    expect(seen[0]!.body.provider).toBeUndefined();
    expect(seen[0]!.body.reasoning).toBeUndefined();
  });

  test("retries 429 and 5xx with exponential backoff, then succeeds", async () => {
    let n = 0; const sleeps: number[] = [];
    handler = () => (++n === 1 ? new Response("rate", { status: 429 }) : n === 2 ? new Response("bad gw", { status: 502 }) : ok("fine"));
    const r = await callOpenRouter(req, { ...base, backoffMs: 100, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.text).toBe("fine");
    expect(sleeps).toEqual([100, 200]);
  });

  test("bounded retries: gives up with an error that does not contain the key", async () => {
    handler = () => new Response(`overloaded ${KEY}`, { status: 503 });
    const e = await callOpenRouter(req, { ...base, maxRetries: 2 }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("HTTP 503");
    expect(e.message).not.toContain(KEY);
  });

  test("total retry budget stops before the retry count", async () => {
    let n = 0;
    handler = () => { n++; return new Response("x", { status: 500 }); };
    await expect(callOpenRouter(req, { ...base, maxRetries: 10, backoffMs: 1000, budgetMs: 2500, sleep: async () => {} })).rejects.toThrow(/budget/);
    expect(n).toBe(2); // 1000 then 2000 would pass 2500
  });

  test("4xx other than 429 is not retried", async () => {
    let n = 0;
    handler = () => { n++; return new Response("bad model", { status: 400 }); };
    await expect(callOpenRouter(req, base)).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });

  test("per-call timeout is enforced and retried", async () => {
    let n = 0;
    handler = async () => { if (++n === 1) await Bun.sleep(300); return ok("late ok"); };
    const r = await callOpenRouter(req, { ...base, timeoutMs: 50 });
    expect(r.text).toBe("late ok");
    expect(n).toBe(2);
  });

  test("reasoning with empty final content is the model outcome empty (no retry)", async () => {
    let n = 0;
    handler = () => { n++; return Response.json({ model: "m", provider: "P", choices: [{ finish_reason: "stop", message: { content: null, reasoning: "thinking..." } }], usage: { cost: 0.1, completion_tokens: 50 } }); };
    expect(await callOpenRouter(req, base)).toMatchObject({ outcome: "empty", text: "" });
    expect(n).toBe(1);
  });

  test("empty content with no reasoning and no tokens is a transport fault: retried, then thrown", async () => {
    let n = 0;
    handler = () => { n++; return ok(""); };
    handler = () => { n++; return Response.json({ model: "m", choices: [{ finish_reason: "stop", message: { content: "" } }], usage: { completion_tokens: 0 } }); };
    await expect(callOpenRouter(req, { ...base, maxRetries: 2 })).rejects.toThrow(/empty/);
    expect(n).toBe(3);
  });

  test("refusal field is refusal; content_filter is its own outcome", async () => {
    handler = () => Response.json({ model: "m", provider: "P", choices: [{ finish_reason: "stop", message: { content: null, refusal: "I cannot help" } }], usage: {} });
    expect(await callOpenRouter(req, base)).toMatchObject({ outcome: "refusal", text: "I cannot help" });
    handler = () => Response.json({ model: "m", choices: [{ finish_reason: "content_filter", message: { content: "" } }] });
    expect(await callOpenRouter(req, base)).toMatchObject({ outcome: "content_filter" });
  });

  test("200 with error object, empty choices, or non-JSON is a transport fault: retried in budget, then thrown", async () => {
    let n = 0;
    handler = () => (++n === 1 ? Response.json({ error: { code: 502, message: "upstream" }, usage: { cost: 0.01 } }) : n === 2 ? Response.json({ choices: [] }) : ok("fine"));
    const r = await callOpenRouter(req, base);
    expect(r.text).toBe("fine");
    expect(n).toBe(3);
    expect(r.usd).toBeCloseTo(0.01042);
    handler = () => new Response("{not json", { status: 200 });
    const e = await callOpenRouter(req, { ...base, maxRetries: 1 }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/malformed/);
  });

  test("content as an array of parts: text parts joined", async () => {
    handler = () => ok([{ type: "text", text: "a" }, { type: "image_url", image_url: {} }, { type: "text", text: "b" }]);
    expect(await callOpenRouter(req, base)).toMatchObject({ outcome: "ok", text: "ab" });
  });

  test("onAttempt: reported cost, token estimate when cost is missing, pessimistic estimate on timeout", async () => {
    const cfg = { ...pinned, provider: null, price_in: 1, price_out: 10, max_tokens: 1000 };
    const seenA: { usd: number; source: string; attempt: number }[] = [];
    handler = () => ok("x");
    await callOpenRouter(req, { ...base, config: cfg, onAttempt: (a) => seenA.push(a) });
    expect(seenA).toEqual([{ attempt: 1, usd: 0.00042, source: "reported" }]);
    seenA.length = 0;
    handler = () => Response.json({ model: "m", choices: [{ finish_reason: "stop", message: { content: "x" } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    const r = await callOpenRouter(req, { ...base, config: cfg, onAttempt: (a) => seenA.push(a) });
    expect(seenA[0]).toMatchObject({ source: "estimated" });
    expect(seenA[0]!.usd).toBeCloseTo((1000 * 1 + 100 * 10) / 1e6);
    expect(r.usd).toBeCloseTo(0.002);
    expect(r.usd_source).toBe("estimated");
    seenA.length = 0;
    let n = 0;
    handler = async () => { if (++n === 1) await Bun.sleep(300); return ok("late"); };
    await callOpenRouter(req, { ...base, config: cfg, timeoutMs: 50, onAttempt: (a) => seenA.push(a) });
    expect(seenA[0]!.source).toBe("estimated");
    expect(seenA[0]!.usd).toBeGreaterThanOrEqual(1000 * 10 / 1e6);
    expect(seenA[1]).toMatchObject({ attempt: 2, source: "reported" });
  });

  test("provider pin mismatch throws provider_mismatch with the spend", async () => {
    handler = () => ok("x", { provider: "SomeOtherProvider" });
    const e = await callOpenRouter(req, { ...base, config: pinned }).catch((x) => x as Error & { reason?: string; usd?: number });
    expect(e.reason).toBe("provider_mismatch");
    expect(e.usd).toBeCloseTo(0.00042);
    handler = () => ok("x", { provider: "deepinfra" });
    expect((await callOpenRouter(req, { ...base, config: pinned })).outcome).toBe("ok");
  });

  test("max_tokens from the model config", async () => {
    seen.length = 0;
    handler = () => ok("x");
    await callOpenRouter(req, { ...base, config: { ...pinned, max_tokens: 4096 } });
    expect(seen[0]!.body.max_tokens).toBe(4096);
  });

  test("Retry-After is honoured and jitter is added", async () => {
    let n = 0; const sleeps: number[] = [];
    handler = () => (++n === 1 ? new Response("rate", { status: 429, headers: { "retry-after": "3" } }) : ok("ok"));
    await callOpenRouter(req, { ...base, backoffMs: 100, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps[0]).toBe(3000 + 0.5 * 0.25 * 3000);
  });

  test("finish_reason length is classified as truncated", async () => {
    handler = () => Response.json({ model: "m", choices: [{ finish_reason: "length", message: { content: "```json\n{\"id\":" } }], usage: { cost: 0.3 } });
    expect(await callOpenRouter(req, base)).toMatchObject({ outcome: "truncated", usd: 0.3 });
  });

  test("cost reported on non-2xx bodies is added to the result, or to the thrown error", async () => {
    let n = 0;
    handler = () => (++n === 1 ? Response.json({ error: { message: "upstream" }, usage: { cost: 0.01 } }, { status: 502 }) : ok("fine"));
    expect((await callOpenRouter(req, base)).usd).toBeCloseTo(0.01042);
    handler = () => Response.json({ error: { message: "bad" }, usage: { cost: 0.02 } }, { status: 400 });
    const e = await callOpenRouter(req, base).catch((x) => x as Error & { usd?: number });
    expect(e.usd).toBeCloseTo(0.02);
  });

  test("missing key throws before any request", async () => {
    await expect(callOpenRouter(req, { baseUrl, apiKey: "" })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("models.json", () => {
  test("repo models.json parses and lists the PLAN candidates", () => {
    const ms = loadModels().filter((m) => !m.id.includes(":")); // effort-level rows: configurations of a listed model
    expect(ms.length).toBe(19);
    expect(ms.filter((m) => m.open_weights).length).toBe(6);
    for (const m of ms) {
      expect(m.default_effort).toBeDefined();
      if (m.open_weights) expect(m.provider).toMatchObject({ allow_fallbacks: false });
      else expect(m.open_weights).toBe(false);
    }
    expect(ms.find((m) => m.id === "deepseek/deepseek-v4.1-flash-1017")).toMatchObject({ provider: { order: ["deepinfra/fp8"] }, default_effort: "high" });
    expect(ms.find((m) => m.id === "z-ai/glm-5.3")!.default_effort).toBe("max");
    expect(ms.find((m) => m.id === "anthropic/claude-opus-5.5")).toMatchObject({ vendor: "Anthropic", tier: "large" });
    expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
  });
  test("every model has prices (pinned provider, docs/research.md) and max_tokens within the snapshot limit", () => {
    const snap = JSON.parse(require("node:fs").readFileSync(join(import.meta.dir, "..", "..", "docs", "openrouter-models-2026-11-09.json"), "utf8"));
    const lim = new Map<string, number>((snap.data ?? snap).map((m: any) => [m.id, m.top_provider?.max_completion_tokens]));
    for (const m of loadModels()) {
      expect(m.price_in).toBeGreaterThan(0);
      expect(m.price_out).toBeGreaterThan(0);
      if (m.access === "agy-cli") { expect(m.max_tokens).toBeUndefined(); continue; } // the CLI has no output-length setting
      expect(m.max_tokens).toBeLessThanOrEqual(lim.get(m.id) ?? 32000);
    }
    expect(loadModels().find((m) => m.id === "deepseek/deepseek-v4-pro-0813")).toMatchObject({ price_in: 1.3, price_out: 2.6 });
  });
  test("rejects a provider pin that allows fallbacks", () => {
    const d = mkdtempSync(join(tmpdir(), "models-"));
    writeFileSync(join(d, "m.json"), JSON.stringify([{ ...pinned, provider: { order: ["X"], allow_fallbacks: true } }]));
    expect(() => loadModels(join(d, "m.json"))).toThrow();
  });
  test("slug is path safe", () => {
    expect(modelSlug("deepseek/deepseek-v4-pro-0813")).toBe("deepseek_deepseek-v4-pro-0813");
    expect(modelSlug("a/b:free")).toBe("a_b_free");
  });
});

describe("analyst backend", () => {
  test("openrouter:<id> parses and calls through the adapter", async () => {
    expect(parseAnalystBackend("openrouter:x-ai/grok-4.7")).toEqual({ provider: "openrouter", model: "x-ai/grok-4.7" });
    handler = () => ok("via backend", { provider: "xAI" });
    const llm = await analystCall("openrouter:x-ai/grok-4.7", { openrouter: { apiKey: KEY, baseUrl } });
    const r = await llm("sys", [{ role: "user", content: "q" }]);
    expect(r).toMatchObject({ text: "via backend", provider: "xAI", usd: 0.00042 });
  });
});

describe("access paths (subscription rule)", () => {
  const write = (ms: unknown[]) => { const d = mkdtempSync(join(tmpdir(), "models-")); writeFileSync(join(d, "m.json"), JSON.stringify(ms)); return join(d, "m.json"); };
  const or = { id: "x-ai/grok-4.7", vendor: "xAI", tier: "large", open_weights: false, provider: { order: ["xai"], allow_fallbacks: false }, reasoning: null, access: "openrouter" };
  const cx = { id: "openai/gpt-6-luna", vendor: "OpenAI", tier: "small", open_weights: false, provider: null, reasoning: null, access: "codex-cli", cli_model: "gpt-6-luna", effort: "medium", default_effort: "medium" };
  const cc = { id: "anthropic/claude-haiku-5.5", vendor: "Anthropic", tier: "small", open_weights: false, provider: null, reasoning: null, access: "claude-cli", cli_model: "claude-haiku-5-5", effort: "medium", default_effort: "medium" };
  test("valid mixed list loads", () => {
    expect(loadModels(write([or, cx, cc])).map((m) => m.access)).toEqual(["openrouter", "codex-cli", "claude-cli"]);
  });
  test("openai/* must be codex-cli, anthropic/* must be claude-cli", () => {
    expect(() => loadModels(write([{ ...cx, access: "openrouter", cli_model: undefined, effort: undefined }]))).toThrow(/openai\/gpt-6-luna.*codex-cli/);
    expect(() => loadModels(write([{ ...cc, access: "codex-cli" }]))).toThrow(/claude-cli/);
    expect(() => loadModels(write([{ ...or, access: "claude-cli", cli_model: "x", effort: "high" }]))).toThrow(/openrouter/);
  });
  test("access is required; CLI models need cli_model and effort; effort equals default_effort", () => {
    const { access: _a, ...noAccess } = or;
    expect(() => loadModels(write([noAccess]))).toThrow();
    expect(() => loadModels(write([{ ...cx, cli_model: undefined }]))).toThrow(/cli_model/);
    expect(() => loadModels(write([{ ...cc, effort: undefined }]))).toThrow(/effort/);
    expect(() => loadModels(write([{ ...cc, effort: "high" }]))).toThrow(/default_effort/);
  });
  test("repo models.json: effort-level rows (as run in the lab) copy their base row except id, effort and default_effort", () => {
    const ms = loadModels(), lv = ms.filter((m) => m.id.includes(":"));
    for (const m of lv) {
      const [b, e] = m.id.split(":") as [string, string], base = ms.find((x) => x.id === b)!;
      expect(base, m.id).toBeDefined();
      expect(m.effort).toBe(e);
      const { id: _i, effort: _e, default_effort: _d, ...rest } = m as any, { id: _bi, effort: _be, default_effort: _bd, ...brest } = base as any;
      expect(rest, m.id).toEqual(brest);
    }
  });
  test("repo models.json: OpenAI on codex-cli, Anthropic on claude-cli at vendor default effort, every OpenRouter model pinned without fallbacks", () => {
    for (const m of loadModels().filter((x) => !x.id.includes(":"))) {
      if (m.id.startsWith("openai/")) expect(m).toMatchObject({ access: "codex-cli", effort: "medium", cli_model: m.id.slice(7) });
      else if (m.id.startsWith("anthropic/")) { expect(m.access).toBe("claude-cli"); expect(m.effort).toBe(m.default_effort!); expect(m.cli_model).toBe(m.id.slice(10).replace(/\./g, "-")); }
      else if (m.id.endsWith("@agy")) { expect(m.access).toBe("agy-cli"); expect(m.effort).toBe(m.default_effort!); }
      else { expect(m.access).toBe("openrouter"); expect(m.provider).toMatchObject({ allow_fallbacks: false }); }
    }
    const f = (id: string) => loadModels().find((m) => m.id === id)!;
    expect(f("anthropic/claude-opus-5.5").effort).toBe("high");
    expect(f("google/gemini-4-argon").provider!.order).toEqual(["google-vertex"]);
    expect(f("x-ai/grok-4.7").provider!.order).toEqual(["xai"]);
    expect(f("deepseek/deepseek-v4-pro-0813")).toMatchObject({ provider: { order: ["deepinfra/fp8"] }, quantization: "fp8", price_in: 1.3, price_out: 2.6 });
    expect(f("deepseek/deepseek-v4.1-flash-1017")).toMatchObject({ provider: { order: ["deepinfra/fp8"] }, quantization: "fp8", price_in: 0.098, price_out: 0.294 });
  });
  test("callOpenRouter refuses openai/ and anthropic/ ids before any network call", async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch;
    for (const model of ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "OpenAI/x"])
      await expect(callOpenRouter({ model, input: [{ role: "user", content: "q" }] }, { apiKey: KEY, fetchImpl })).rejects.toThrow(/subscription/);
    expect(fetched).toBe(0);
  });
  test("L1: the guard parses the vendor: ~alias, spaces, case and router ids are refused before any network call", async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch;
    for (const model of ["~anthropic/claude-haiku-latest", " openai/gpt-6-luna", "~OpenAI/x", "openrouter/auto", "openrouter/free", "~openrouter/auto"])
      await expect(callOpenRouter({ model, input: [{ role: "user", content: "q" }] }, { apiKey: KEY, fetchImpl })).rejects.toMatchObject({ reason: "access:forbidden" });
    expect(fetched).toBe(0);
    expect(vendorOf("~Anthropic/claude-x")).toBe("anthropic");
    expect(requiredAccess("~anthropic/claude-x")).toBe("claude-cli");
    expect(requiredAccess("~openai/x")).toBe("codex-cli");
  });
  test("L1: a config whose vendor field names OpenAI or Anthropic is refused even under another id; the schema pairs vendor and id", async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(callOpenRouter({ model: "x/alias", input: [{ role: "user", content: "q" }] }, { apiKey: KEY, fetchImpl, config: { ...pinned, id: "x/alias", vendor: "Anthropic" } })).rejects.toMatchObject({ reason: "access:forbidden" });
    expect(fetched).toBe(0);
    const base = { tier: "small", open_weights: false, provider: null, access: "openrouter" };
    expect(modelConfigSchema.safeParse({ ...base, id: "x/alias", vendor: "OpenAI" }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ ...base, id: "openrouter/auto", vendor: "OpenRouter" }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ ...base, id: "x/m", vendor: "X" }).success).toBe(true);
  });
  test("pin match is exact (after case and punctuation), never a prefix", () => {
    expect(pinMatches("deepinfra/fp8", "DeepInfra")).toBe(true);
    expect(pinMatches("google-vertex", "Google")).toBe(true);
    expect(pinMatches("xai", "xAI")).toBe(true);
    expect(pinMatches("z-ai", "Z.AI")).toBe(true);
    expect(pinMatches("moonshotai", "Moonshot AI")).toBe(true);
    for (const served of ["Deep", "D", "Google AI Studio", "DeepInfra Turbo", "Goo", ""]) expect([served, pinMatches(served === "Goo" || served === "Google AI Studio" ? "google-vertex" : "deepinfra", served)]).toEqual([served, false]);
  });
  test("a quantization pin is sent as provider.quantizations; a served quantization that differs fails the call, none reported is recorded as null", async () => {
    const q: ModelConfig = { ...pinned, provider: { order: ["deepinfra/fp8"], allow_fallbacks: false }, quantization: "fp8" };
    seen.length = 0;
    handler = () => ok("x");
    const r = await callOpenRouter(req, { ...base, config: q });
    expect((seen[0]!.body as any).provider).toEqual({ order: ["deepinfra/fp8"], allow_fallbacks: false, quantizations: ["fp8"] });
    expect(r).toMatchObject({ quantization_requested: "fp8", quantization_served: null });
    handler = () => ok("x", { quantization: "fp8" });
    expect(await callOpenRouter(req, { ...base, config: q })).toMatchObject({ quantization_served: "fp8" });
    handler = () => ok("x", { quantization: "fp4" });
    await expect(callOpenRouter(req, { ...base, config: q })).rejects.toMatchObject({ reason: "quantization_mismatch" });
  });
  test("a pin with a variant tag (deepinfra/fp8) or a slug (google-vertex) matches the served provider name", async () => {
    handler = () => ok("x");
    await expect(callOpenRouter(req, { ...base, config: { ...pinned, provider: { order: ["deepinfra/fp8"], allow_fallbacks: false } } })).resolves.toMatchObject({ provider: "DeepInfra" });
    handler = () => ok("x", { provider: "Google" });
    await expect(callOpenRouter(req, { ...base, config: { ...pinned, provider: { order: ["google-vertex"], allow_fallbacks: false } } })).resolves.toMatchObject({ provider: "Google" });
    handler = () => ok("x", { provider: "Google AI Studio" });
    await expect(callOpenRouter(req, { ...base, config: { ...pinned, provider: { order: ["google-vertex"], allow_fallbacks: false } } })).rejects.toThrow(/provider_mismatch/);
  });
});

test("N2: codex_catalog_base is for codex-cli only; models.json gives gpt-6.1-terra the gpt-6.1-sol entry", () => {
  const { modelConfigSchema, loadModels } = require("./openrouter");
  const cli = { id: "openai/x", vendor: "OpenAI", tier: "mid", open_weights: false, provider: null, access: "codex-cli", cli_model: "x", effort: "medium" };
  expect(modelConfigSchema.safeParse({ ...cli, codex_catalog_base: "gpt-6.1-sol" }).success).toBe(true);
  expect(modelConfigSchema.safeParse({ ...cli, id: "anthropic/x", vendor: "Anthropic", access: "claude-cli", codex_catalog_base: "gpt-6.1-sol" }).success).toBe(false);
  expect(loadModels().find((m: any) => m.id === "openai/gpt-6.1-terra").codex_catalog_base).toBe("gpt-6.1-sol");
});
