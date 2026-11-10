import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, callClaude, claudeAnalystPrompt, claudeVersion, parseClaudeResult } from "./claude-cli";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analystCall } from "./analyst";

const fixture = await Bun.file(new URL("./fixtures/claude-result.json", import.meta.url)).text();

describe("parseClaudeResult", () => {
  test("extracts text, model id, summed input tokens, cost", () => {
    const r = parseClaudeResult(fixture, 1234);
    expect(r.text).toBe("OK");
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.usage).toEqual({ input_tokens: 642, output_tokens: 4 });
    expect(r.usd).toBeCloseTo(0.0001302, 9);
    expect(r.latency_ms).toBe(1234);
  });

  test("throws on is_error", () => {
    const bad = JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "boom" });
    expect(() => parseClaudeResult(bad, 1)).toThrow(/claude -p failed.*boom/);
  });

  test("throws on non-JSON stdout", () => {
    expect(() => parseClaudeResult("not json", 1)).toThrow(/not JSON/);
  });
  test("throws on empty assistant text", () => {
    expect(() => parseClaudeResult(JSON.stringify({ ...JSON.parse(fixture), result: "" }), 1)).toThrow(/empty assistant text/);
  });
  test("leaves cost absent when CLI omits total_cost_usd", () => {
    const j = JSON.parse(fixture);
    delete j.total_cost_usd;
    expect(parseClaudeResult(JSON.stringify(j), 1).usd).toBeUndefined();
  });
});

describe("buildClaudeArgs", () => {
  test("isolates the call: no tools, no MCP, no settings, no session", () => {
    const a = buildClaudeArgs({ model: "claude-haiku-5-5", system: "S" });
    expect(a.slice(0, 5)).toEqual(["-p", "--model", "claude-haiku-5-5", "--output-format", "json"]);
    for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--safe-mode", "--disable-slash-commands"]) expect(a).toContain(flag);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a[a.indexOf("--system-prompt") + 1]).toBe("S");
  });
  test("keeps the isolation flags in the recorded argv", () => {
    const args = buildClaudeArgs({ model: "claude-haiku-5-5", system: "SYSTEM" });
    expect(args).toEqual(["-p", "--model", "claude-haiku-5-5", "--output-format", "json",
      "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
      "--safe-mode", "--disable-slash-commands", "--system-prompt", "SYSTEM"]);
  });
});

describe("callClaude", () => {
  test("retries a transient non-zero exit once", async () => {
    let calls = 0;
    const r = await callClaude({ model: "m", prompt: "p" }, { run: async () => {
      calls++;
      return calls === 1 ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: fixture, stderr: "" };
    } });
    expect(calls).toBe(2);
    expect(r.text).toBe("OK");
  });

  test("retries a retryable is_error once", async () => {
    let calls = 0;
    const r = await callClaude({ model: "m", prompt: "p" }, { run: async () => {
      calls++;
      return { code: 0, stdout: calls === 1
        ? JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "rate limit exceeded" })
        : fixture, stderr: "" };
    } });
    expect(calls).toBe(2);
    expect(r.text).toBe("OK");
  });
  test("writes prompt to stdin of the spawned process", async () => {
    let stdinSeen = "";
    const r = await callClaude(
      { model: "claude-haiku-5-5", prompt: "PROMPT" },
      {
        run: async (_args, stdin) => {
          stdinSeen = stdin;
          return { code: 0, stdout: fixture, stderr: "" };
        },
      },
    );
    expect(stdinSeen).toBe("PROMPT");
    expect(r.text).toBe("OK");
  });

  test("throws with stderr on non-zero exit", async () => {
    await expect(
      callClaude({ model: "m", prompt: "p" }, { run: async () => ({ code: 1, stdout: "", stderr: "auth expired" }) }),
    ).rejects.toThrow(/exit 1.*auth expired/);
  });
});

test("claudeVersion reads the CLI version", async () => {
  expect(await claudeVersion(async () => ({ code: 0, stdout: "2.1.318 (Claude Code)\n", stderr: "" }))).toBe("2.1.318 (Claude Code)");
});

test("Claude Analyst uses isolated CLI, raw text, served model, usage, and version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const binary = new URL("./fixtures/fake-claude.sh", import.meta.url).pathname;
  const resultPath = join(dir, "result.json");
  const argsPath = join(dir, "args.txt");
  const stdinPath = join(dir, "stdin.txt");
  writeFileSync(resultPath, JSON.stringify({ ...JSON.parse(fixture), result: '```json\n{"id":"CR-1"}\n```' }));
  const run = async (args: string[], stdin: string) => {
    const p = Bun.spawn(["bash", binary, ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, FAKE_CLAUDE_ARGS: argsPath, FAKE_CLAUDE_STDIN: stdinPath, FAKE_CLAUDE_RESULT: resultPath } });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };
  try {
    const llm = await analystCall("claude:claude-opus-5-5", { claudeRun: run });
    const r = await llm("SYSTEM", [{ role: "user", content: "USER" }]);
    expect(r.text).toBe('```json\n{"id":"CR-1"}\n```');
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.usage).toEqual({ input_tokens: 642, output_tokens: 4 });
    expect(readFileSync(stdinPath, "utf8")).toBe("USER");
    const args = readFileSync(argsPath, "utf8").trimEnd().split("\n");
    expect(args).toEqual(buildClaudeArgs({ model: "claude-opus-5-5", system: "SYSTEM" }));
    expect(await claudeVersion(run)).toBe("2.1.318 (Claude Code)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Analyst keeps prior turns in order without moving instructions into user text", () => {
  expect(claudeAnalystPrompt([{ role: "user", content: "U1" }, { role: "assistant", content: "A1" }, { role: "user", content: "U2" }]))
    .toBe("<user>\nU1\n</user>\n\n<assistant>\nA1\n</assistant>\n\n<user>\nU2\n</user>\n\nReply to the last user message as the assistant.");
});
