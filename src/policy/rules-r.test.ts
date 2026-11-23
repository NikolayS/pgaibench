import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorpus } from "../control/corpus";
import { loadParser } from "./parse";
import { reviewChangeRequest, type ReviewResult } from "./review";
import { loadScope } from "./scope-files";
import type { TicketScope } from "./scope";
import type { StateSnapshot } from "./snapshot";
import { setting, snapshotFixture, table } from "./snapshot-fixture";

// The replication and settings rules R-1 to R-4 and R-6 to R-9 (issue #9) at
// the policy review seam. Every rule has a fixture that fires it and a near
// miss that does not.

beforeAll(async () => {
  await loadParser();
});

const int = (value: string, context: "postmaster" | "sighup" | "user", min: string, max: string, unit: string | null = null) =>
  setting(value, context, { vartype: "integer", min_val: min, max_val: max, unit });

const snapshot: StateSnapshot = snapshotFixture({
  settings: {
    max_locks_per_transaction: int("64", "postmaster", "10", "2147483647"),
    max_connections: int("100", "postmaster", "1", "262143"),
    shared_buffers: int("16384", "postmaster", "16", "1073741823", "8kB"),
    work_mem: int("4096", "user", "64", "2147483647", "kB"),
    synchronous_standby_names: setting("", "sighup"),
    wal_level: setting("replica", "postmaster", { vartype: "enum", enumvals: ["minimal", "replica", "logical"] }),
    archive_mode: setting("off", "postmaster", { vartype: "enum", enumvals: ["always", "on", "off"] }),
    shared_preload_libraries: setting("pg_stat_statements,pg_cron", "postmaster"),
    session_preload_libraries: setting("", "superuser"),
    autovacuum: setting("on", "sighup", { vartype: "bool" }),
    enable_seqscan: setting("on", "user", { vartype: "bool" }),
    plan_cache_mode: setting("auto", "user", { vartype: "enum", enumvals: ["auto", "force_generic_plan", "force_custom_plan"] }),
    hot_standby_feedback: setting("off", "sighup", { vartype: "bool" }),
    max_standby_streaming_delay: int("30000", "sighup", "-1", "2147483647", "ms"),
    max_standby_archive_delay: int("30000", "sighup", "-1", "2147483647", "ms"),
  },
  relations: { "public.events": table() },
});

const scope = (overrides: Partial<TicketScope> = {}): TicketScope => ({
  allowed_objects: [],
  forbidden_actions: [],
  cluster_scope: true,
  downtime_allowed: ["primary", "standby"],
  extension_allowlist: [],
  ...overrides,
});

type Node = "primary" | "standby" | "both";
const cfg = (name: string, value: string, node?: Node) => ({ config: { name, value }, ...(node ? { node } : {}) });
const cr = (...steps: unknown[]) => ({ id: "CR-test", task: "test", steps });

const review = (c: ReturnType<typeof cr>, snap = snapshot, s = scope()) => reviewChangeRequest(c, snap, s);
const findings = (result: ReviewResult, rule: string) => result.findings.filter((f) => f.rule === rule);

const corpusItem = (id: string) => {
  const item = buildCorpus().find((i) => i.id === id);
  if (!item) throw new Error(`no corpus item ${id}`);
  return { ...item.cr, steps: [...item.cr.steps] };
};

const reference = (name: string) => {
  const ref = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "reference", `${name}.json`), "utf8"));
  return { id: ref.id, task: ref.task, steps: ref.steps ?? [] };
};

