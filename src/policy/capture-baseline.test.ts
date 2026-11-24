import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection, SqlClient } from "../schema/types";
import {
  BASELINE_DIR, baselinePlan, captureBaseline, findSecrets, missingScopeObjects, parseBaselineArgs,
  redactSnapshot, scenarioChangeRequest, type BaselinePorts,
} from "./capture-baseline";
import { listScopeIds } from "./scope-files";
import { stateSnapshotSchema, type StateSnapshot } from "./snapshot";

// The baseline capture entry point (issue #7). The wizard in
// scripts/capture-baselines.ts calls it once per scenario on a lab VM. No
// database and no VM here: the ports are fakes.

const FIXTURE = join(import.meta.dir, "fixtures", "snapshot-two-node.json");
const sample = (): StateSnapshot => stateSnapshotSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

describe("arguments", () => {
  test("seed and scenario are required; window defaults leave time after collection", () => {
    expect(parseBaselineArgs(["--seed", "2", "--scenario", "L9"])).toEqual({
      seed: 2, scenario: "L9", windowS: 180, collectAtS: 120, out: BASELINE_DIR,
    });
    expect(() => parseBaselineArgs(["--scenario", "L9"])).toThrow(/Usage/);
    expect(() => parseBaselineArgs(["--seed", "1", "--scenario", "l9; rm"])).toThrow(/Usage/);
    expect(() => parseBaselineArgs(["--seed", "1", "--scenario", "L9", "--collect-at", "200"])).toThrow(/before the window ends/);
  });
});

describe("plan", () => {
  test("every scenario with a ticket scope has a plan", () => {
    for (const id of listScopeIds()) expect(baselinePlan(id).scenario).toBe(id);
  });

  test("public scenarios have their trap in the seed; corpus-only scenarios need their private setup file", () => {
    expect(baselinePlan("L9")).toMatchObject({ setup: null, requireSetup: false });
    expect(baselinePlan("O1")).toMatchObject({ setup: "O1", requireSetup: true });
    expect(() => baselinePlan("Z99")).toThrow(/No ticket scope/);
  });

  test("the change request carries every drop target of the references and corpus items", () => {
    const sql = (id: string) => scenarioChangeRequest(id).steps.map((s) => (s as { sql?: string }).sql ?? "").join("\n");
    expect(sql("L9")).toMatch(/secret_lookup_k_dup_idx/);
    expect(sql("L8")).toMatch(/DROP TYPE/i);
    expect(sql("O3")).toMatch(/notes_archive/);
  });
});

describe("secrets", () => {
  test("connection strings lose their passwords; other settings are kept", () => {
    const snap = sample();
    const standby = snap.nodes.standby.settings;
    standby.primary_conninfo = {
      value: "host=127.0.0.1 port=5432 user=postgres password=hunter2 application_name=standby1", unit: null, context: "sighup",
      vartype: "string", min_val: null, max_val: null, enumvals: null, source: "configuration file", pending_restart: false,
    };
    snap.role_db_settings.push({ role: "app", database: null, settings: ["pgaudit.secret=x", "search_path=public"] } as never);
    const out = redactSnapshot(snap);
    expect(out.nodes.standby.settings.primary_conninfo!.value).toBe("host=127.0.0.1 port=5432 user=postgres password=<redacted> application_name=standby1");
    expect(out.nodes.standby.settings.work_mem).toEqual(snap.nodes.standby.settings.work_mem);
    expect(findSecrets(JSON.stringify(out))).toEqual([]);
    expect(stateSnapshotSchema.safeParse(out).success).toBe(true);
  });

  test("findSecrets flags passwords, URIs with credentials, key blocks and the live password", () => {
    expect(findSecrets("password=abc")).toHaveLength(1);
    expect(findSecrets("postgres://u:pw@h/db")).toHaveLength(1);
    expect(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).toHaveLength(1);
    expect(findSecrets("x s3cret-Lab-pw y", "s3cret-Lab-pw")).toHaveLength(1);
    // The documented lab default is also the project name, so it is not searched for.
    expect(findSecrets("/opt/pgaibench/env", "pgaibench")).toEqual([]);
  });
});

test("scope objects the snapshot does not show are reported", () => {
  const snap = sample();
  const present = Object.keys(snap.relations)[0]!;
  expect(missingScopeObjects(snap, ["public.no_such_table", present, "role:shipping_api"])).toEqual(["public.no_such_table"]);
});

