// OpenRouter chat completions client (OpenAI-compatible, plain fetch).
// Key from OPENROUTER_API_KEY; never logged, never written to disk.
// Model outcomes (ok, empty with reasoning, refusal, content_filter,
// truncated) are returned as a classified result. Transport faults (HTTP
// 429/5xx, network, timeout, a 200 with an error object, no choices, a body
// that is not a chat completion, empty content with no reasoning) are
// retried inside one budget, then thrown. Spend of every attempt goes to
// onAttempt (reported usage.cost, or an estimate from models.json prices)
// and is summed into .usd of the result or of the thrown error.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InputMessage, LLMResult } from "./openai";

const EFFORT = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
/** Every call: enough for max-effort reasoning; finish_reason length is "truncated". */
export const MAX_TOKENS = 32000;

export const ACCESS = ["openrouter", "codex-cli", "claude-cli"] as const;
export type Access = (typeof ACCESS)[number];
/** The owner's rule: OpenAI and Anthropic models run on the subscriptions, never on a paid router. */
export const SUBSCRIPTION_VENDOR = /^(openai|anthropic)\//i;
/** L1: the vendor part of a model id, parsed: trimmed, lower case, OpenRouter's "~" alias mark removed. */
export const vendorOf = (id: string) => id.trim().replace(/^~/, "").split("/")[0]!.toLowerCase();
export function requiredAccess(id: string): Access {
  const v = vendorOf(id);
  return v === "openai" ? "codex-cli" : v === "anthropic" ? "claude-cli" : "openrouter";
}
/** L1: ids that must never reach OpenRouter: subscription vendors, and
 *  router ids (openrouter/*) that can resolve to any model, those included. */
export function forbiddenOnOpenRouter(id: string, vendorField?: string): string | undefined {
  const v = vendorOf(id), f = vendorField?.trim().toLowerCase();
  if (v === "openai" || v === "anthropic") return `${id} runs on the subscription CLI (access ${requiredAccess(id)}), never through OpenRouter`;
  if (v === "openrouter") return `${id} is an OpenRouter router id that may resolve to an OpenAI or Anthropic model; refused`;
  if (f === "openai" || f === "anthropic") return `${id} has vendor ${vendorField}: subscription vendors never run through OpenRouter`;
  return undefined;
}