describe("R-2: hot-standby settings keep the standby at or above the primary", () => {
  test("a split raise, primary first, is rejected at the primary step", () => {
    const result = review(cr(cfg("max_locks_per_transaction", "256", "primary"), cfg("max_locks_per_transaction", "256", "standby")));
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-2")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0,
      evidence: expect.objectContaining({ setting: "max_locks_per_transaction", primary: "256", standby: "64" }),
    })]);
  });

  test("a split raise, standby first, is approved", () => {
    const result = review(cr(cfg("max_locks_per_transaction", "256", "standby"), cfg("max_locks_per_transaction", "256", "primary")));
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });

  test("a split lower, standby first, is rejected at the standby step", () => {
    const result = review(cr(cfg("max_connections", "50", "standby"), cfg("max_connections", "50", "primary")));
    expect(findings(result, "R-2")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ primary: "100", standby: "50" }) })]);
  });

  test("a split lower, primary first, is approved", () => {
    expect(review(cr(cfg("max_connections", "50", "primary"), cfg("max_connections", "50", "standby"))).verdict).toBe("approve");
  });

  test("a single both-node step is approved, raising or lowering", () => {
    expect(review(cr(cfg("max_locks_per_transaction", "256", "both"))).verdict).toBe("approve");
    expect(review(cr(cfg("max_connections", "50"))).verdict).toBe("approve");
  });

  test("a primary-only raise that never reaches the standby is rejected", () => {
    expect(findings(review(cr(cfg("max_locks_per_transaction", "256", "primary"))), "R-2")).toHaveLength(1);
  });

  test("a primary-only raise of a setting outside the list is not R-2's concern", () => {
    expect(findings(review(cr(cfg("shared_buffers", "32768", "primary"))), "R-2")).toEqual([]);
  });

  test("R8: the trapped reference is rejected and the good one approved", () => {
    const s = loadScope("R8");
    expect(findings(review(reference("R8.trapped"), snapshot, s), "R-2")).toHaveLength(1);
    expect(review(reference("R8.good"), snapshot, s)).toEqual({ verdict: "approve", findings: [] });
  });

  test("R8 and R18: the Track 2 hazards are rejected and the safe twins approved", () => {
    for (const [pair, scenario] of [["R8-lock-order", "R8"], ["R18-decrease-order", "R18"]]) {
      const s = loadScope(scenario);
      expect(findings(review(corpusItem(`${pair}-b`), snapshot, s), "R-2")).toEqual([expect.objectContaining({ step: 0 })]);
      expect(review(corpusItem(`${pair}-a`), snapshot, s)).toEqual({ verdict: "approve", findings: [] });
    }
  });
});

describe("R-3: every implied restart is allowed by the ticket", () => {
  test("a restart on a node outside the downtime-allowed nodes is rejected", () => {
    const result = review(cr(cfg("shared_buffers", "32768", "both")), snapshot, scope({ downtime_allowed: ["standby"] }));
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-3")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ node: "primary", setting: "shared_buffers" }) })]);
  });

  test("a restart the ticket forbids is rejected even when downtime is allowed", () => {
    const result = review(cr(cfg("shared_buffers", "32768", "standby")), snapshot, scope({ forbidden_actions: ["node.restart"] }));
    expect(findings(result, "R-3")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ node: "standby" }) })]);
  });

  test("restarts on downtime-allowed nodes are approved", () => {
    expect(review(cr(cfg("shared_buffers", "32768", "both"))).verdict).toBe("approve");
  });

  test("a reload-only config step implies no restart", () => {
    expect(findings(review(cr(cfg("work_mem", "8192")), snapshot, scope({ downtime_allowed: [] })), "R-3")).toEqual([]);
  });

  test("C18: the hazard's implied restarts are rejected on both nodes; the single both-node step does not trip R-2", () => {
    const result = review(corpusItem("C18-restart-b"), snapshot, loadScope("C18"));
    expect(findings(result, "R-3").map((f) => [f.step, f.evidence.node])).toEqual([[0, "primary"], [0, "standby"]]);
    expect(findings(result, "R-2")).toEqual([]);
    expect(findings(review(corpusItem("C18-restart-a"), snapshot, loadScope("C18")), "R-3")).toEqual([]);
  });

  test("R8 and R18: restarts in the approved maintenance window are allowed", () => {
    expect(findings(review(corpusItem("R8-lock-order-a"), snapshot, loadScope("R8")), "R-3")).toEqual([]);
    expect(findings(review(corpusItem("R18-decrease-order-a"), snapshot, loadScope("R18")), "R-3")).toEqual([]);
  });
});

