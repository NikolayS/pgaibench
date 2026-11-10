// Runs `claude -p --model <m> --output-format json` with the prompt on stdin.
// The call is isolated from local customizations and runs in an empty cwd.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputMessage, LLMResult } from "./openai";

export interface ClaudeRequest { model: string; prompt: string; system?: string }
export type Runner = (args: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export function claudeAnalystPrompt(input: InputMessage[]): string {
  if (input.length === 1 && input[0]?.role === "user") return input[0].content;
  return [
    ...input.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`),
    "Reply to the last user message as the assistant.",
  ].join("\n\n");
}

export function buildClaudeArgs(req: { model: string; system?: string }): string[] {
  const args = ["-p", "--model", req.model, "--output-format", "json",
    "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
    "--safe-mode", "--disable-slash-commands"];
  if (req.system !== undefined) args.push("--system-prompt", req.system);
  return args;
}

export function parseClaudeResult(stdout: string, latencyMs: number): LLMResult {
  let j: {
    is_error?: boolean; subtype?: string; result?: string; total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    modelUsage?: Record<string, unknown>;
  };
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p output is not JSON: ${stdout.slice(0, 300)}`);
  }
  if (j.is_error || j.subtype !== "success" || typeof j.result !== "string") {
    throw new Error(`claude -p failed (${j.subtype}): ${String(j.result).slice(0, 300)}`);
  }
  if (!j.result.trim()) throw new Error("claude -p returned empty assistant text");
  const u = j.usage ?? {};
  const models = Object.keys(j.modelUsage ?? {});
  return {
    text: j.result,
    model: models.join(",") || "unknown",
    usage: {
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    },
    latency_ms: latencyMs,
    usd: j.total_cost_usd,
  };
}

async function spawnClaude(args: string[], stdin: string, cwd?: string): ReturnType<Runner> {
  const p = Bun.spawn(["claude", ...args], { cwd, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

const defaultRunner: Runner = async (args, stdin) => {
  const cwd = mkdtempSync(join(tmpdir(), "claude-"));
  try { return await spawnClaude(args, stdin, cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
};

export async function callClaude(req: ClaudeRequest, opts: { run?: Runner } = {}): Promise<LLMResult> {
  const run = opts.run ?? defaultRunner;
  const t0 = performance.now();
  const args = buildClaudeArgs(req);
  let r = await run(args, req.prompt);
  let retryable = r.code !== 0 && !r.stdout.trim();
  if (!retryable && r.stdout.trim()) {
    try {
      const j = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
      retryable = !!j.is_error && /rate.?limit|overload|temporar|unavailable|timeout|try again/i.test(j.result ?? "");
    } catch { /* parseClaudeResult reports malformed output below */ }
  }
  if (retryable) r = await run(args, req.prompt);
  if (r.code !== 0) throw new Error(`claude -p exit ${r.code}: ${r.stderr.slice(0, 500)} ${r.stdout.slice(0, 300)}`);
  return parseClaudeResult(r.stdout, Math.round(performance.now() - t0));
}

export async function claudeVersion(run: Runner = spawnClaude): Promise<string> {
  const r = await run(["--version"], "");
  return r.code === 0 ? r.stdout.trim() : `unknown (exit ${r.code})`;
}
