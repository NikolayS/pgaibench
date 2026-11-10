// Generation-path CLI backends against fake codex / claude binaries on PATH.
// No real model call.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeStream, fake, PARENT_LEAKS, cleanupTmp } from "./fake-cli-helper";
import { cliAccountStatus, buildClaudeGenArgs, buildCodexGenArgs, callClaudeGen, CLAUDE_FIXED_ENV, callCodexGen, childEnv, CODEX_DISABLED_FEATURES, CLI_ENV_ALLOW, cliWrapper, isLimitMessage } from "./cli-gen";

afterAll(cleanupTmp);

const noSleep = { sleep: async () => {}, backoffMs: [1, 1, 1] };
const user = (content: string) => [{ role: "user" as const, content }];

const codexOk = (text: string, extra = "") => [
  '{"type":"thread.started","thread_id":"t"}',
  "Reading prompt from stdin...",
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"features.skills is ignored"}}',
  '{"type":"turn.started"}',
  extra,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(text)}}}`,
  '{"type":"turn.completed","usage":{"input_tokens":7012,"cached_input_tokens":3000,"cache_write_input_tokens":0,"output_tokens":420,"reasoning_output_tokens":300}}',
].filter(Boolean).join("\n") + "\n";

/** Keys of a recorded `env` dump; PWD, SHLVL and _ are set by bash itself. */
const envKeys = (dump: string) => dump.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("="))).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)).sort();
const allowedKey = (access: "codex-cli" | "claude-cli", k: string) => CLI_ENV_ALLOW.common.includes(k) || /^LC_[A-Z_]+$/.test(k) || CLI_ENV_ALLOW[access].includes(k) || (access === "claude-cli" && k in CLAUDE_FIXED_ENV);

describe("child environment (allowlist, never the parent's)", () => {
  const parent = { ...PARENT_LEAKS, PATH: "/p", HOME: "/h", USER: "u", LOGNAME: "u", TMPDIR: "/t", LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8", TERM: "xterm", CLAUDE_CONFIG_DIR: "/h/.claude" };
  test("only allowlisted keys pass, for both CLIs", () => {
    for (const a of ["codex-cli", "claude-cli"] as const) {
      const e = childEnv(a, parent);
      for (const k of Object.keys(e)) expect([a, k, allowedKey(a, k)]).toEqual([a, k, true]);
      for (const k of Object.keys(PARENT_LEAKS)) if (k !== "LC_ALL") expect(e[k]).toBeUndefined();
      expect(e).toMatchObject({ PATH: "/p", TMPDIR: "/t", LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8" });
    }
    expect(childEnv("claude-cli", parent)).toMatchObject({ HOME: "/h", USER: "u", CLAUDE_CONFIG_DIR: "/h/.claude" });
    expect(childEnv("codex-cli", parent).CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  test("the real child of each CLI sees only the allowlist", async () => {
    const f = fake("codex", [codexOk("A")]);
    await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    const g = fake("claude", [claudeOut()]);
    await callClaudeGen({ cliModel: "m", effort: "high", instructions: "S", input: user("q") }, { env: { ...g.env, CLAUDE_CONFIG_DIR: "/cfg" }, ...noSleep });
    for (const [a, r] of [["codex-cli", f], ["claude-cli", g]] as const) {
      const keys = envKeys(r.rec("env"));
      expect(keys.filter((k) => !allowedKey(a, k))).toEqual([]);
      expect(keys).toContain("PATH");
      for (const [k, v] of Object.entries(PARENT_LEAKS)) if (k !== "LC_ALL") expect(r.rec("env")).not.toContain(`${k}=${v}\n`);
    }
    expect(g.rec("env")).toContain("CLAUDE_CONFIG_DIR=/cfg\n");
  });
  test("M3: limit phrases match; a bare 429, quota or overloaded in text does not", () => {
    for (const m of ["You've hit your usage limit. Try again in 2 hours.", "Too Many Requests", "rate limit exceeded", "Claude AI usage limit reached|1762000000", "5-hour limit reached"]) expect(isLimitMessage(m)).toBe(true);
    for (const m of ["syntax error", "not logged in", "HTTP 429 from tool", "quota of files", "overloaded_error", "field 429 invalid"]) expect(isLimitMessage(m)).toBe(false);
  });
});

describe("M3: Codex error events and structured limits", () => {
  const q = { cliModel: "m", effort: "medium", instructions: "", input: user("q") };
  test("a reconnect error followed by a completed answer is a warning, not a failure", async () => {
    const f = fake("codex", [codexOk("GOOD", '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: 429 from upstream)"}')]);
    const r = await callCodexGen(q, { env: f.env, ...noSleep });
    expect(r.text).toBe("GOOD");
    expect(r.cli_warnings?.some((w) => w.startsWith("Reconnecting... 1/5"))).toBe(true);
    expect(f.calls()).toBe(1);
  });
  test("an error with no completed answer fails; 429 in its text alone is not a limit", async () => {
    const f = fake("codex", [], { out: '{"type":"error","message":"stream error: upstream 429 while reading"}\n', code: 1 });
    const e = await callCodexGen(q, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:cli_error");
    expect(f.calls()).toBe(2);
  });
  test("structured codex_error_info usage/rate limit is a limit", async () => {
    for (const info of ["usage_limit_exceeded", "usageLimitExceeded", { rate_limit_exceeded: {} }, "rateLimitExceeded"]) {
      const f = fake("codex", [], { out: JSON.stringify({ type: "turn.failed", error: { message: "x", codex_error_info: info } }) + "\n", code: 1 });
      expect((await callCodexGen(q, { env: f.env, ...noSleep }).catch((x) => x)).reason).toBe("access:subscription_limit");
    }
  });
  test("stderr text never decides a limit", async () => {
    const f = fake("codex", [], { err: "warning: rate limit quota 429", code: 2 });
    expect((await callCodexGen(q, { env: f.env, ...noSleep }).catch((x) => x)).reason).toBe("access:cli_error");
  });
  test("claude: api_error_status 429 or a rejected rate-limit event is a limit; other errors are not", async () => {
    const qc = { cliModel: "m", effort: "high", instructions: "", input: user("q") };
    const a = fake("claude", [], { out: claudeOut({ is_error: true, subtype: "success", api_error_status: 429, result: "API Error" }), code: 1 });
    expect((await callClaudeGen(qc, { env: a.env, ...noSleep }).catch((x) => x)).reason).toBe("access:subscription_limit");
    const b = fake("claude", [], { out: claudeOut({ is_error: true, subtype: "success", result: "error" }, { rateLimit: { status: "rejected" } }), code: 1 });
    expect((await callClaudeGen(qc, { env: b.env, ...noSleep }).catch((x) => x)).reason).toBe("access:subscription_limit");
    const c = fake("claude", [], { out: claudeOut({ is_error: true, subtype: "success", api_error_status: 500, result: "API Error: 429 in body" }), code: 1 });
    expect((await callClaudeGen(qc, { env: c.env, ...noSleep }).catch((x) => x)).reason).toBe("access:cli_error");
  });
});

describe("callCodexGen", () => {
  test("every tool-bearing feature off, strict config, read-only sandbox, approval never", () => {
    const a = buildCodexGenArgs("m", "medium", "/i.md", "/cwd");
    expect(a).toContain("--strict-config");
    const off = a.flatMap((x, i) => a[i - 1] === "--disable" ? [x] : []);
    for (const f of ["shell_tool", "unified_exec", "unified_exec_tty", "multi_agent", "multi_agent_v2", "view_image", "image_generation", "plugins", "remote_plugin", "skill_search", "hooks", "goals", "sleep_tool",
      "apps", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "tool_suggest", "memories", "code_mode_host", "workspace_dependencies", "shell_snapshot", "skill_mcp_dependency_install", "tool_call_mcp_elicitation", "enable_mcp_apps", "standalone_web_search", "request_permissions_tool"])
      expect(off).toContain(f);
    expect(off).toEqual([...CODEX_DISABLED_FEATURES]);
    const cs = a.flatMap((x, i) => a[i - 1] === "-c" ? [x] : []);
    expect(cs).toEqual(expect.arrayContaining(['approval_policy="never"', 'web_search="disabled"', "mcp_servers={}", 'shell_environment_policy.inherit="none"', 'history.persistence="none"', "project_doc_max_bytes=0"]));
    expect(a[a.indexOf("-s") + 1]).toBe("read-only");
  });
  test("the model catalog is the CLI's bundled one (read with no login), patched: no multi-agent role, direct tool mode, no experimental tools", async () => {
    const f = fake("codex", [codexOk("A")]);
    await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    const cat = JSON.parse(f.rec("catalog")).models;
    expect(cat.length).toBe(5);
    for (const m of cat) expect(m).toEqual({ slug: m.slug, multi_agent_version: null, tool_mode: "direct", experimental_supported_tools: [], apply_patch_tool_type: null,
      default_service_tier: null, service_tiers: [], additional_speed_tiers: [], base_instructions: "B" });
    const dbg = readFileSync(join(f.d, "debuglog"), "utf8");
    expect(dbg).not.toContain("auth.json");
    const a = f.rec("args").trim().split("\n");
    const cs = a.flatMap((x, i) => a[i - 1] === "-c" ? [x] : []);
    expect(cs.some((c) => /^model_catalog_json=".+catalog\.json"$/.test(c))).toBe(true);
    for (const k of ["skills.include_instructions=false", "skills.bundled.enabled=false", "include_environment_context=false", "include_permissions_instructions=false", "include_collaboration_mode_instructions=false", "include_apps_instructions=false", "tools.experimental_request_user_input.enabled=false"]) expect(cs).toContain(k);
  });
  test("N2: a CLI model missing from the catalog with no base entry is a hard error before any call", async () => {
    const f = fake("codex", [codexOk("A")]);
    const e = await callCodexGen({ cliModel: "not-in-catalog", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:isolation_failed");
    expect(e.message).toMatch(/not in the Codex model catalog/);
    expect(f.calls()).toBe(0);
    const g = fake("codex", [codexOk("A")]);
    const e2 = await callCodexGen({ cliModel: "not-in-catalog", catalogBase: "also-missing", effort: "medium", instructions: "S", input: user("q") }, { env: g.env, ...noSleep }).catch((x) => x);
    expect(e2.reason).toBe("access:isolation_failed");
    expect(g.calls()).toBe(0);
  });
  test("N5: the standard service tier is requested explicitly; fast modes off; the result records it", async () => {
    const f = fake("codex", [codexOk("A")]);
    const r = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    const a = f.rec("args").trim().split("\n");
    expect(a).toContain('service_tier="default"');
    const off = a.flatMap((x, i) => a[i - 1] === "--disable" ? [x] : []);
    expect(off).toEqual(expect.arrayContaining(["fast_mode", "ultrafast_mode"]));
    expect(r.service_tier).toBe("default");
    expect(r.service_tier_reported).toBeNull();
  });
  test("N5: a reported service tier other than the standard one fails the call", async () => {
    const f = fake("codex", [], { out: codexOk("A").replace('"turn.completed","usage":{', '"turn.completed","service_tier":"priority","usage":{') });
    const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:service_tier_mismatch");
    const g = fake("codex", [], { out: codexOk("A").replace('"turn.completed","usage":{', '"turn.completed","service_tier":"default","usage":{') });
    expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: g.env, ...noSleep })).service_tier_reported).toBe("default");
  });
  test("N2: a fallback-metadata notice from Codex at run time is a hard error, not a warning", async () => {
    const f = fake("codex", [], { out: codexOk("A").replace("features.skills is ignored", "Model metadata for `m` not found. Defaulting to fallback metadata; this can degrade performance") });
    const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:isolation_failed");
    expect(f.calls()).toBe(1);
  });
  test("N2: a model missing from the catalog gets a patched copy of its base entry under its own slug", async () => {
    const f = fake("codex", [codexOk("A")]);
    const r = await callCodexGen({ cliModel: "gpt-new", catalogBase: "gpt-6.1-sol", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    expect((r.cli_warnings ?? []).filter((w) => /metadata|catalog/i.test(w))).toEqual([]);
    const cat = JSON.parse(f.rec("catalog")).models;
    const base = cat.find((m: any) => m.slug === "gpt-6.1-sol"), mine = cat.find((m: any) => m.slug === "gpt-new");
    expect(mine).toEqual({ ...base, slug: "gpt-new", display_name: "gpt-new" });
    expect(mine).toMatchObject({ multi_agent_version: null, tool_mode: "direct", experimental_supported_tools: [], apply_patch_tool_type: null });
  });
  test("CODEX_HOME and HOME are a fresh temp dir holding only a mode-600 copy of auth.json, removed after the call; cwd outside HOME", async () => {
    const f = fake("codex", [codexOk("A")]);
    await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    expect(f.rec("codexhome").trim().split("\n").sort()).toEqual(["auth.json", "catalog.json"]);
    expect(f.rec("authmode").trim()).toBe("600");
    expect(f.rec("auth")).toContain("FAKE");
    const ch = f.rec("codexhomepath").trim();
    expect(ch.startsWith(f.home)).toBe(false);
    expect(existsSync(ch)).toBe(false);
    expect(f.rec("env")).toContain(`HOME=${ch}\n`);
    expect(f.rec("env")).toContain(`CODEX_HOME=${ch}\n`);
    expect(f.rec("cwd").trim().startsWith(f.home)).toBe(false);
  });
  test("no Codex login: fails access:no_login without a call", async () => {
    const f = fake("codex", [codexOk("A")]);
    const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: { ...f.env, HOME: "/nonexistent-home" }, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:no_login");
    expect(f.calls()).toBe(0);
  });
  for (const item of ['{"id":"i","type":"command_execution","command":"ls ~","status":"completed","aggregated_output":"x"}', '{"id":"i","type":"web_search","query":"q"}',
    '{"id":"i","type":"mcp_tool_call","tool":"t"}', '{"id":"i","type":"file_change","changes":[]}', '{"id":"i","type":"collab_tool_call","tool":"spawn_agent"}', '{"id":"i","type":"something_new"}'])
    test(`a tool or unknown item fails the cell access:tool_use_detected, not retried, raw events kept: ${JSON.parse(item).type}`, async () => {
      const f = fake("codex", [], { out: codexOk("ANSWER", `{"type":"item.started","item":${item}}\n{"type":"item.completed","item":${item}}`) });
      const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
      expect(e.reason).toBe("access:tool_use_detected");
      expect(e.retryable).toBe(false);
      expect(f.calls()).toBe(1);
      expect(JSON.stringify(e.events)).toContain(JSON.parse(item).type);
    });
  test("an unknown top-level event type fails too; reasoning items pass", async () => {
    const f = fake("codex", [], { out: codexOk("A", '{"type":"exec_approval_request","x":1}') });
    expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x)).reason).toBe("access:tool_use_detected");
    const g = fake("codex", [codexOk("A", '{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"thinking"}}')]);
    expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "S", input: user("q") }, { env: g.env, ...noSleep })).text).toBe("A");
  });
  test("clean config: instructions file replaces the base prompt, effort explicit, no web, empty cwd, keys scrubbed, chatter kept out of the answer", async () => {
    const f = fake("codex", [codexOk("ANSWER")]);
    const r = await callCodexGen({ cliModel: "gpt-x", effort: "medium", instructions: "SYSTEM PROMPT", input: user("TASK TEXT") }, { env: f.env, ...noSleep });
    const args = f.rec("args").trim().split("\n");
    for (const a of ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) expect(args).toContain(a);
    const cs = args.flatMap((a, i) => args[i - 1] === "-c" ? [a] : []);
    expect(cs).toEqual(expect.arrayContaining(['approval_policy="never"', 'web_search="disabled"', 'model_reasoning_effort="medium"']));
    expect(cs.some((c) => /^model_instructions_file=".+"$/.test(c))).toBe(true);
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-x");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args.at(-1)).toBe("-");
    expect(f.rec("instr")).toBe("SYSTEM PROMPT");
    expect(f.rec("stdin")).toBe("TASK TEXT");
    expect(f.rec("stdin")).not.toContain("SYSTEM PROMPT");
    expect(f.rec("cwdcount").trim()).toBe("0");
    expect(r).toMatchObject({ text: "ANSWER", outcome: "ok", provider: null, usd: 0, billing: "subscription", access: "codex-cli", wrapper: "codex-cli 9.9.9", cli_model: "gpt-x", effort: "medium",
      usage: { input_tokens: 7012, output_tokens: 420, reasoning_tokens: 300 }, reported: { model: null, input_tokens: 7012, cached_input_tokens: 3000, output_tokens: 420, reasoning_tokens: 300 } });
    expect(r.cli_warnings).toEqual(["features.skills is ignored"]);
    expect(r.text).not.toContain("metadata");
  });
  test("a repair turn flattens only the conversation (no instructions) into stdin", async () => {
    const f = fake("codex", [codexOk("fixed")]);
    await callCodexGen({ cliModel: "m", effort: "medium", instructions: "SYS", input: [{ role: "user", content: "U1" }, { role: "assistant", content: "A1" }, { role: "user", content: "U2" }] }, { env: f.env, ...noSleep });
    const s = f.rec("stdin");
    expect(s.indexOf("U1")).toBeLessThan(s.indexOf("A1"));
    expect(s.indexOf("A1")).toBeLessThan(s.indexOf("U2"));
    expect(s).not.toContain("SYS");
  });
  test("empty agent message is outcome empty; no agent message at all is a fault", async () => {
    const f = fake("codex", [codexOk("  ")]);
    expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, ...noSleep })).outcome).toBe("empty");
    const g = fake("codex", [], { out: '{"type":"turn.completed","usage":{}}\n' });
    await expect(callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: g.env, ...noSleep })).rejects.toThrow(/no agent message/);
  });
  test("usage-limit error retries with backoff, then fails with access:subscription_limit (never another path)", async () => {
    const f = fake("codex", [], { out: '{"type":"error","message":"You\'ve hit your usage limit. Try again in 3 hours."}\n', code: 1 });
    const waits: number[] = [];
    const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, sleep: async (ms) => { waits.push(ms); }, backoffMs: [5, 10, 20] }).catch((x) => x);
    expect(e.reason).toBe("access:subscription_limit");
    expect(e.retryable).toBe(true);
    expect(waits).toEqual([5, 10, 20]);
    expect(f.calls()).toBe(4);
  });
  test("a limit that clears on retry succeeds", async () => {
    const f = fake("codex", [{ out: '{"type":"turn.failed","error":{"message":"rate limit exceeded"}}\n', code: 1 }, codexOk("ok")]);
    expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, ...noSleep })).text).toBe("ok");
  });
  test("other non-zero exit retries once, then throws access:cli_error with tails", async () => {
    const f = fake("codex", [], { err: "boom", code: 2 });
    const e = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:cli_error");
    expect(String(e.message)).toContain("boom");
    expect(f.calls()).toBe(2);
  });
});

const claudeOut = (o: Record<string, unknown> = {}, s: Parameters<typeof claudeStream>[1] = {}) => claudeStream({ type: "result", subtype: "success", is_error: false, result: "ANSWER", stop_reason: "end_turn", total_cost_usd: 0.0123,
  usage: { input_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 10000, output_tokens: 900, output_tokens_details: { thinking_tokens: 500 } },
  modelUsage: { "claude-x-5-5": { inputTokens: 5, outputTokens: 900, thinkingTokens: 500, costUSD: 0.0123, canonicalModel: "claude-x-5-5", provider: "firstParty", costBasis: "list" } }, ...o }, s);

describe("callClaudeGen", () => {
  test("stream-json, no tools, empty MCP config, no setting sources, safe mode, no slash commands; env switches off memory, CLAUDE.md, advisor, telemetry", async () => {
    const a = buildClaudeGenArgs("m", "high", "/i.md");
    expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    for (const f of ["--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) expect(a).toContain(f);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(CLAUDE_FIXED_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1" });
    const f = fake("claude", [claudeOut()]);
    await callClaudeGen({ cliModel: "m", effort: "high", instructions: "S", input: user("q") }, { env: f.env, ...noSleep });
    for (const [k, v] of Object.entries(CLAUDE_FIXED_ENV)) expect(f.rec("env")).toContain(`${k}=${v}\n`);
  });
  const isolationCases: [string, Parameters<typeof claudeStream>[1], string][] = [
    ["a tool_use block", { extra: [{ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls ~" } }] } }] }, "access:tool_use_detected"],
    ["a server tool block", { extra: [{ type: "assistant", message: { content: [{ type: "server_tool_use", id: "t", name: "advisor" }] } }] }, "access:tool_use_detected"],
    ["a tool result (user event)", { extra: [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }] }, "access:tool_use_detected"],
    ["an unknown event type", { extra: [{ type: "brand_new_event" }] }, "access:tool_use_detected"],
    ["init lists a tool", { init: { tools: ["Bash"] } }, "access:isolation_failed"],
    ["init lists an MCP server", { init: { mcp_servers: [{ name: "x", status: "connected" }] } }, "access:isolation_failed"],
    ["init uses an API key", { init: { apiKeySource: "ANTHROPIC_API_KEY" } }, "access:api_key_in_use"],
  ];
  for (const [name, so, reason] of isolationCases)
    test(`${name} fails the call ${reason}, not retried, raw events kept`, async () => {
      const f = fake("claude", [], { out: claudeOut({}, so) });
      const e = await callClaudeGen({ cliModel: "m", effort: "high", instructions: "S", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
      expect(e.reason).toBe(reason);
      expect(f.calls()).toBe(1);
      expect(Array.isArray(e.events)).toBe(true);
    });
  test("N4: init without tools, mcp_servers or apiKeySource (missing or renamed) fails closed", async () => {
    for (const drop of ["tools", "mcp_servers", "apiKeySource"]) {
      const out = claudeOut().split("\n").map((l) => { if (!l) return l; const x = JSON.parse(l); if (x.subtype === "init") delete x[drop]; return JSON.stringify(x); }).join("\n");
      const g = fake("claude", [out]);
      const e = await callClaudeGen({ cliModel: "m", effort: "high", instructions: "S", input: user("q") }, { env: g.env, ...noSleep }).catch((x) => x);
      expect([drop, e.reason]).toEqual([drop, "access:isolation_failed"]);
    }
    const h = fake("claude", [claudeOut().replace('"tools":[]', '"tools":{}')]);
    expect((await callClaudeGen({ cliModel: "m", effort: "high", instructions: "S", input: user("q") }, { env: h.env, ...noSleep }).catch((x) => x)).reason).toBe("access:isolation_failed");
  });
  test("permission denials in the result fail as tool use; a result without init fails as isolation_failed", async () => {
    const f = fake("claude", [], { out: claudeOut({ permission_denials: [{ tool_name: "Bash" }] }) });
    expect((await callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x)).reason).toBe("access:tool_use_detected");
    const g = fake("claude", [], { out: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x" }) + "\n" });
    expect((await callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: g.env, ...noSleep }).catch((x) => x)).reason).toBe("access:isolation_failed");
  });
  test("print mode, no tools, no MCP, no settings, system prompt file replaces the default, explicit effort, empty cwd, keys scrubbed", async () => {
    const f = fake("claude", [claudeOut()]);
    const r = await callClaudeGen({ cliModel: "claude-x-5-5", effort: "high", instructions: "SYSTEM PROMPT", input: user("TASK TEXT") }, { env: f.env, ...noSleep });
    const args = f.rec("args").split("\n").slice(0, -1);
    expect(args[0]).toBe("-p");
    for (const a of ["--strict-mcp-config", "--no-session-persistence", "--safe-mode", "--disable-slash-commands"]) expect(args).toContain(a);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-x-5-5");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--system-prompt");
    expect(f.rec("instr")).toBe("SYSTEM PROMPT");
    expect(f.rec("stdin")).toBe("TASK TEXT");
    expect(f.rec("cwdcount").trim()).toBe("0");
    expect(r).toMatchObject({ text: "ANSWER", outcome: "ok", provider: null, usd: 0, list_usd: 0.0123, billing: "subscription", access: "claude-cli", wrapper: "claude-code 9.9.9", cli_model: "claude-x-5-5", effort: "high", model: "claude-x-5-5",
      usage: { input_tokens: 10605, output_tokens: 900, reasoning_tokens: 500 },
      reported: { model: "claude-x-5-5", provider: "firstParty", input_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 10000, output_tokens: 900, reasoning_tokens: 500 } });
  });
  test("chatter before the JSON is ignored", async () => {
    const f = fake("claude", ["Warning: something\n" + claudeOut()]);
    expect((await callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep })).text).toBe("ANSWER");
  });
  test("refusal, truncation and empty answer are outcomes", async () => {
    const run = async (o: Record<string, unknown>) => { const f = fake("claude", [claudeOut(o)]); return callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep }); };
    expect((await run({ stop_reason: "refusal", result: "I can't help" })).outcome).toBe("refusal");
    expect((await run({ stop_reason: "max_tokens" })).outcome).toBe("truncated");
    expect((await run({ result: "" })).outcome).toBe("empty");
  });
  test("usage-window message retries with backoff then fails access:subscription_limit", async () => {
    const f = fake("claude", [], { out: claudeOut({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1762000000" }), code: 1 });
    const e = await callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:subscription_limit");
    expect(f.calls()).toBe(4);
  });
  test("non-JSON output throws access:cli_error after one retry", async () => {
    const f = fake("claude", [], { out: "not json", code: 0 });
    const e = await callClaudeGen({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep }).catch((x) => x);
    expect(e.reason).toBe("access:cli_error");
    expect(f.calls()).toBe(2);
  });
});

test("cliWrapper reads the version once per binary", async () => {
  const f = fake("codex", []);
  expect(await cliWrapper("codex-cli", f.env)).toBe("codex-cli 9.9.9");
  const g = fake("claude", []);
  expect(await cliWrapper("claude-cli", g.env)).toBe("claude-code 9.9.9");
});

describe("M4: timeouts kill the whole process group", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const bin of ["codex", "claude"] as const)
    test(`${bin}: a hung call times out and its child process dies too`, async () => {
      const f = fake(bin, [], { out: "" });
      writeFileSync(join(f.d, "hang"), "");
      const t0 = performance.now();
      const call = bin === "codex" ? callCodexGen : callClaudeGen;
      const e = await call({ cliModel: "m", effort: "high", instructions: "", input: user("q") }, { env: f.env, ...noSleep, timeoutMs: 400 }).catch((x) => x);
      expect(String(e.message)).toMatch(/timed out/);
      expect(performance.now() - t0).toBeLessThan(6000);
      await Bun.sleep(200);
      for (let n = 1; n <= f.calls(); n++) expect(alive(Number(f.rec("childpid", n)))).toBe(false);
    }, 20_000);
});

test("M4: a large answer (over the pipe buffer) is read in full", async () => {
  const big = "x".repeat(300_000);
  const f = fake("codex", [codexOk(big)]);
  expect((await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, ...noSleep, timeoutMs: 10_000 })).text.length).toBe(300_000);
});

describe("M1: overage", () => {
  const qc = { cliModel: "m", effort: "high", instructions: "", input: user("q") };
  test("claude rate-limit info is recorded; overage off passes", async () => {
    const f = fake("claude", [claudeOut()]);
    const r = await callClaudeGen(qc, { env: f.env, ...noSleep });
    expect(r.reported).toMatchObject({ rate_limit: [{ status: "allowed", overageStatus: "rejected", isUsingOverage: false }] });
    expect(r.billing).toBe("subscription");
  });
  for (const [name, so, res] of [["isUsingOverage true", { rateLimit: { isUsingOverage: true } }, {}], ["a fallback credit used", {}, { usage: { input_tokens: 1, output_tokens: 1, fallback_credit: { used: 1 } } }]] as const)
    test(`claude: ${name} fails the call access:possible_overage with billing unknown, not retried`, async () => {
      const f = fake("claude", [], { out: claudeOut(res as Record<string, unknown>, so as Parameters<typeof claudeStream>[1]) });
      const e = await callClaudeGen(qc, { env: f.env, ...noSleep }).catch((x) => x);
      expect(e).toMatchObject({ reason: "access:possible_overage", billing: "unknown" });
      expect(f.calls()).toBe(1);
    });
  test("account status: read-only login commands, no email, plan type from the login", async () => {
    const cx = fake("codex", ["Logged in using ChatGPT\n"]);
    const cc = fake("claude", [JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.c", orgId: "o", orgName: "N", subscriptionType: "max" })]);
    const st = await cliAccountStatus({ ...cx.env, ...cc.env, PATH: `${cx.binDir}:${cc.binDir}:${process.env.PATH}` });
    expect(cx.rec("args").trim().split("\n")).toEqual(["login", "status"]);
    expect(cc.rec("args").trim().split("\n")).toEqual(["auth", "status", "--json"]);
    expect(st.claude).toEqual({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
    expect(st.codex).toMatchObject({ login: "Logged in using ChatGPT" });
    expect(JSON.stringify(st)).not.toContain("a@b.c");
    expect(st.detectable).toBeDefined();
  });
});

test("M6: Codex reasoning tokens: the reported value (0 stays 0), null when the field is absent; model and effort never confirmed", async () => {
  const f = fake("codex", [codexOk("A")]);
  const r = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: f.env, ...noSleep });
  expect(r).toMatchObject({ effort_confirmed: null, model_served: null, usage: { reasoning_tokens: 300 } });
  const g = fake("codex", ['{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"A"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n']);
  const s = await callCodexGen({ cliModel: "m", effort: "medium", instructions: "", input: user("q") }, { env: g.env, ...noSleep });
  expect(s.usage.reasoning_tokens).toBeNull();
  expect(s.reported.reasoning_tokens).toBeNull();
});
