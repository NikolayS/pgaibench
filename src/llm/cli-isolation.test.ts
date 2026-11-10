// Offline isolation checks of the CLI path against fake binaries. No model call.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fake, cleanupTmp } from "./fake-cli-helper";
import { codexOfferedTools } from "./cli-isolation";

afterAll(cleanupTmp);

const body = (tools: unknown[], extra: unknown[] = []) => JSON.stringify({ model: "m", tools, input: [...extra, { type: "message", role: "user", content: [] }] });

describe("N1: the Codex request carries no tools (offline capture)", () => {
  test("the repo argv runs against a local capture endpoint with a fake API-key home; an empty list passes", async () => {
    const f = fake("codex", []);
    const r = await codexOfferedTools({ cliModel: "m", effort: "medium" }, f.env);
    expect(r.tools).toEqual([]);
    const a = readFileSync(join(f.d, "capargs"), "utf8").trim().split("\n");
    expect(a).toContain("exec");
    expect(a.some((x) => /^openai_base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/.test(x))).toBe(true);
    expect(a).toContain("tools.experimental_request_user_input.enabled=false");
    expect(readFileSync(join(f.d, "capauth"), "utf8")).toContain('"auth_mode":"apikey"');
    expect(readFileSync(join(f.d, "capauth"), "utf8")).not.toContain("FAKE"); // never the real login
    expect(readFileSync(join(f.d, "capenv"), "utf8")).toContain("HTTPS_PROXY=http://127.0.0.1:9\n");
    expect(f.calls()).toBe(0);
  });
  test("tools at the top level and in additional_tools input items are listed by name", async () => {
    const f = fake("codex", []);
    writeFileSync(join(f.d, "capture.body"), body([{ type: "function", name: "exec" }], [{ type: "additional_tools", role: "developer",
      tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "request_user_input" }, { type: "custom", name: "apply_patch" }] }] }]));
    const r = await codexOfferedTools({ cliModel: "m", effort: "medium" }, f.env);
    expect(r.tools).toEqual(["exec", "functions.request_user_input", "functions.apply_patch"]);
  });
  test("no captured request fails closed", async () => {
    const f = fake("codex", []);
    writeFileSync(join(f.d, "capture.none"), "");
    const e = await codexOfferedTools({ cliModel: "m", effort: "medium" }, f.env).catch((x) => x);
    expect(e.reason).toBe("access:isolation_failed");
  });
});

test("N1: codexToolFree throws access:isolation_failed naming the tools when any is offered", async () => {
  const { codexToolFree } = await import("./cli-isolation");
  const f = fake("codex", []);
  expect((await codexToolFree({ cliModel: "m", effort: "medium" }, f.env)).tools).toEqual([]);
  writeFileSync(join(f.d, "capture.body"), body([{ type: "custom", name: "apply_patch" }]));
  const e = await codexToolFree({ cliModel: "m", effort: "medium" }, f.env).catch((x) => x);
  expect(e.reason).toBe("access:isolation_failed");
  expect(e.message).toContain("apply_patch");
});

test("N5: codexToolFree fails when the offline request carries a service tier", async () => {
  const { codexToolFree } = await import("./cli-isolation");
  const f = fake("codex", []);
  writeFileSync(join(f.d, "capture.body"), JSON.stringify({ model: "m", tools: [], service_tier: "priority", input: [] }));
  const e = await codexToolFree({ cliModel: "m", effort: "medium" }, f.env).catch((x) => x);
  expect(e.reason).toBe("access:isolation_failed");
  expect(e.message).toContain("priority");
});