describe("capture", () => {
  // The primary VM clock; the laptop clock may differ from it.
  const VM_NOW = "2026-11-23T09:03:20.500Z";

  function ports(o: { setupFile?: boolean; workloadExit?: number; workloadEndsEarly?: boolean; snapshot?: StateSnapshot; primaryNow?: string } = {}) {
    const cmds: string[] = [], written: Record<string, string> = {}, logs: string[] = [], conns: Connection[] = [];
    let released = 0, tunnelClosed = 0, ended = 0, finishWorkload!: () => void;
    const p: BaselinePorts = {
      async run(cmd) {
        cmds.push(cmd);
        if (cmd.startsWith("test -f")) return { stdout: "", stderr: "", exitCode: o.setupFile === false ? 1 : 0 };
        if (cmd.includes("now()")) return { stdout: o.primaryNow ?? `${Date.parse(VM_NOW) / 1000}\n`, stderr: "", exitCode: 0 };
        if (cmd.includes("w_prod.sh")) {
          if (!o.workloadEndsEarly) await new Promise<void>((r) => { finishWorkload = r; });
          return { stdout: '{"tps":2000}', stderr: "", exitCode: o.workloadExit ?? 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async tunnel(remote) { return { ports: Object.fromEntries(remote.map((r) => [r, r + 10000])), async close() { tunnelClosed++; } }; },
      client(conn) { conns.push(conn); return { async unsafe() { return []; }, async end() { ended++; } } as SqlClient; },
      async collect(_c, cr, opts) {
        expect(cr.task).toBeTruthy();
        const s = o.snapshot ?? sample();
        return { ...s, usage_window_start: opts.usageWindowStart.toISOString() };
      },
      async sleep() {},
      async lock() { return { async release() { released++; } }; },
      write(path, text) { written[path] = text; },
      log(m) { logs.push(m); },
      password: "hunter2-not-default",
    };
    const done = () => finishWorkload?.();
    return { p, cmds, written, logs, conns, done, counts: () => ({ released, tunnelClosed, ended }) };
  }

  test("resets, sets up the trap, starts the workload, collects both nodes mid-window, writes a fixture", async () => {
    const f = ports();
    const run = captureBaseline({ seed: 1, scenario: "O1", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p);
    await Bun.sleep(5);
    f.done();
    const path = await run;
    expect(path).toBe("/tmp/x/O1.json");
    expect(f.cmds[0]).toBe("/opt/pgaibench/env/reset.sh");
    expect(f.cmds[1]).toBe("test -f /opt/pgaibench/env/scenario-setup/O1.sql");
    expect(f.cmds[2]).toBe("/opt/pgaibench/env/scenario-setup.sh primary O1");
    expect(f.cmds[3]).toMatch(/^docker exec pgaibench-primary psql .*now\(\)/);
    expect(f.cmds[4]).toBe("/opt/pgaibench/env/workload/w_prod.sh 180 W_prod 5432");
    expect(f.conns.map((c) => c.port)).toEqual([15432, 15433]);
    expect(f.counts()).toEqual({ released: 1, tunnelClosed: 1, ended: 2 });
    const fixture = JSON.parse(f.written[path]!);
    expect(stateSnapshotSchema.safeParse(fixture).success).toBe(true);
    // The usage window starts at the primary's clock, not the laptop's.
    expect(fixture.usage_window_start).toBe(VM_NOW);
    expect(f.logs.join("\n")).not.toContain("hunter2");
  });

  test("a public scenario without a lab profile skips setup", async () => {
    const f = ports();
    const run = captureBaseline({ seed: 1, scenario: "L9", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p);
    await Bun.sleep(5);
    f.done();
    await run;
    expect(f.cmds.some((c) => c.includes("scenario-setup"))).toBe(false);
  });

  test("a corpus scenario with no setup file on the VM stops before the workload and releases the lock", async () => {
    const f = ports({ setupFile: false });
    await expect(captureBaseline({ seed: 1, scenario: "O1", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p)).rejects.toThrow(/scenario-setup\/O1\.sql/);
    expect(f.cmds.some((c) => c.includes("w_prod.sh"))).toBe(false);
    expect(f.counts().released).toBe(1);
    expect(Object.keys(f.written)).toEqual([]);
  });

  test("no fixture when the workload ended before collection", async () => {
    const f = ports({ workloadEndsEarly: true });
    await expect(captureBaseline({ seed: 1, scenario: "L9", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p)).rejects.toThrow(/workload was not running/);
    expect(Object.keys(f.written)).toEqual([]);
    expect(f.counts().released).toBe(1);
  });

  test("no fixture when the primary's clock cannot be read", async () => {
    const f = ports({ primaryNow: "psql: error: connection refused" });
    await expect(captureBaseline({ seed: 1, scenario: "L9", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p)).rejects.toThrow(/primary's clock/);
    expect(f.cmds.some((c) => c.includes("w_prod.sh"))).toBe(false);
    expect(Object.keys(f.written)).toEqual([]);
    expect(f.counts().released).toBe(1);
  });

  test("no fixture when a secret survives redaction", async () => {
    const snap = sample();
    snap.nodes.primary.settings.work_mem = { ...snap.nodes.primary.settings.work_mem!, value: "hunter2-not-default" };
    const f = ports({ snapshot: snap });
    const run = captureBaseline({ seed: 1, scenario: "L9", windowS: 180, collectAtS: 120, out: "/tmp/x" }, f.p);
    await Bun.sleep(5);
    f.done();
    await expect(run).rejects.toThrow(/secret/);
    expect(Object.keys(f.written)).toEqual([]);
    expect(f.logs.join("\n")).not.toContain("hunter2");
  });
});

// Committed baselines (none until a human runs the wizard on the lab VMs).
describe("committed baselines", () => {
  const files = (() => { try { return readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".json")); } catch { return []; } })();
  test("each one names a scoped scenario, validates and carries no secrets", () => {
    const ids = new Set(listScopeIds());
    for (const file of files) {
      expect(ids.has(file.slice(0, -5))).toBe(true);
      const text = readFileSync(join(BASELINE_DIR, file), "utf8");
      expect(stateSnapshotSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(findSecrets(text)).toEqual([]);
    }
  });
});
