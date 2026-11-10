// Fallback Analyst backend: `codex exec` on the ChatGPT subscription (used
// when the OpenAI API key has no credits). Stateless: each call flattens the
// conversation into one prompt. codex exec does not report the served model
// id, so the requested id is recorded with a "(codex exec, requested)" tag.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputMessage, LLMResult } from "./openai";
import type { Runner } from "./claude-cli";

export function buildCodexArgs(model: string, cwd: string): string[] {
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "-s", "read-only", "-c", 'approval_policy="never"', "-m", model, "-C", cwd, "-"];
}

export function flattenConversation(instructions: string, input: InputMessage[]): string {
  return [
    "Do not run any commands or read any files. Answer from the text below only.", "",
    "<instructions>", instructions, "</instructions>", "",
    ...input.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>\n`),
    "Reply to the last user message as the assistant.",
  ].join("\n");
}

export function parseCodexEvents(stdout: string, model: string, latencyMs: number): LLMResult {
  let text: string | undefined;
  const usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as { type: string; message?: string; item?: { type: string; text?: string };
      usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number } };
    if (ev.type === "error" || ev.type === "turn.failed") throw new Error(`codex exec error: ${ev.message ?? line.slice(0, 300)}`);
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text ?? "";
    if (ev.type === "turn.completed" && ev.usage) {
      usage.input_tokens += ev.usage.input_tokens ?? 0;
      usage.output_tokens += ev.usage.output_tokens ?? 0;
      usage.reasoning_tokens += ev.usage.reasoning_output_tokens ?? 0;
    }
  }
  if (text === undefined) throw new Error("codex exec: no agent message in output");
  return { text, model: `${model} (codex exec, requested)`, usage, latency_ms: latencyMs };
}

const defaultRunner: Runner = async (args, stdin) => {
  const p = Bun.spawn(["codex", ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

export async function callCodex(req: { model: string; instructions: string; input: InputMessage[] }, opts: { run?: Runner } = {}): Promise<LLMResult> {
  const cwd = mkdtempSync(join(tmpdir(), "analyst-"));
  const t0 = performance.now();
  const run = opts.run ?? defaultRunner;
  const args = buildCodexArgs(req.model, cwd);
  const stdin = flattenConversation(req.instructions, req.input);
  // One retry: codex exec occasionally exits 1 with empty stderr (transient).
  let r = await run(args, stdin);
  if (r.code !== 0) r = await run(args, stdin);
  if (r.code !== 0) throw new Error(`codex exec exit ${r.code}: ${r.stderr.slice(-500)} stdout: ${r.stdout.slice(-500)}`);
  return parseCodexEvents(r.stdout, req.model, Math.round(performance.now() - t0));
}

export async function codexVersion(run: (args: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }> = async (args) => {
  const p = Bun.spawn(["codex", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}): Promise<string> {
  const r = await run(["--version"], "");
  return r.code === 0 ? r.stdout.trim() : `unknown (exit ${r.code})`;
}
