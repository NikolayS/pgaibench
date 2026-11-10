// Generation-path backends for models on subscription logins (no API key):
// OpenAI models through the Codex CLI, Anthropic models through the Claude
// Code CLI. The benchmark system prompt replaces the CLI's own base prompt
// (codex: model_instructions_file; claude: --system-prompt-file), effort is
// set explicitly, the child runs in an empty temporary cwd with an allowlist
// environment (CLI_ENV_ALLOW). What the wrappers keep (Codex tool schemas, the Claude
// SDK identity line) is recorded as `wrapper`. CLI chatter (banners,
// warnings, stderr) never enters the answer text.
//
// Rate-limit and usage-window messages are retried with backoff; when they
// persist the call throws reason "access:subscription_limit" (retryable
// later). There is never a fallback to a paid path.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputMessage, LLMResult } from "./openai";
import { withCodexLogin } from "./codex-auth";

export type CliAccess = "codex-cli" | "claude-cli";
export type CliOutcome = "ok" | "empty" | "refusal" | "truncated";
export interface CliGenResult extends LLMResult {
  outcome: CliOutcome; provider: null; raw: unknown; usd: 0; list_usd?: number;
  billing: "subscription"; access: CliAccess; wrapper: string; cli_model: string; effort: string;
  reported: Record<string, unknown>; cli_warnings?: string[];
  /** M6: neither CLI echoes the effort in its JSON output (codex 0.164.0, claude 2.1.322): always null. */
  effort_confirmed: null;
  /** M6: the model the response names; null when the CLI reports none (Codex). */
  model_served: string | null;
  /** N5: requested tier (codex: "default"; claude: null, no such setting) and the tier the output reports (null: none). */
  service_tier: string | null; service_tier_reported: string | null;
}
export interface CliGenRequest { cliModel: string; effort: string; instructions: string; input: InputMessage[]; /** N2: codex only, see codexCatalogFor. */ catalogBase?: string }
export interface CliGenOptions {
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  /** Waits before each retry on a limit message (default 30 s, 60 s, 120 s). */
  backoffMs?: number[];
  timeoutMs?: number;
  /** N3: dir under the run output for a refreshed Codex login that cannot be written back. */
  codexLoginStash?: string;
}

/** the child gets an allowlist environment, never the parent's. Not
 *  passed, among others: every *_API_KEY, ANTHROPIC_*, OPENAI_*,
 *  OPENROUTER_*, *_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, AWS_*,
 *  GOOGLE_*, GCLOUD*, AZURE_*, CODEX_HOME and the CLAUDE_CODE_* session and
 *  messaging variables of a parent Claude Code session. LC_* passes too.
 *  Claude needs HOME, USER and CLAUDE_CONFIG_DIR to find its OAuth login in
 *  the macOS keychain (found by experiment, claude auth status, 2.1.322). */
export const CLI_ENV_ALLOW = {
  common: ["PATH", "TMPDIR", "LANG", "TERM", "USER", "LOGNAME"],
  "codex-cli": ["HOME", "CODEX_HOME"],
  "claude-cli": ["HOME", "CLAUDE_CONFIG_DIR"],
} as const satisfies Record<string, readonly string[]>;
export function childEnv(access: CliAccess, parent: Record<string, string | undefined>, over: Record<string, string> = {}): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent))
    if (v !== undefined && ((CLI_ENV_ALLOW.common as readonly string[]).includes(k) || /^LC_[A-Z_]+$/.test(k))) o[k] = v;
  if (parent.HOME !== undefined) o.HOME = parent.HOME;
  if (access === "claude-cli" && parent.CLAUDE_CONFIG_DIR !== undefined) o.CLAUDE_CONFIG_DIR = parent.CLAUDE_CONFIG_DIR;
  return { ...o, ...over };
}

/** M3: the CLIs' own usage-window phrases. Used only on the failure message
 *  of a turn (never on stderr), next to the structured fields below. */
