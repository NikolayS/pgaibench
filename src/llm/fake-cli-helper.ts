// Test helper: a fake codex / claude binary on PATH (fixtures/fake-cli.sh).
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Variables a parent shell or a parent Claude Code session may hold; none may reach a CLI child. */
export const PARENT_LEAKS: Record<string, string> = {
  OPENAI_API_KEY: "sk-leak-openai", ANTHROPIC_API_KEY: "sk-leak-anthropic", OPENROUTER_API_KEY: "sk-or-leak", CODEX_API_KEY: "sk-leak-codex",
  ANTHROPIC_AUTH_TOKEN: "leak", ANTHROPIC_BASE_URL: "https://leak", ANTHROPIC_MODEL: "leak", ANTHROPIC_CUSTOM_HEADERS: "x: leak", OPENAI_BASE_URL: "https://leak",
  CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", CLAUDE_CODE_SESSION_ID: "leak", CLAUDE_CODE_MESSAGING_SOCKET: "/leak",
  CLAUDE_CODE_MESSAGING_TOKEN: "leak", CLAUDE_CODE_ENTRYPOINT: "leak", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", CLAUDE_EFFORT: "max",
  AWS_ACCESS_KEY_ID: "leak", AWS_SECRET_ACCESS_KEY: "leak", AWS_REGION: "leak", GOOGLE_APPLICATION_CREDENTIALS: "/leak", GCLOUD_PROJECT: "leak", CLOUD_ML_REGION: "leak",
  AZURE_OPENAI_API_KEY: "leak", VERTEX_REGION_CLAUDE: "leak", CODEX_HOME: "/leak-codex-home", SSH_AUTH_SOCK: "/leak", SOME_OTHER_SECRET: "leak", LC_ALL: "C",
};
const made: string[] = [];
/** A temp dir that cleanupTmp() removes; test files call afterAll(cleanupTmp). */
export function trackTmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; }
export function cleanupTmp() { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); }
export const FAKE = join(import.meta.dir, "fixtures", "fake-cli.sh");
export function fake(bin: "codex" | "claude", outs: (string | { out?: string; err?: string; code?: number })[], last?: { out?: string; err?: string; code?: number }) {
  const root = trackTmp("fakecli-");
  const binDir = join(root, "bin"), d = join(root, "rec");
  mkdirSync(binDir); mkdirSync(d);
  // A parent HOME with a Codex login and personal files that must never reach the child.
  const home = join(root, "home");
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), '{"auth_mode":"chatgpt","tokens":"FAKE"}');
  writeFileSync(join(home, ".codex", "AGENTS.md"), "PERSONAL RULES");
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "leak"');
  copyFileSync(FAKE, join(binDir, bin));
  chmodSync(join(binDir, bin), 0o755);
  const put = (k: string, x: string | { out?: string; err?: string; code?: number }) => {
    const o = typeof x === "string" ? { out: x } : x;
    if (o.out !== undefined) writeFileSync(join(d, `out.${k}`), o.out);
    if (o.err !== undefined) writeFileSync(join(d, `err.${k}`), o.err);
    if (o.code !== undefined) writeFileSync(join(d, `code.${k}`), String(o.code));
  };
  outs.forEach((x, i) => put(String(i + 1), x));
  if (last) put("last", last);
  const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}`, FAKE_DIR: d, [`FAKE_DIR_${bin}`]: d, FAKE_VERSION: bin === "codex" ? "codex-cli 9.9.9" : "9.9.9 (Claude Code)",
    ...PARENT_LEAKS };
  writeFileSync(join(d, "version"), env.FAKE_VERSION);
  // codex debug models: a catalog shaped like codex-cli 0.164.0's, for the slugs tests use.
  writeFileSync(join(d, "catalog"), JSON.stringify({ models: ["m", "gpt-x", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"].map((slug) => ({ slug, multi_agent_version: "v2", tool_mode: "code_mode_only", experimental_supported_tools: ["clock"], base_instructions: "B" })) }));
  const rec = (f: string, n = 1) => readFileSync(join(d, `${f}.${n}`), "utf8");
  const calls = () => existsSync(join(d, "n")) ? Number(readFileSync(join(d, "n"), "utf8")) : 0;
  return { env, rec, calls, binDir, home, d };
}

/** Codex and claude fakes on one PATH. */
export function fakeBoth(a: ReturnType<typeof fake>, b: ReturnType<typeof fake>) {
  return { ...a.env, ...b.env, PATH: `${a.binDir}:${b.binDir}:${process.env.PATH}` };
}

/** A claude -p --output-format stream-json --verbose transcript, shaped as
 *  claude 2.1.322 prints it: system init, assistant messages, a rate-limit
 *  event, the result. */
export function claudeStream(result: Record<string, unknown>, o: { init?: Record<string, unknown>; extra?: unknown[]; rateLimit?: Record<string, unknown> | null } = {}): string {
  const init = { type: "system", subtype: "init", cwd: "/tmp/x", tools: [], mcp_servers: [], model: "claude-x-5-5", permissionMode: "default", slash_commands: [], apiKeySource: "none",
    claude_code_version: "9.9.9", skills: [], plugins: [{ name: "cc-plugin-telemetry", path: "builtin" }], ...o.init };
  const text = typeof result.result === "string" ? result.result : "";
  const lines: unknown[] = [init, { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
    { type: "assistant", message: { model: "claude-x-5-5", content: [{ type: "thinking", thinking: "" }] } },
    { type: "assistant", message: { model: "claude-x-5-5", content: [{ type: "text", text }] } }, ...(o.extra ?? [])];
  if (o.rateLimit !== null) lines.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false, ...o.rateLimit } });
  lines.push(result);
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