describe("N4: tested CLI versions and the known Codex feature list", () => {
  const tested = { codex: ["9.9.9"], claude: ["9.9.9"], codex_features: ["shell_tool", "fast_mode"] };
  test("tested versions pass; an untested version fails before any call unless allowed", async () => {
    const { cliVersionGate } = await import("./cli-isolation");
    const f = fake("codex", []), g = fake("claude", []);
    const env = { ...f.env, ...g.env, PATH: `${f.binDir}:${g.binDir}:${process.env.PATH}` };
    expect(await cliVersionGate(["codex-cli", "claude-cli"], env, { tested })).toEqual({ untested: [] });
    const e = await cliVersionGate(["codex-cli", "claude-cli"], env, { tested: { ...tested, claude: ["2.1.322"] } }).catch((x) => x);
    expect(e.message).toMatch(/claude-code 9\.9\.9 is not a tested version \(2\.1\.322\).*--allow-untested-cli/);
    expect(await cliVersionGate(["codex-cli", "claude-cli"], env, { tested: { ...tested, claude: ["2.1.322"] }, allowUntested: true })).toEqual({ untested: ["claude-code 9.9.9"] });
    expect(f.calls() + g.calls()).toBe(0);
  });
  test("a Codex feature that is not on the known list fails, even with untested versions allowed", async () => {
    const { cliVersionGate } = await import("./cli-isolation");
    const f = fake("codex", []);
    writeFileSync(join(f.d, "features"), "shell_tool  stable  true\nnew_tool_feature  experimental  false\n");
    for (const allowUntested of [false, true]) {
      const e = await cliVersionGate(["codex-cli"], f.env, { tested, allowUntested }).catch((x) => x);
      expect(e.message).toMatch(/unknown Codex features: new_tool_feature/);
    }
  });
  test("an empty or unreadable features list fails closed", async () => {
    const { cliVersionGate } = await import("./cli-isolation");
    const f = fake("codex", []);
    writeFileSync(join(f.d, "features"), "");
    expect((await cliVersionGate(["codex-cli"], f.env, { tested }).catch((x) => x)).message).toMatch(/features list/);
  });
  test("the repo list holds the 0.164.0 / 2.1.322 versions and the disabled features", async () => {
    const t = (await import("./cli-tested.json")).default;
    expect(t.codex).toEqual(["0.164.0"]); expect(t.claude).toEqual(["2.1.322"]);
    const { CODEX_DISABLED_FEATURES } = await import("./cli-gen");
    for (const x of CODEX_DISABLED_FEATURES) expect(t.codex_features).toContain(x);
  });
});

describe("effort confirmation in the offline capture", () => {
  test("the captured reasoning.effort and text.verbosity are read; a match passes", async () => {
    const { codexToolFree } = await import("./cli-isolation");
    const f = fake("codex", []);
    writeFileSync(join(f.d, "capture.body"), JSON.stringify({ model: "m", tools: [], reasoning: { effort: "high" }, text: { verbosity: "low" }, input: [] }));
    const r = await codexToolFree({ cliModel: "m", effort: "high" }, f.env);
    expect(r).toMatchObject({ reasoning_effort: "high", text_verbosity: "low" });
  });
  test("the default fake capture echoes the requested effort", async () => {
    const f = fake("codex", []);
    expect((await codexOfferedTools({ cliModel: "m", effort: "low" }, f.env)).reasoning_effort).toBe("low");
  });
  test("a different or missing effort on the wire fails closed", async () => {
    const { codexToolFree } = await import("./cli-isolation");
    const f = fake("codex", []);
    writeFileSync(join(f.d, "capture.body"), JSON.stringify({ model: "m", tools: [], reasoning: { effort: "low" }, input: [] }));
    const e = await codexToolFree({ cliModel: "m", effort: "medium" }, f.env).catch((x) => x);
    expect(e.reason).toBe("access:isolation_failed");
    expect(e.message).toContain("reasoning.effort low");
    writeFileSync(join(f.d, "capture.body"), JSON.stringify({ model: "m", tools: [], input: [] }));
    const e2 = await codexToolFree({ cliModel: "m", effort: "medium" }, f.env).catch((x) => x);
    expect(e2.reason).toBe("access:isolation_failed");
  });
});
