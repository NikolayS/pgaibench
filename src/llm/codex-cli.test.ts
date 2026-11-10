import { describe, expect, test } from "bun:test";
import { buildCodexArgs, callCodex, flattenConversation, parseCodexEvents } from "./codex-cli";

const fixture = await Bun.file(new URL("./fixtures/codex-events.jsonl", import.meta.url)).text();

describe("parseCodexEvents", () => {
  test("last agent message, usage incl. cached, requested model tagged", () => {
    const r = parseCodexEvents(fixture, "gpt-6-sol", 9);
    expect(r.text).toBe("OK.");
    expect(r.model).toBe("gpt-6-sol (codex exec, requested)");
    expect(r.usage).toEqual({ input_tokens: 16519, output_tokens: 6, reasoning_tokens: 0 });
  });
  test("throws on error event", () => {
    expect(() => parseCodexEvents('{"type":"error","message":"usage limit"}\n', "m", 1)).toThrow(/usage limit/);
  });
  test("throws when no agent message", () => {
    expect(() => parseCodexEvents('{"type":"turn.completed","usage":{}}\n', "m", 1)).toThrow(/no agent message/);
  });
});

describe("flattenConversation", () => {
  test("renders instructions then messages in order", () => {
    const s = flattenConversation("INS", [{ role: "user", content: "U1" }, { role: "assistant", content: "A1" }, { role: "user", content: "U2" }]);
    expect(s.indexOf("INS")).toBeLessThan(s.indexOf("U1"));
    expect(s.indexOf("A1")).toBeLessThan(s.indexOf("U2"));
    expect(s).toContain("Reply to the last user message");
  });
});

describe("buildCodexArgs / callCodex", () => {
  test("isolated read-only ephemeral run", () => {
    const a = buildCodexArgs("gpt-6-sol", "/tmp/x");
    for (const f of ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) expect(a).toContain(f);
    expect(a[a.indexOf("-c") + 1]).toBe('approval_policy="never"');
    expect(a[a.indexOf("-s") + 1]).toBe("read-only");
    expect(a[a.indexOf("-m") + 1]).toBe("gpt-6-sol");
    expect(a.at(-1)).toBe("-");
  });
  test("non-zero exit retries once, then throws with stderr and stdout tails", async () => {
    let calls = 0;
    await expect(callCodex({ model: "m", instructions: "", input: [] }, { run: async () => { calls++; return { code: 2, stdout: '{"type":"error","message":"quota"}', stderr: "not logged in" }; } })).rejects.toThrow(/not logged in.*quota/s);
    expect(calls).toBe(2);
  });
  test("non-zero exit succeeds on retry", async () => {
    let calls = 0;
    const ok = '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n';
    const r = await callCodex({ model: "m", instructions: "", input: [] }, { run: async () => (++calls === 1 ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: ok, stderr: "" }) });
    expect(r.text).toBe("hi");
    expect(calls).toBe(2);
  });
});

import { codexVersion } from "./codex-cli";
test("codexVersion parses `codex --version`", async () => {
  expect(await codexVersion(async () => ({ code: 0, stdout: "codex-cli 0.164.0\n", stderr: "" }))).toBe("codex-cli 0.164.0");
});