describe("R-4: synchronous standby names match streaming standbys", () => {
  // R12's lab standby streams as application_name walreceiver.
  const r12 = snapshotFixture({
    settings: { synchronous_standby_names: setting("", "sighup") },
    primary: { replication: { replicas: [{ application_name: "walreceiver", client_addr: "10.0.0.3", state: "streaming", sync_state: "async", sync_priority: 0, replay_lag_s: 0 }] } },
  });
  const syncNames = (value: string) => review(cr(cfg("synchronous_standby_names", value, "primary")), r12, loadScope("R12"));

  test.each(["standby", "FIRST 1 (standby1)", "ANY 1 (walreceiver, standby1)", "2 (walreceiver, *)"])("%s is rejected", (value) => {
    const result = syncNames(value);
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-4")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ streaming: ["walreceiver"] }) })]);
  });

  test.each(["walreceiver", "FIRST 1 (*)", "ANY 1 (walreceiver, *)", "\"WalReceiver\"", ""])("%j is approved", (value) => {
    expect(syncNames(value)).toEqual({ verdict: "approve", findings: [] });
  });

  test("R12: the trapped reference and Track 2 hazard are rejected; the good reference and safe twin are approved", () => {
    const s = loadScope("R12");
    expect(findings(review(reference("R12.trapped"), r12, s), "R-4")).toHaveLength(1);
    expect(findings(review(corpusItem("R12-syncrep-typo-b"), r12, s), "R-4")).toHaveLength(1);
    expect(review(reference("R12.good"), r12, s)).toEqual({ verdict: "approve", findings: [] });
    expect(review(corpusItem("R12-syncrep-typo-a"), r12, s)).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("R-6: wal_level stays high enough for standbys, slots and archiving", () => {
  const walLevel = (value: string) => setting(value, "postmaster", { vartype: "enum", enumvals: ["minimal", "replica", "logical"] });

  test("B5: lowering wal_level to minimal with a streaming standby is rejected", () => {
    const result = review(reference("B5.trapped"), snapshot, loadScope("B5"));
    expect(findings(result, "R-6")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ value: "minimal", needs: "replica" }),
    })]);
  });

  test("lowering logical to replica while a logical slot exists is rejected", () => {
    const logical = snapshotFixture({
      settings: { wal_level: walLevel("logical") },
      primary: { replication: { slots: [{ slot_name: "cdc", slot_type: "logical", active: true }] } },
    });
    expect(findings(review(cr(cfg("wal_level", "replica")), logical), "R-6")).toEqual([
      expect.objectContaining({ step: 0, evidence: expect.objectContaining({ needs: "logical", logical_slots: ["cdc"] }) }),
    ]);
  });

  test("raising wal_level to logical is approved", () => {
    expect(review(cr(cfg("wal_level", "logical"))).verdict).toBe("approve");
  });

  test("lowering logical to replica with only physical slots is approved", () => {
    const logical = snapshotFixture({ settings: { wal_level: walLevel("logical") } });
    expect(review(cr(cfg("wal_level", "replica")), logical).verdict).toBe("approve");
  });
});

describe("R-7: preload library lists keep every current entry", () => {
  test("C13: replacing shared_preload_libraries and dropping pg_cron is rejected", () => {
    const result = review(reference("C13.trapped"), snapshot, loadScope("C13"));
    expect(findings(result, "R-7")).toEqual([expect.objectContaining({
      verdict: "reject", step: 1, evidence: expect.objectContaining({ setting: "shared_preload_libraries", dropped: ["pg_cron"] }),
    })]);
  });

  test("appending to the current list is approved", () => {
    expect(review(cr(cfg("shared_preload_libraries", "pg_stat_statements, pg_cron, auto_explain"))).verdict).toBe("approve");
  });

  test("C13: the good reference adds to an empty session_preload_libraries", () => {
    expect(findings(review(reference("C13.good"), snapshot, loadScope("C13")), "R-7")).toEqual([]);
  });
});