export const modelConfigSchema = z.object({
  id: z.string().min(1),
  vendor: z.string().min(1),
  tier: z.enum(["small", "mid", "large"]),
  open_weights: z.boolean().nullable(),
  provider: z.object({ order: z.array(z.string().min(1)).min(1), allow_fallbacks: z.literal(false) }).strict().nullable(),
  reasoning: z.object({ effort: EFFORT.optional(), max_tokens: z.number().int().positive().optional() }).strict().nullable().optional(),
  /** Vendor default effort as documented (docs/research.md); null reasoning sends no parameter. */
  default_effort: EFFORT.optional(),
  /** USD per million tokens at the pinned provider (docs/research.md). */
  price_in: z.number().nonnegative().optional(),
  price_out: z.number().nonnegative().optional(),
  /** Per-call max_tokens (default MAX_TOKENS). */
  max_tokens: z.number().int().positive().optional(),
  /** Access path: OpenAI models only through the Codex CLI, Anthropic models
   *  only through the Claude Code CLI (subscription logins); others through OpenRouter. */
  access: z.enum(ACCESS),
  /** CLI model id (codex -m / claude --model); CLI access only. */
  cli_model: z.string().min(1).optional(),
  /** Reasoning effort the CLI is told to use; CLI access only, equal to default_effort. */
  effort: EFFORT.optional(),
  /** Weight quantization at the pinned provider, when it is not the vendor's own. */
  quantization: z.string().min(1).optional(),
  /** N2: codex-cli only. Bundled catalog entry whose patched copy is used
   *  for cli_model when the CLI's catalog has no entry for it. */
  codex_catalog_base: z.string().min(1).optional(),
}).strict().superRefine((m, ctx) => {
  const want = requiredAccess(m.id), vf = m.vendor.trim().toLowerCase();
  if (vendorOf(m.id) === "openrouter") ctx.addIssue({ code: "custom", message: `${m.id}: router ids are not allowed (they can resolve to any model)` });
  if ((vf === "openai" || vf === "anthropic" || want !== "openrouter") && vf !== vendorOf(m.id)) ctx.addIssue({ code: "custom", message: `${m.id}: vendor ${m.vendor} does not match the id's vendor ${vendorOf(m.id)}` });
  if (m.access !== want) ctx.addIssue({ code: "custom", message: `${m.id}: access must be ${want} (got ${m.access})` });
  if (m.access !== "openrouter") {
    if (!m.cli_model) ctx.addIssue({ code: "custom", message: `${m.id}: ${m.access} needs cli_model` });
    if (!m.effort) ctx.addIssue({ code: "custom", message: `${m.id}: ${m.access} needs effort` });
    else if (m.default_effort && m.effort !== m.default_effort) ctx.addIssue({ code: "custom", message: `${m.id}: effort ${m.effort} differs from default_effort ${m.default_effort}` });
  }
  if (m.codex_catalog_base && m.access !== "codex-cli") ctx.addIssue({ code: "custom", message: `${m.id}: codex_catalog_base is for codex-cli only` });
  if (m.access === "openrouter" && (m.cli_model || m.effort)) ctx.addIssue({ code: "custom", message: `${m.id}: cli_model and effort are for CLI access only` });
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const MODELS_PATH = join(import.meta.dir, "..", "..", "models.json");

export function loadModels(path = MODELS_PATH): ModelConfig[] {
  return z.array(modelConfigSchema).parse(JSON.parse(readFileSync(path, "utf8")));
}

export function findModel(id: string, path = MODELS_PATH): ModelConfig | undefined {
  return loadModels(path).find((m) => m.id === id);
}

export function findModelBySlug(slug: string, path = MODELS_PATH): ModelConfig | undefined {
  return loadModels(path).find((m) => modelSlug(m.id) === slug);
}

/** Path-safe form of a model id, for directory and arm names. */
export const modelSlug = (id: string) => id.replace(/[/:]/g, "_");

export type OpenRouterOutcome = "ok" | "empty" | "refusal" | "content_filter" | "truncated";
export type UsdSource = "reported" | "estimated";
export interface OpenRouterResult extends LLMResult { outcome: OpenRouterOutcome; provider: string | null; raw: unknown; attempts: number; usd_source?: UsdSource;
  /** models.json quantization (sent as provider.quantizations) and what the response reports (null: not reported). */
  quantization_requested?: string; quantization_served?: string | null }
/** Default retries after the first attempt; one call is at most this + 1 attempts. */
export const OPENROUTER_MAX_RETRIES = 5;
export interface AttemptSpend { attempt: number; usd: number; source: UsdSource }

/** Prompt tokens, pessimistic (3 chars per token). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);
/** USD of a call; prices are per million tokens. */
export function priceUsd(config: ModelConfig | undefined, inTok: number, outTok: number): number {
  if (config?.price_in === undefined || config.price_out === undefined) throw new Error(`no price_in/price_out for ${config?.id ?? "model"} in models.json`);
  return (inTok * config.price_in + outTok * config.price_out) / 1e6;
}
const norm = (p: string) => p.toLowerCase().replace(/[^a-z0-9]/g, "");
/** A pin entry is a provider slug, optionally with a variant tag (deepinfra/fp8);
 *  the response names the provider by its display name. The match is
 *  exact after case and punctuation are removed ("DeepInfra" = deepinfra,
 *  "Z.AI" = z-ai), plus the slugs whose display name differs (OpenRouter
 *  endpoints API: google-vertex is "Google"). Never a prefix. */
export const PROVIDER_DISPLAY: Record<string, string> = { "google-vertex": "Google" };
export const pinMatches = (pin: string, served: string) => {
  const slug = pin.split("/")[0]!, s = norm(served);
  return !!s && (norm(slug) === s || (PROVIDER_DISPLAY[slug] !== undefined && norm(PROVIDER_DISPLAY[slug]!) === s));
};

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  config?: ModelConfig;
  fetchImpl?: typeof fetch;
  /** Retries after the first attempt (429, 5xx, network error, timeout). */
  maxRetries?: number;
  backoffMs?: number;
  /** Upper bound on the summed backoff sleeps. */
  budgetMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1) (default Math.random); wait += 25% x random x wait. */
  random?: () => number;
  /** Called right after every attempt returns or aborts, with its spend. */
  onAttempt?: (a: AttemptSpend) => void;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export async function callOpenRouter(req: { model: string; instructions?: string; input: InputMessage[] }, opts: OpenRouterOptions = {}): Promise<OpenRouterResult> {
  const forbidden = forbiddenOnOpenRouter(req.model, opts.config?.vendor) ?? (opts.config && opts.config.id !== req.model ? forbiddenOnOpenRouter(opts.config.id) : undefined);
  if (forbidden) throw Object.assign(new Error(forbidden), { reason: "access:forbidden" });
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const f = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? OPENROUTER_MAX_RETRIES, backoff = opts.backoffMs ?? 2000, budget = opts.budgetMs ?? 300_000;
  const sleep = opts.sleep ?? Bun.sleep;
  const messages = [
    ...(req.instructions !== undefined ? [{ role: "system", content: req.instructions }] : []),
    ...req.input.map((m) => ({ role: m.role === "developer" ? "system" : m.role, content: m.content })),
  ];
  const maxTokens = opts.config?.max_tokens ?? MAX_TOKENS;
  const body: Record<string, unknown> = { model: req.model, messages, max_tokens: maxTokens, usage: { include: true } };
  if (opts.config?.provider) body.provider = { ...opts.config.provider, ...(opts.config.quantization ? { quantizations: [opts.config.quantization] } : {}) };
  if (opts.config?.reasoning) body.reasoning = opts.config.reasoning;
  const promptTok = estimateTokens(JSON.stringify(messages).length);
  const random = opts.random ?? Math.random;

  let slept = 0, spent = 0, estimated = false;
  const charge = (attempt: number, usd: number, source: UsdSource) => {
    spent += usd; if (source === "estimated") estimated = true;
    opts.onAttempt?.({ attempt, usd, source });
  };
  // Without prices (no models.json entry) estimates are 0; generate refuses a cap without prices.
  const est = (i: number, o: number) => opts.config?.price_in !== undefined && opts.config.price_out !== undefined ? priceUsd(opts.config, i, o) : 0;
  const reportedCost = (j: any): number | undefined => typeof j?.usage?.cost === "number" ? j.usage.cost : undefined;
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let status = 0, raw = "", why = "", retryAfterMs = 0;
    try {
      const res = await f(`${opts.baseUrl ?? DEFAULT_BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
      });
      status = res.status;
      const ra = Number(res.headers.get("retry-after"));
      if (ra > 0) retryAfterMs = ra * 1000;
      raw = await res.text();
      let j: any;
      try { j = JSON.parse(raw); } catch { j = undefined; }
      const cost = reportedCost(j);
      if (res.ok) {
        const c = classify(j, raw, req.model, Math.round(performance.now() - t0), attempt + 1);
        if (cost !== undefined) charge(attempt + 1, cost, "reported");
        else if (j?.usage && typeof j.usage.prompt_tokens === "number") charge(attempt + 1, est(j.usage.prompt_tokens, j.usage.completion_tokens ?? 0), "estimated");
        else if ("fault" in c) charge(attempt + 1, 0, "reported");
        else charge(attempt + 1, est(promptTok, maxTokens), "estimated");
        if ("fault" in c) {
          why = `transport fault in HTTP 200: ${c.fault}`;
        } else {
          const r = c.result;
          r.usd = spent;
          if (estimated) r.usd_source = "estimated";
          const pin = opts.config?.provider?.order;
          if (pin && !(r.provider && pin.some((p) => pinMatches(p, r.provider!))))
            throw Object.assign(new Error(`OpenRouter provider_mismatch: served by ${r.provider ?? "unknown"}, pinned ${pin.join(",")}`), { reason: "provider_mismatch", usd: spent, retryable: true });
          const want = opts.config?.quantization;
          if (want) {
            const served = typeof j?.quantization === "string" ? j.quantization : typeof j?.provider_quantization === "string" ? j.provider_quantization : null;
            if (served !== null && served.toLowerCase() !== want.toLowerCase())
              throw Object.assign(new Error(`OpenRouter quantization_mismatch: served ${served}, models.json ${want}`), { reason: "quantization_mismatch", usd: spent });
            r.quantization_requested = want; r.quantization_served = served;
          }
          return r;
        }
      } else {
        charge(attempt + 1, cost ?? 0, "reported");
        why = `HTTP ${status}: ${raw.slice(0, 300)}`;
      }
    } catch (e) {
      if ((e as { reason?: string }).reason === "provider_mismatch" || (e as { reason?: string }).reason === "quantization_mismatch") throw e;
      // Aborted or timed out: billed by the provider, unknown amount.
      charge(attempt + 1, est(promptTok, maxTokens), "estimated");
      why = `request failed: ${(e as Error).name}: ${(e as Error).message}`;
    }
    why = why.split(apiKey).join("[redacted]");
    const retryable = status === 0 || status === 429 || status >= 500 || why.startsWith("transport fault");
    const fail = (m: string) => Object.assign(new Error(m), spent ? { usd: spent } : {});
    if (!retryable || attempt >= maxRetries) throw fail(`OpenRouter ${why}`);
    const base = Math.max(backoff * 2 ** attempt, retryAfterMs);
    const wait = base + random() * 0.25 * base;
    if (slept + wait > budget) throw fail(`OpenRouter retry budget ${budget} ms exhausted after ${attempt + 1} attempts; last ${why}`);
    slept += wait;
    await sleep(wait);
  }
}

type Classified = { result: OpenRouterResult } | { fault: string };

function classify(j: any, raw: string, requested: string, latency_ms: number, attempts: number): Classified {
  if (j === undefined) return { fault: `malformed body: ${raw.slice(0, 200)}` };
  if (j.error) return { fault: `error object: ${JSON.stringify(j.error).slice(0, 200)}` };
  const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
  if (!choice?.message || typeof choice.message !== "object") return { fault: "malformed body: no choices[0].message" };
  const u = j.usage ?? {};
  const usage: LLMResult["usage"] = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
  const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined) usage.reasoning_tokens = reasoningTokens;
  const c = choice.message.content;
  const content = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("") : "";
  const refusal = typeof choice.message.refusal === "string" && choice.message.refusal ? choice.message.refusal : null;
  const reasoned = (typeof choice.message.reasoning === "string" && choice.message.reasoning.trim() !== "") || (reasoningTokens ?? 0) > 0 || (u.completion_tokens ?? 0) > 0;
  const outcome: OpenRouterOutcome = refusal ? "refusal" : choice.finish_reason === "content_filter" ? "content_filter" : choice.finish_reason === "length" ? "truncated" : content.trim() ? "ok" : "empty";
  if (outcome === "empty" && !reasoned) return { fault: "empty content with no reasoning and no completion tokens" };
  return { result: { outcome, text: refusal ?? content, model: j.model ?? requested, provider: j.provider ?? null, usage, latency_ms, raw: j, attempts } };
}
