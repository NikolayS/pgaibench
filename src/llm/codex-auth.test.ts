// N3: write-back of a Codex login the CLI refreshed in the temporary copy. Fake CLI only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, cleanupTmp, trackTmp } from "./fake-cli-helper";
import { callCodexGen } from "./cli-gen";

afterAll(cleanupTmp);

const ok = ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"A"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'].join("\n") + "\n";
const q = { cliModel: "m", effort: "medium", instructions: "S", input: [{ role: "user" as const, content: "q" }] };
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const setup = () => {
  const f = fake("codex", [ok, ok, ok]);
  const src = join(f.home, ".codex", "auth.json"), stash = trackTmp("gen-stash-");
  writeFileSync(join(f.d, "sourcepath"), src);
  const o = { env: f.env, sleep: async () => {}, backoffMs: [1], codexLoginStash: stash };
  return { f, src, stash, o, orig: readFileSync(src, "utf8") };
};

describe("N3: Codex login refreshed by the CLI", () => {
  test("unchanged copy: the real login is not touched, no backup", async () => {
    const { src, o, orig } = setup();
    const before = statSync(src).mtimeMs;
    await callCodexGen(q, o);
    expect(readFileSync(src, "utf8")).toBe(orig);
    expect(statSync(src).mtimeMs).toBe(before);
    expect(existsSync(src + ".pgaibench-bak")).toBe(false);
  });
  test("refreshed copy, real login unchanged: written back atomically (600), backup of the old content (600) kept from the first refresh", async () => {
    const { f, src, o, orig } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"R1"}');
    writeFileSync(join(f.d, "refresh.2"), '{"tokens":"R2"}');
    await callCodexGen(q, o);
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"R1"}');
    expect(mode(src)).toBe("600");
    expect(readFileSync(src + ".pgaibench-bak", "utf8")).toBe(orig);
    expect(mode(src + ".pgaibench-bak")).toBe("600");
    await callCodexGen(q, o); // the next call copies R1 and refreshes to R2
    expect(f.rec("auth", 2)).toBe('{"tokens":"R1"}');
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"R2"}');
    expect(readFileSync(src + ".pgaibench-bak", "utf8")).toBe(orig);
    expect(readdirSync(join(f.home, ".codex")).filter((x) => x.startsWith("auth.json")).sort()).toEqual(["auth.json", "auth.json.pgaibench-bak"]);
  });
  test("real login changed meanwhile: not written; refreshed copy kept in a 700 dir; Codex calls stop loudly", async () => {
    const { f, src, stash, o } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"MINE"}');
    writeFileSync(join(f.d, "sourcechange.1"), '{"tokens":"OTHER"}');
    const e = await callCodexGen(q, o).catch((x) => x);
    expect(e.reason).toBe("access:login_conflict");
    expect(e.message).toMatch(/not written back/);
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"OTHER"}');
    expect(existsSync(src + ".pgaibench-bak")).toBe(false);
    const dirs = readdirSync(stash);
    expect(dirs.length).toBe(1);
    expect(mode(join(stash, dirs[0]!))).toBe("700");
    expect(readFileSync(join(stash, dirs[0]!, "auth.json"), "utf8")).toBe('{"tokens":"MINE"}');
    expect(mode(join(stash, dirs[0]!, "auth.json"))).toBe("600");
    const e2 = await callCodexGen(q, o).catch((x) => x);
    expect(e2.reason).toBe("access:login_conflict");
    expect(f.calls()).toBe(1);
  });
  test("concurrent calls cannot clobber: the second refresh from the same old login is not written over the first", async () => {
    const { f, src, o } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"A"}');
    writeFileSync(join(f.d, "refresh.2"), '{"tokens":"B"}');
    writeFileSync(join(f.d, "sleep.2"), "0.3");
    const rs = await Promise.allSettled([callCodexGen(q, o), callCodexGen(q, o)]);
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"A"}');
    expect(rs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.reason)).toEqual(["access:login_conflict"]);
  });
});

describe("write-back hardening", () => {
  test("the real login changes between the check and the rename: aborted loudly, not written", async () => {
    const { codexLoginHooks } = await import("./codex-auth");
    const { f, src, stash, o } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"MINE"}');
    codexLoginHooks.beforeRename = () => writeFileSync(src, '{"tokens":"RACE"}');
    try {
      const e = await callCodexGen(q, o).catch((x) => x);
      expect(e.reason).toBe("access:login_conflict");
      expect(e.message).toMatch(/changed/);
    } finally { codexLoginHooks.beforeRename = undefined; }
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"RACE"}');
    expect(readdirSync(join(f.home, ".codex")).filter((x) => x.includes("pgaibench-tmp") || x.endsWith(".pgaibench-lock"))).toEqual([]);
    expect(readFileSync(join(stash, readdirSync(stash)[0]!, "auth.json"), "utf8")).toBe('{"tokens":"MINE"}');
  });
  test("an existing lock file stops the write-back loudly and is left in place", async () => {
    const { f, src, o, orig } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"MINE"}');
    writeFileSync(src + ".pgaibench-lock", "other");
    const e = await callCodexGen(q, o).catch((x) => x);
    expect(e.reason).toBe("access:login_conflict");
    expect(e.message).toMatch(/lock/);
    expect(readFileSync(src, "utf8")).toBe(orig);
    expect(readFileSync(src + ".pgaibench-lock", "utf8")).toBe("other");
  });
  test("a successful write-back removes its lock file", async () => {
    const { f, src, o } = setup();
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"R1"}');
    await callCodexGen(q, o);
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"R1"}');
    expect(existsSync(src + ".pgaibench-lock")).toBe(false);
  });
  test("an existing backup file is never overwritten (the first one is kept)", async () => {
    const { f, src, o } = setup();
    writeFileSync(src + ".pgaibench-bak", '{"tokens":"FIRST"}');
    writeFileSync(join(f.d, "refresh.1"), '{"tokens":"R1"}');
    await callCodexGen(q, o);
    expect(readFileSync(src, "utf8")).toBe('{"tokens":"R1"}');
    expect(readFileSync(src + ".pgaibench-bak", "utf8")).toBe('{"tokens":"FIRST"}');
  });
});