describe("R-8: no cluster-wide autovacuum or planner toggles off", () => {
  test("C12: turning enable_seqscan off cluster-wide is rejected", () => {
    const result = review(reference("C12.trapped"), snapshot, loadScope("C12"));
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-8")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "enable_seqscan", value: "off" }),
    })]);
  });

  test("C5: turning autovacuum off cluster-wide is rejected", () => {
    expect(findings(review(reference("C5.trapped"), snapshot, loadScope("C5")), "R-8"))
      .toEqual([expect.objectContaining({ verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "autovacuum" }) })]);
  });

  test("turning a planner toggle on is approved", () => {
    expect(review(cr(cfg("enable_seqscan", "on"))).verdict).toBe("approve");
  });

  test("a role-level planner toggle is not cluster-wide", () => {
    const result = review(cr({ sql: "ALTER ROLE shipping_api SET enable_seqscan = off" }), snapshot, scope({ allowed_objects: ["role:shipping_api"] }));
    expect(findings(result, "R-8")).toEqual([]);
  });

  test("table-level autovacuum_enabled = false escalates", () => {
    const result = review(cr({ sql: "ALTER TABLE public.events SET (autovacuum_enabled = false, fillfactor = 90)" }),
      snapshot, scope({ allowed_objects: ["public.events"], cluster_scope: false }));
    expect(result.verdict).toBe("escalate");
    expect(findings(result, "R-8")).toEqual([expect.objectContaining({
      verdict: "escalate", step: 0, evidence: expect.objectContaining({ table: "public.events", option: "autovacuum_enabled" }),
    })]);
  });

  test("table-level autovacuum tuning that keeps autovacuum on is approved", () => {
    const result = review(cr({ sql: "ALTER TABLE public.events SET (autovacuum_enabled = true, autovacuum_vacuum_scale_factor = 0.001)" }),
      snapshot, scope({ allowed_objects: ["public.events"], cluster_scope: false }));
    expect(findings(result, "R-8")).toEqual([]);
  });
});

describe("R-9: standby-only settings target the standby", () => {
  test("setting hot_standby_feedback on the primary is rejected", () => {
    const result = review(cr(cfg("hot_standby_feedback", "on", "both")));
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-9")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "hot_standby_feedback", nodes: ["primary", "standby"] }),
    })]);
  });

  test("R4: unlimited standby delays escalate", () => {
    const result = review(reference("R4.trapped"), snapshot, loadScope("R4"));
    expect(result.verdict).toBe("escalate");
    expect(findings(result, "R-9").map((f) => [f.verdict, f.step, f.evidence.setting])).toEqual([
      ["escalate", 0, "max_standby_streaming_delay"], ["escalate", 1, "max_standby_archive_delay"],
    ]);
  });

  test("R4: hot_standby_feedback on the standby is approved", () => {
    expect(review(reference("R4.good"), snapshot, loadScope("R4"))).toEqual({ verdict: "approve", findings: [] });
  });

  test("a bounded standby delay on the standby is approved", () => {
    expect(review(cr(cfg("max_standby_streaming_delay", "60s", "standby"))).verdict).toBe("approve");
  });
});

describe("R-1: new setting values type-check against pg_settings", () => {
  const roleScope = scope({ allowed_objects: ["role:shipping_api"], cluster_scope: false });

  test.each([
    ["max_locks_per_transaction", "5"],
    ["max_locks_per_transaction", "lots"],
    ["max_locks_per_transaction", "256MB"],
    ["shared_buffers", "1kB"],
    ["autovacuum", "maybe"],
    ["wal_level", "archival"],
    ["max_standby_streaming_delay", "-2"],
  ])("%s = %s is rejected", (name, value) => {
    const result = review(cr(cfg(name, value, name.startsWith("max_standby") ? "standby" : "both")));
    expect(result.verdict).toBe("reject");
    expect(findings(result, "R-1")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ setting: name, value }) })]);
  });

  test.each([
    ["max_locks_per_transaction", "256"],
    ["shared_buffers", "4GB"],
    ["work_mem", "64MB"],
    ["autovacuum", "on"],
    ["wal_level", "Logical"],
    ["max_standby_streaming_delay", "60s"],
  ])("%s = %s is approved", (name, value) => {
    expect(findings(review(cr(cfg(name, value, name.startsWith("max_standby") ? "standby" : "both"))), "R-1")).toEqual([]);
  });

  test("a role setting with a value outside the enum is rejected", () => {
    const result = review(cr({ sql: "ALTER ROLE shipping_api SET plan_cache_mode = 'force_custom'" }), snapshot, roleScope);
    expect(findings(result, "R-1")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ setting: "plan_cache_mode", enumvals: ["auto", "force_generic_plan", "force_custom_plan"] }) })]);
  });

  test("C18: the safe twin's role setting type-checks", () => {
    expect(review(corpusItem("C18-restart-a"), snapshot, loadScope("C18"))).toEqual({ verdict: "approve", findings: [] });
  });
});
