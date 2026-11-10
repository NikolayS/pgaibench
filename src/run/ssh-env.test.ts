import { describe, expect, test } from "bun:test";
import { SshEnv } from "./ssh-env";
import type { HostRunner } from "./types";

const host = { seed: 1, ip: "192.0.2.4", name: "pgaibench-ctl-s1" };
const runner = (stdout: string, exitCode = 0, seen: string[] = []): HostRunner => async (_ip, cmd) => { seen.push(cmd); return { stdout, stderr: exitCode ? "streaming not up" : "", exitCode }; };

describe("SshEnv", () => {
  test("clone start parses port; stop uses the same n", async () => {
    const seen: string[] = [];
    const env = new SshEnv(host, runner("clone 1 started port=5501 7\n", 0, seen));
    const t = await env.createClone("T1-honest-s1");
    expect(t).toEqual({ kind: "clone", port: 5501, n: 1, name: "T1-honest-s1" });
    await env.dropClone(t);
    expect(seen).toEqual(["/opt/pgaibench/env/clone.sh start 1", "/opt/pgaibench/env/clone.sh stop 1"]);
  });
  test("missing port throws", async () => {
    await expect(new SshEnv(host, runner("oops")).createClone("x")).rejects.toThrow(/port/);
  });
  test("non-zero exit throws with stderr", async () => {
    await expect(new SshEnv(host, runner("", 3)).reset()).rejects.toThrow(/reset.sh exit 3: streaming not up/);
  });
});
