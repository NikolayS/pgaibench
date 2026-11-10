// OpenAI Responses API client (plain fetch). Key from OPENAI_API_KEY.

export type InputMessage = { role: "user" | "assistant" | "developer"; content: string };

export interface OpenAIRequest {
  model: string;
  input: string | InputMessage[];
  instructions?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/** reasoning_tokens: null when the backend reports no count (never 0 by default). */
export interface LLMUsage { input_tokens: number; output_tokens: number; reasoning_tokens?: number | null }
export interface LLMResult { text: string; model: string; usage: LLMUsage; latency_ms: number; usd?: number }

export interface OpenAIOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  /** L2: the direct OpenAI API is paid; it runs only with this flag or PGAIBENCH_DEV_OPENAI_API=1 (development only). */
  devAllowPaidApi?: boolean;
}

const URL_RESPONSES = "https://api.openai.com/v1/responses";

export async function callOpenAI(req: OpenAIRequest, opts: OpenAIOptions = {}): Promise<LLMResult> {
  if (!(opts.devAllowPaidApi || process.env.PGAIBENCH_DEV_OPENAI_API === "1"))
    throw Object.assign(new Error("direct OpenAI API calls are paid and disabled; OpenAI models run through the Codex CLI subscription (set PGAIBENCH_DEV_OPENAI_API=1 only for development)"), { reason: "access:forbidden" });
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 2000;
  const body: Record<string, unknown> = { model: req.model, input: req.input };
  if (req.instructions !== undefined) body.instructions = req.instructions;
  if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };

  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await f(URL_RESPONSES, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const retryable = (res.status === 429 && !raw.includes("insufficient_quota")) || res.status >= 500;
      if (retryable && attempt < retries) {
        await Bun.sleep(backoff * 2 ** attempt);
        continue;
      }
      throw new Error(`OpenAI HTTP ${res.status}: ${raw.slice(0, 500)}`);
    }
    const json = JSON.parse(raw) as {
      model?: string;
      output?: { type: string; content?: { type: string; text?: string }[] }[];
      usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
    };
    const text = (json.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("");
    if (!text) throw new Error(`OpenAI response has no output text: ${raw.slice(0, 300)}`);
    const usage: LLMUsage = {
      input_tokens: json.usage?.input_tokens ?? 0,
      output_tokens: json.usage?.output_tokens ?? 0,
    };
    const rt = json.usage?.output_tokens_details?.reasoning_tokens;
    if (rt !== undefined) usage.reasoning_tokens = rt;
    return { text, model: json.model ?? req.model, usage, latency_ms: Math.round(performance.now() - t0) };
  }
}