export const isLimitMessage = (s: string) => /usage limit|rate.?limit (exceeded|reached)|too many requests|limit reached|hit your limit/i.test(s);
/** Codex codex_error_info variants (codex-cli 0.164.0 strings) that mean the plan window is used up. */
const CODEX_LIMIT_INFO = /^(usage_?limit_?(exceeded|reached)|rate_?limit_?exceeded|usage_?limited)$/i;
function codexLimitInfo(ev: any): boolean {
  const info = ev?.codex_error_info ?? ev?.error?.codex_error_info;
  const keys = typeof info === "string" ? [info] : info && typeof info === "object" ? Object.keys(info) : [];
  return keys.some((k) => CODEX_LIMIT_INFO.test(k)) || ev?.http_status_code === 429 || ev?.error?.http_status_code === 429;
}

/** fatal: never retried (tool use, missing login). events: the raw stream, kept for the record. */
export class CliError extends Error { constructor(m: string, public reason: string, public retryable = false, public fatal = false, public events?: unknown[]) { super(m); } }

const binOf = (a: CliAccess) => a === "codex-cli" ? "codex" : "claude";
/** M4: the CLI runs in its own process group (detached); on timeout, and
 *  after every exit, the whole group is killed, so no helper or command a
 *  CLI started can outlive the call. */
export async function spawn(bin: string, args: string[], stdin: string, env: Record<string, string>, cwd?: string, timeoutMs = 900_000) {
  const exe = Bun.which(bin, { PATH: env.PATH ?? "" }) ?? bin;
  const p = Bun.spawn([exe, ...args], { cwd, env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", detached: true });
  const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-p.pid, sig); } catch { /* group gone */ } };
  let timedOut = false, hard: Timer | undefined;
  const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); hard = setTimeout(() => killGroup("SIGKILL"), 2000); }, timeoutMs);
  const out = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); // read while it runs: a full pipe must not block the child
  const code = await p.exited;
  killGroup("SIGKILL"); // children that still hold the pipes open
  clearTimeout(timer); clearTimeout(hard);
  const [stdout, stderr] = await out;
  if (timedOut) throw new CliError(`${bin} timed out after ${timeoutMs} ms; process group killed`, "access:cli_error", true);
  return { code, stdout, stderr };
}

const versions = new Map<string, Promise<string>>();
/** "codex-cli <version>" / "claude-code <version>", read once per binary path. */
export function cliWrapper(access: CliAccess, env: Record<string, string | undefined> = process.env): Promise<string> {
  const e = childEnv(access, env), bin = binOf(access), key = `${access}:${Bun.which(bin, { PATH: e.PATH ?? "" })}`;
  if (!versions.has(key)) versions.set(key, spawn(bin, ["--version"], "", e).then((r) => {
    const v = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? `unknown (exit ${r.code})`;
    return `${access === "codex-cli" ? "codex-cli" : "claude-code"} ${v}`;
  }));
  return versions.get(key)!;
}

/** The user-side text: one user message as is; a longer conversation (repair turn) flattened, without instructions. */
export function cliUserText(input: InputMessage[]): string {
  if (input.length === 1 && input[0]!.role === "user") return input[0]!.content;
  return [...input.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`), "Reply to the last user message as the assistant."].join("\n\n");
}

/** Runs attempt() with the retry rules: limit messages back off, other faults retry once. */
async function withRetries<T>(attempt: () => Promise<T>, o: CliGenOptions): Promise<T> {
  const waits = o.backoffMs ?? [30_000, 60_000, 120_000], sleep = o.sleep ?? Bun.sleep;
  let limits = 0, faults = 0;
  for (;;) {
    try { return await attempt(); } catch (e) {
      const ce = e instanceof CliError ? e : new CliError(String((e as Error).message ?? e), "access:cli_error");
      if (ce.fatal) throw ce;
      if (ce.reason === "access:subscription_limit") {
        if (limits >= waits.length) throw ce;
        await sleep(waits[limits++]!);
      } else if (faults++ >= 1) throw ce;
    }
  }
}

function withTemp<T>(f: (cwd: string, instrFile: string) => Promise<T>, instructions: string): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "gen-cwd-")), side = mkdtempSync(join(tmpdir(), "gen-sys-"));
  const file = join(side, "system.md");
  writeFileSync(file, instructions);
  return f(cwd, file).finally(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(side, { recursive: true, force: true }); });
}

/** features of codex-cli 0.164.0 (codex features list) that add a tool,
 *  a tool source or a personal context source; all off. --strict-config
 *  makes an unknown key or feature name an error, so a renamed feature
 *  cannot silently stay on. */
export const CODEX_DISABLED_FEATURES = ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "multi_agent", "multi_agent_v2", "view_image", "image_generation",
  "plugins", "remote_plugin", "skill_search", "skill_mcp_dependency_install", "hooks", "goals", "sleep_tool", "apps", "browser_use", "browser_use_external", "computer_use",
  "in_app_browser", "tool_suggest", "memories", "code_mode_host", "workspace_dependencies", "tool_call_mcp_elicitation", "enable_mcp_apps", "standalone_web_search",
  "request_permissions_tool", "default_mode_request_user_input", "incremental_tools", "fast_mode", "ultrafast_mode"] as const;

/** N5: the standard (non-priority) tier, requested for every model. Codex
 *  sends no service_tier field for it (offline capture); the catalog's
 *  priority defaults and speed tiers are patched out. */
export const CODEX_SERVICE_TIER = "default";

/** prompt sections of codex-cli 0.164.0 that `codex debug
 *  prompt-input` showed in the model-visible input with the flags above:
 *  skills list, permissions, collaboration mode, apps, environment context.
 *  All off; with them and the patched catalog the input is the user text only. */
export const CODEX_PROMPT_SECTIONS_OFF = ["skills.include_instructions=false", "skills.bundled.enabled=false", "include_environment_context=false",
  "include_permissions_instructions=false", "include_collaboration_mode_instructions=false", "include_apps_instructions=false"] as const;

/** N1: tools that stay in the request after the feature flags: the Plan-mode
 *  request_user_input tool (config key, codex-cli 0.164.0). apply_patch is
 *  removed in the catalog patch (apply_patch_tool_type null). Verified per
 *  model by the offline request capture (cli-isolation.ts). */
export const CODEX_TOOLS_OFF = ["tools.experimental_request_user_input.enabled=false"] as const;

export function buildCodexGenArgs(model: string, effort: string, instrFile: string, cwd: string, catalogFile?: string): string[] {
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--strict-config", "-s", "read-only",
    ...(catalogFile ? ["-c", `model_catalog_json=${JSON.stringify(catalogFile)}`] : []), ...CODEX_PROMPT_SECTIONS_OFF.flatMap((c) => ["-c", c]), ...CODEX_TOOLS_OFF.flatMap((c) => ["-c", c]),
    "-c", `service_tier=${JSON.stringify(CODEX_SERVICE_TIER)}`, "-c", 'approval_policy="never"', "-c", `model_instructions_file=${JSON.stringify(instrFile)}`, "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
    "-c", 'shell_environment_policy.inherit="none"', "-c", 'history.persistence="none"', "-c", "project_doc_max_bytes=0",
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-m", model, "-C", cwd, "-"];
}

/** the only Codex events a text-only turn may hold. Anything else (a
 *  command, a file change, web search, an MCP or collaboration call, an
 *  image, an approval request, or a type this code does not know) fails
 *  the cell as access:tool_use_detected. */
export const CODEX_EVENT_ALLOW = ["thread.started", "turn.started", "turn.completed", "turn.failed", "error"];
export const CODEX_ITEM_ALLOW = ["agent_message", "reasoning", "error"];
const isItemEvent = (t: unknown) => t === "item.started" || t === "item.updated" || t === "item.completed";

export function parseCodexGen(stdout: string, stderr: string, code: number) {
  let text: string | undefined, completed = false, failure: string | undefined, limit = false, tier: string | null = null;
  const warnings: string[] = [], events: unknown[] = [], banned: string[] = [], errors: string[] = [];
  const u: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number | null } = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: null };
  for (const line of stdout.split("\n")) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; } // banners, progress lines
    if (!ev || typeof ev !== "object") continue;
    events.push(ev);
    const t = ev.service_tier ?? ev.usage?.service_tier ?? ev.response?.service_tier;
    if (typeof t === "string") tier = t;
    if (isItemEvent(ev.type) ? !CODEX_ITEM_ALLOW.includes(ev.item?.type) : !CODEX_EVENT_ALLOW.includes(ev.type)) { banned.push(isItemEvent(ev.type) ? `${ev.type}:${ev.item?.type}` : String(ev.type)); continue; }
    if (ev.type === "error") { errors.push(String(ev.message ?? line)); limit ||= codexLimitInfo(ev); }
    else if (ev.type === "turn.failed") { failure = String(ev.error?.message ?? line); limit ||= codexLimitInfo(ev); }
    else if (ev.type === "item.completed" && ev.item?.type === "error") warnings.push(String(ev.item.message));
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = String(ev.item.text ?? "");
    else if (ev.type === "turn.completed") {
      completed = true;
      u.input_tokens += ev.usage?.input_tokens ?? 0; u.cached_input_tokens += ev.usage?.cached_input_tokens ?? 0;
      u.output_tokens += ev.usage?.output_tokens ?? 0;
      if (typeof ev.usage?.reasoning_output_tokens === "number") u.reasoning_tokens = (u.reasoning_tokens ?? 0) + ev.usage.reasoning_output_tokens;
    }
  }
  // N5: codex-cli 0.164.0 reports no tier; when a later version does, anything but the standard tier fails.
  if (tier !== null && tier !== CODEX_SERVICE_TIER) throw new CliError(`codex exec: service tier ${tier} reported, ${CODEX_SERVICE_TIER} requested`, "access:service_tier_mismatch", false, true, events);
  // N2: Codex ran the model on fallback metadata (no catalog entry): settings unknown, never accepted.
  const fallback = warnings.find((w) => /model metadata for .* not found/i.test(w));
  if (fallback) throw new CliError(`codex exec: ${fallback}`, "access:isolation_failed", false, true, events);
  if (banned.length) throw new CliError(`codex exec: tool or unknown event in a text-only turn: ${[...new Set(banned)].join(", ")}`, "access:tool_use_detected", false, true, events);
  // M3: an error event (e.g. "Reconnecting... 1/5") fails the turn only when no completed answer follows.
  if (completed && text !== undefined && failure === undefined) warnings.push(...errors);
  else if (failure === undefined && errors.length) failure = errors.at(-1);
  if (failure !== undefined || code !== 0) {
    const m = `codex exec exit ${code}: ${failure ?? ""} ${stderr.slice(-400)}`.trim();
    throw new CliError(m, limit || isLimitMessage(failure ?? "") ? "access:subscription_limit" : "access:cli_error", true);
  }
  if (!completed || text === undefined) throw new CliError(`codex exec: no agent message in output (${stdout.slice(-300)})`, "access:cli_error");
  return { text, usage: u, warnings, events, tier };
}

/** a fresh CODEX_HOME (also HOME) holding only a mode-600 copy of the
 *  login, so no AGENTS.md, skills, config, rules, history or memories load.
 *  Removed after the call. N3: a refreshed copy is written back (codex-auth.ts). */
export function codexAuthSource(parent: Record<string, string | undefined>): string {
  // The parent's CODEX_HOME is ignored on purpose: the login is $HOME/.codex/auth.json.
  return join(parent.HOME ?? "/nonexistent", ".codex", "auth.json");
}
/** the model catalog sets per model a multi-agent role (multi_agent_version
 *  v2: role text and spawn_agent/send_message tools) and code_mode_only tools,
 *  which feature flags do not remove. We read the CLI's bundled catalog once
 *  (codex debug models, empty home, no login: no network auth) and patch every
 *  entry: multi_agent_version null, tool_mode direct, no experimental tools,
 *  no apply_patch tool (N1), no priority tier default or speed tiers (N5). */
const catalogs = new Map<string, Promise<{ json: string; slugs: string[] }>>();
export function codexCatalog(parent: Record<string, string | undefined>): Promise<{ json: string; slugs: string[] }> {
  const key = Bun.which("codex", { PATH: parent.PATH ?? "" }) ?? "codex";
  if (!catalogs.has(key)) catalogs.set(key, (async () => {
    const home = mkdtempSync(join(tmpdir(), "gen-catalog-"));
    try {
      const r = await spawn("codex", ["debug", "models"], "", childEnv("codex-cli", parent, { HOME: home, CODEX_HOME: home }), home, 60_000);
      const j = JSON.parse(r.stdout);
      if (!Array.isArray(j?.models)) throw new Error("no models array");
      for (const m of j.models) { m.multi_agent_version = null; m.tool_mode = "direct"; m.experimental_supported_tools = []; m.apply_patch_tool_type = null; m.default_service_tier = null; m.service_tiers = []; m.additional_speed_tiers = []; }
      return { json: JSON.stringify(j), slugs: j.models.map((m: { slug?: string }) => String(m.slug)) };
    } catch (e) {
      catalogs.delete(key);
      throw new CliError(`codex debug models: cannot read the model catalog (${(e as Error).message})`, "access:isolation_failed", false, true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  })());
  return catalogs.get(key)!;
}

/** N2: the catalog JSON for one model. A model the bundled catalog lacks
 *  gets a copy of its base entry (models.json codex_catalog_base; already
 *  patched) under its own slug. No entry and no usable base is a hard error:
 *  Codex fallback metadata is never used. */
export function codexCatalogFor(catalog: { json: string; slugs: string[] }, cliModel: string, base?: string): string {
  if (catalog.slugs.includes(cliModel)) return catalog.json;
  const j = JSON.parse(catalog.json), b = base ? j.models.find((m: { slug?: string }) => m.slug === base) : undefined;
  if (!b) throw new CliError(`codex: ${cliModel} is not in the Codex model catalog${base ? ` and its base ${base} is missing too` : " and has no codex_catalog_base"}; fallback metadata is not allowed`, "access:isolation_failed", false, true);
  j.models.push({ ...b, slug: cliModel, display_name: cliModel });
  return JSON.stringify(j);
}


export async function callCodexGen(req: CliGenRequest, o: CliGenOptions = {}): Promise<CliGenResult> {
  const parent = o.env ?? process.env, wrapper = await cliWrapper("codex-cli", parent), t0 = performance.now();
  const stdin = cliUserText(req.input);
  const catalogJson = codexCatalogFor(await codexCatalog(parent), req.cliModel, req.catalogBase);
  const p = await withTemp((cwd, file) => withRetries(() => withCodexLogin(codexAuthSource(parent), o.codexLoginStash, async (home) => {
    const env = childEnv("codex-cli", parent, { HOME: home, CODEX_HOME: home }), cat = join(home, "catalog.json");
    writeFileSync(cat, catalogJson);
    const r = await spawn("codex", buildCodexGenArgs(req.cliModel, req.effort, file, cwd, cat), stdin, env, cwd, o.timeoutMs);
    return parseCodexGen(r.stdout, r.stderr, r.code);
  }), o), req.instructions);
  return {
    text: p.text, outcome: p.text.trim() ? "ok" : "empty", provider: null, raw: { events: p.events }, usd: 0,
    model: `${req.cliModel} (codex exec, requested)`, latency_ms: Math.round(performance.now() - t0),
    usage: { input_tokens: p.usage.input_tokens, output_tokens: p.usage.output_tokens, reasoning_tokens: p.usage.reasoning_tokens },
    billing: "subscription", access: "codex-cli", wrapper, cli_model: req.cliModel, effort: req.effort, effort_confirmed: null, model_served: null, service_tier: CODEX_SERVICE_TIER, service_tier_reported: p.tier,
    reported: { model: null, ...p.usage }, ...(p.warnings.length ? { cli_warnings: p.warnings } : {}),
  };
}

/** fixed switches for the claude child (names checked in the 2.1.322
 *  binary): no auto-memory, no CLAUDE.md, no server-side advisor tool (the
 *  debug log showed "[AdvisorTool] Server-side tool enabled" without it), no
 *  telemetry or other non-essential traffic, no auto-update. */
export const CLAUDE_FIXED_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1" } as const;

export function buildClaudeGenArgs(model: string, effort: string, instrFile: string): string[] {
  return ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--setting-sources", "", "--safe-mode", "--disable-slash-commands", "--system-prompt-file", instrFile, "--effort", effort];
}

/** the stream-json events a text-only claude turn may hold. */
export const CLAUDE_EVENT_ALLOW = ["system", "assistant", "result", "rate_limit_event"];
export const CLAUDE_SYSTEM_ALLOW = ["init", "thinking_tokens", "api_retry", "status"];
export const CLAUDE_BLOCK_ALLOW = ["text", "thinking", "redacted_thinking"];

export function parseClaudeGen(stdout: string, stderr: string, code: number) {
  let j: any, init: any;
  const events: any[] = [], banned: string[] = [], rateLimits: unknown[] = [];
  for (const line of stdout.split("\n")) {
    let x: any;
    try { x = JSON.parse(line); } catch { continue; } // chatter
    if (!x || typeof x !== "object" || typeof x.type !== "string") continue;
    events.push(x);
    if (!CLAUDE_EVENT_ALLOW.includes(x.type)) banned.push(x.type);
    else if (x.type === "system") { if (!CLAUDE_SYSTEM_ALLOW.includes(x.subtype)) banned.push(`system:${x.subtype}`); else if (x.subtype === "init") init = x; }
    else if (x.type === "assistant") { for (const b of x.message?.content ?? []) if (!CLAUDE_BLOCK_ALLOW.includes(b?.type)) banned.push(`assistant:${b?.type}`); }
    else if (x.type === "rate_limit_event") rateLimits.push(x.rate_limit_info ?? null);
    else if (x.type === "result") j = x;
  }
  if (j?.permission_denials?.length) banned.push("permission_denials");
  if (banned.length) throw new CliError(`claude -p: tool or unknown event in a text-only turn: ${[...new Set(banned)].join(", ")}`, "access:tool_use_detected", false, true, events);
  if (j && !init) throw new CliError("claude -p: no init event, isolation cannot be verified", "access:isolation_failed", false, true, events);
  if (init) {
    // N4: fail closed when a field is missing or changed shape (a newer CLI may rename it).
    if (!Array.isArray(init.tools) || !Array.isArray(init.mcp_servers) || typeof init.apiKeySource !== "string")
      throw new CliError(`claude -p: init event lacks tools/mcp_servers arrays or apiKeySource; isolation cannot be verified`, "access:isolation_failed", false, true, events);
    if (init.apiKeySource !== "none") throw new CliError(`claude -p: apiKeySource ${init.apiKeySource}; only the subscription login is allowed`, "access:api_key_in_use", false, true, events);
    if (init.tools.length || init.mcp_servers.length)
      throw new CliError(`claude -p: tools ${JSON.stringify(init.tools)} / MCP servers ${JSON.stringify(init.mcp_servers)} present`, "access:isolation_failed", false, true, events);
  }
  // M1: the limiter says the plan window is exhausted and overage pays, or a fallback credit was used: billing is not known to be zero.
  const overage = rateLimits.some((r: any) => r?.isUsingOverage === true) || (j?.usage?.fallback_credit ?? null) !== null;
  if (overage) throw Object.assign(new CliError(`claude -p: the response reports overage or credit use (${JSON.stringify(rateLimits)}, fallback_credit ${JSON.stringify(j?.usage?.fallback_credit ?? null)}); stopping CLI cells`, "access:possible_overage", false, true, events), { billing: "unknown" });
  if (!j) {
    const m = `claude -p exit ${code}: output has no result event: ${stdout.slice(0, 300)} ${stderr.slice(-300)}`;
    throw new CliError(m, "access:cli_error", true);
  }
  if (j.is_error || code !== 0 || j.subtype !== "success") {
    const m = `claude -p failed (${j.subtype}, exit ${code}): ${String(j.result).slice(0, 300)}`;
    // M3: structured first (HTTP status of the API error, the limiter's own status), then the CLI's limit phrase in the result.
    const rejected = rateLimits.some((r: any) => r && r.status && r.status !== "allowed" && r.status !== "allowed_warning");
    const limit = j.api_error_status === 429 || rejected || (j.api_error_status == null && isLimitMessage(String(j.result ?? "")));
    throw new CliError(m, limit ? "access:subscription_limit" : "access:cli_error", true);
  }
  return { ...j, _init: init, _rateLimits: rateLimits };
}

export async function callClaudeGen(req: CliGenRequest, o: CliGenOptions = {}): Promise<CliGenResult> {
  const env = childEnv("claude-cli", o.env ?? process.env, CLAUDE_FIXED_ENV), wrapper = await cliWrapper("claude-cli", o.env ?? process.env), t0 = performance.now();
  const stdin = cliUserText(req.input);
  const j = await withTemp((cwd, file) => withRetries(async () => {
    const r = await spawn("claude", buildClaudeGenArgs(req.cliModel, req.effort, file), stdin, env, cwd, o.timeoutMs);
    return parseClaudeGen(r.stdout, r.stderr, r.code);
  }, o), req.instructions);
  const u = j.usage ?? {}, mu = (Object.values(j.modelUsage ?? {})[0] ?? {}) as any;
  const model = Object.keys(j.modelUsage ?? {}).join(",") || "unknown";
  const text = typeof j.result === "string" ? j.result : "";
  const thinking: number | null = u.output_tokens_details?.thinking_tokens ?? mu.thinkingTokens ?? null;
  const outcome: CliOutcome = j.stop_reason === "refusal" ? "refusal" : j.stop_reason === "max_tokens" ? "truncated" : text.trim() ? "ok" : "empty";
  return {
    text, outcome, provider: null, raw: j, usd: 0, ...(typeof j.total_cost_usd === "number" ? { list_usd: j.total_cost_usd } : {}),
    model, latency_ms: Math.round(performance.now() - t0),
    usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0, reasoning_tokens: thinking },
    billing: "subscription", access: "claude-cli", wrapper, cli_model: req.cliModel, effort: req.effort, effort_confirmed: null, service_tier: null, service_tier_reported: null,
    model_served: mu.canonicalModel ?? j._init?.model ?? (model !== "unknown" ? model : null),
    reported: { model: mu.canonicalModel ?? model, provider: mu.provider ?? null, input_tokens: u.input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, reasoning_tokens: thinking, stop_reason: j.stop_reason ?? null,
      rate_limit: (j._rateLimits ?? []).map((r: any) => r && { status: r.status, rateLimitType: r.rateLimitType, overageStatus: r.overageStatus, overageDisabledReason: r.overageDisabledReason, isUsingOverage: r.isUsingOverage }) },
  };
}

/** M1: what the CLIs expose about the account, from read-only commands
 *  (codex login status, claude auth status --json). No email, org or token
 *  content is kept. */
export async function cliAccountStatus(parent: Record<string, string | undefined> = process.env, stash?: string) {
  const codex = await withCodexLogin(codexAuthSource(parent), stash, async (home) => {
    const r = await spawn("codex", ["login", "status"], "", childEnv("codex-cli", parent, { HOME: home, CODEX_HOME: home }), home, 30_000);
    let plan_type: string | null = null;
    try { // the plan type claim of the login's id token; nothing else is read
      const tok = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))?.tokens?.id_token;
      const claims = typeof tok === "string" ? JSON.parse(Buffer.from(tok.split(".")[1]!, "base64url").toString()) : undefined;
      plan_type = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null;
    } catch { /* no claim */ }
    return { login: (r.stdout + r.stderr).trim().split("\n")[0] ?? "", exit: r.code, plan_type };
  }).catch((e) => ({ login: `error: ${(e as Error).message}`, exit: null, plan_type: null }));
  let claude: Record<string, unknown>;
  try {
    const r = await spawn("claude", ["auth", "status", "--json"], "", childEnv("claude-cli", parent, CLAUDE_FIXED_ENV), undefined, 30_000);
    const j = JSON.parse(r.stdout);
    claude = { loggedIn: j.loggedIn, authMethod: j.authMethod, apiProvider: j.apiProvider, subscriptionType: j.subscriptionType ?? null };
  } catch (e) { claude = { error: String((e as Error).message ?? e) }; }
  return { codex, claude, detectable: {
    claude: "per call: rate_limit_event (status, overageStatus, overageDisabledReason, isUsingOverage) and usage.fallback_credit; isUsingOverage true or a fallback credit stops CLI cells",
    codex: "codex exec --json reports no credit or overage use; only the interactive /status screen shows credits. Not detectable by this harness: the owner must confirm credits are off",
  } };
}
