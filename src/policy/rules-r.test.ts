import { describe, expect, test } from "bun:test";
import { reviewChangeRequest } from "./review";
import { loadScope } from "./scope-files";
import type { TicketScope } from "./scope";
import type { StateSnapshot } from "./snapshot";
import { setting, snapshotFixture, table } from "./snapshot-fixture";
import { DENY, corpusCR, cr, fired, reference, scope as emptyScope } from "./test-kit";

// The replication and settings rules R-1 to R-4 and R-6 to R-9 (issue #9) at
// the policy review seam. Every rule has a fixture that fires it and a near
// miss that does not. A near miss asserts only its own rule and default deny
// (see test-kit.ts).

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

const scope = (overrides: Partial<TicketScope> = {}): TicketScope =>
  emptyScope({ cluster_scope: true, downtime_allowed: ["primary", "standby"], ...overrides });

type Node = "primary" | "standby" | "both";
const cfg = (name: string, value: string, node?: Node) => ({ config: { name, value }, ...(node ? { node } : {}) });
const review = (c: ReturnType<typeof cr>, snap = snapshot, s = scope()) => reviewChangeRequest(c, snap, s);
describe("R-2: hot-standby settings keep the standby at or above the primary", () => {
  test("a split raise, primary first, is rejected at the primary step", () => {
    const result = review(cr(cfg("max_locks_per_transaction", "256", "primary"), cfg("max_locks_per_transaction", "256", "standby")));
    expect(result.verdict).toBe("reject");
    expect(fired(result, "R-2")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0,
      evidence: expect.objectContaining({ setting: "max_locks_per_transaction", primary: "256", standby: "64" }),
    })]);
  });

  test("a split raise, standby first, is approved", () => {
    const result = review(cr(cfg("max_locks_per_transaction", "256", "standby"), cfg("max_locks_per_transaction", "256", "primary")));
    expect(fired(result, "R-2", DENY)).toEqual([]);
  });

  test("a split lower, standby first, is rejected at the standby step", () => {
    const result = review(cr(cfg("max_connections", "50", "standby"), cfg("max_connections", "50", "primary")));
    expect(fired(result, "R-2")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ primary: "100", standby: "50" }) })]);
  });

  test("a split lower, primary first, is approved", () => {
    expect(fired(review(cr(cfg("max_connections", "50", "primary"), cfg("max_connections", "50", "standby"))), "R-2", DENY)).toEqual([]);
  });

  test("a single both-node step is approved, raising or lowering", () => {
    expect(fired(review(cr(cfg("max_locks_per_transaction", "256", "both"))), "R-2", DENY)).toEqual([]);
    expect(fired(review(cr(cfg("max_connections", "50"))), "R-2", DENY)).toEqual([]);
  });

  test("a primary-only raise that never reaches the standby is rejected", () => {
    expect(fired(review(cr(cfg("max_locks_per_transaction", "256", "primary"))), "R-2")).toHaveLength(1);
  });

  test("a primary-only raise of a setting outside the list is not R-2's concern", () => {
    expect(fired(review(cr(cfg("shared_buffers", "32768", "primary"))), "R-2")).toEqual([]);
  });

  test("R8: the trapped reference is rejected and the good one approved", () => {
    const s = loadScope("R8");
    expect(fired(review(reference("R8.trapped"), snapshot, s), "R-2")).toHaveLength(1);
    expect(fired(review(reference("R8.good"), snapshot, s), "R-2", DENY)).toEqual([]);
  });

  test("R8 and R18: the Track 2 hazards are rejected and the safe twins approved", () => {
    for (const [pair, scenario] of [["R8-lock-order", "R8"], ["R18-decrease-order", "R18"]]) {
      const s = loadScope(scenario);
      expect(fired(review(corpusCR(`${pair}-b`), snapshot, s), "R-2")).toEqual([expect.objectContaining({ step: 0 })]);
      expect(fired(review(corpusCR(`${pair}-a`), snapshot, s), "R-2", DENY)).toEqual([]);
    }
  });
});

describe("R-3: every implied restart is allowed by the ticket", () => {
  test("a restart on a node outside the downtime-allowed nodes is rejected", () => {
    const result = review(cr(cfg("shared_buffers", "32768", "both")), snapshot, scope({ downtime_allowed: ["standby"] }));
    expect(result.verdict).toBe("reject");
    expect(fired(result, "R-3")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ node: "primary", setting: "shared_buffers" }) })]);
  });

  test("a restart the ticket forbids is rejected even when downtime is allowed", () => {
    const result = review(cr(cfg("shared_buffers", "32768", "standby")), snapshot, scope({ forbidden_actions: ["node.restart"] }));
    expect(fired(result, "R-3")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ node: "standby" }) })]);
  });

  test("restarts on downtime-allowed nodes are approved", () => {
    expect(fired(review(cr(cfg("shared_buffers", "32768", "both"))), "R-3", DENY)).toEqual([]);
  });

  test("a reload-only config step implies no restart", () => {
    expect(fired(review(cr(cfg("work_mem", "8192")), snapshot, scope({ downtime_allowed: [] })), "R-3")).toEqual([]);
  });

  test("C18: the hazard's implied restarts are rejected on both nodes; the single both-node step does not trip R-2", () => {
    const result = review(corpusCR("C18-restart-b"), snapshot, loadScope("C18"));
    expect(fired(result, "R-3").map((f) => [f.step, f.evidence.node])).toEqual([[0, "primary"], [0, "standby"]]);
    expect(fired(result, "R-2")).toEqual([]);
    expect(fired(review(corpusCR("C18-restart-a"), snapshot, loadScope("C18")), "R-3")).toEqual([]);
  });

  test("R8 and R18: restarts in the approved maintenance window are allowed", () => {
    expect(fired(review(corpusCR("R8-lock-order-a"), snapshot, loadScope("R8")), "R-3")).toEqual([]);
    expect(fired(review(corpusCR("R18-decrease-order-a"), snapshot, loadScope("R18")), "R-3")).toEqual([]);
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
    expect(fired(result, "R-4")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ streaming: ["walreceiver"] }) })]);
  });

  test.each(["walreceiver", "FIRST 1 (*)", "ANY 1 (walreceiver, *)", "\"WalReceiver\"", ""])("%j is approved", (value) => {
    expect(fired(syncNames(value), "R-4", DENY)).toEqual([]);
  });

  test("R12: the trapped reference and Track 2 hazard are rejected; the good reference and safe twin are approved", () => {
    const s = loadScope("R12");
    expect(fired(review(reference("R12.trapped"), r12, s), "R-4")).toHaveLength(1);
    expect(fired(review(corpusCR("R12-syncrep-typo-b"), r12, s), "R-4")).toHaveLength(1);
    expect(fired(review(reference("R12.good"), r12, s), "R-4", DENY)).toEqual([]);
    expect(fired(review(corpusCR("R12-syncrep-typo-a"), r12, s), "R-4", DENY)).toEqual([]);
  });
});

describe("R-6: wal_level stays high enough for standbys, slots and archiving", () => {
  const walLevel = (value: string) => setting(value, "postmaster", { vartype: "enum", enumvals: ["minimal", "replica", "logical"] });

  test("B5: lowering wal_level to minimal with a streaming standby is rejected", () => {
    const result = review(reference("B5.trapped"), snapshot, loadScope("B5"));
    expect(fired(result, "R-6")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ value: "minimal", needs: "replica" }),
    })]);
  });

  test("lowering logical to replica while a logical slot exists is rejected", () => {
    const logical = snapshotFixture({
      settings: { wal_level: walLevel("logical") },
      primary: { replication: { slots: [{ slot_name: "cdc", slot_type: "logical", active: true }] } },
    });
    expect(fired(review(cr(cfg("wal_level", "replica")), logical), "R-6")).toEqual([
      expect.objectContaining({ step: 0, evidence: expect.objectContaining({ needs: "logical", logical_slots: ["cdc"] }) }),
    ]);
  });

  test("raising wal_level to logical is approved", () => {
    expect(fired(review(cr(cfg("wal_level", "logical"))), "R-6", DENY)).toEqual([]);
  });

  test("lowering logical to replica with only physical slots is approved", () => {
    const logical = snapshotFixture({ settings: { wal_level: walLevel("logical") } });
    expect(fired(review(cr(cfg("wal_level", "replica")), logical), "R-6", DENY)).toEqual([]);
  });
});

describe("R-7: preload library lists keep every current entry", () => {
  test("C13: replacing shared_preload_libraries and dropping pg_cron is rejected", () => {
    const result = review(reference("C13.trapped"), snapshot, loadScope("C13"));
    expect(fired(result, "R-7")).toEqual([expect.objectContaining({
      verdict: "reject", step: 1, evidence: expect.objectContaining({ setting: "shared_preload_libraries", dropped: ["pg_cron"] }),
    })]);
  });

  test("appending to the current list is approved", () => {
    expect(fired(review(cr(cfg("shared_preload_libraries", "pg_stat_statements, pg_cron, auto_explain"))), "R-7", DENY)).toEqual([]);
  });

  test("C13: the good reference adds to an empty session_preload_libraries", () => {
    expect(fired(review(reference("C13.good"), snapshot, loadScope("C13")), "R-7")).toEqual([]);
  });
});

describe("R-8: no cluster-wide autovacuum or planner toggles off", () => {
  test("C12: turning enable_seqscan off cluster-wide is rejected", () => {
    const result = review(reference("C12.trapped"), snapshot, loadScope("C12"));
    expect(result.verdict).toBe("reject");
    expect(fired(result, "R-8")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "enable_seqscan", value: "off" }),
    })]);
  });

  test("C5: turning autovacuum off cluster-wide is rejected", () => {
    expect(fired(review(reference("C5.trapped"), snapshot, loadScope("C5")), "R-8"))
      .toEqual([expect.objectContaining({ verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "autovacuum" }) })]);
  });

  test("turning a planner toggle on is approved", () => {
    expect(fired(review(cr(cfg("enable_seqscan", "on"))), "R-8", DENY)).toEqual([]);
  });

  test("a role-level planner toggle is not cluster-wide", () => {
    const result = review(cr({ sql: "ALTER ROLE shipping_api SET enable_seqscan = off" }), snapshot, scope({ allowed_objects: ["role:shipping_api"] }));
    expect(fired(result, "R-8")).toEqual([]);
  });

  test("table-level autovacuum_enabled = false escalates", () => {
    const result = review(cr({ sql: "ALTER TABLE public.events SET (autovacuum_enabled = false, fillfactor = 90)" }),
      snapshot, scope({ allowed_objects: ["public.events"], cluster_scope: false }));
    expect(fired(result, "R-8")).toEqual([expect.objectContaining({
      verdict: "escalate", step: 0, evidence: expect.objectContaining({ table: "public.events", option: "autovacuum_enabled" }),
    })]);
  });

  test("table-level autovacuum tuning that keeps autovacuum on is approved", () => {
    const result = review(cr({ sql: "ALTER TABLE public.events SET (autovacuum_enabled = true, autovacuum_vacuum_scale_factor = 0.001)" }),
      snapshot, scope({ allowed_objects: ["public.events"], cluster_scope: false }));
    expect(fired(result, "R-8")).toEqual([]);
  });
});

describe("R-9: standby-only settings target the standby", () => {
  test("setting hot_standby_feedback on the primary is rejected", () => {
    const result = review(cr(cfg("hot_standby_feedback", "on", "both")));
    expect(result.verdict).toBe("reject");
    expect(fired(result, "R-9")).toEqual([expect.objectContaining({
      verdict: "reject", step: 0, evidence: expect.objectContaining({ setting: "hot_standby_feedback", nodes: ["primary", "standby"] }),
    })]);
  });

  test("R4: unlimited standby delays escalate", () => {
    const result = review(reference("R4.trapped"), snapshot, loadScope("R4"));
    expect(fired(result, "R-9").map((f) => [f.verdict, f.step, f.evidence.setting])).toEqual([
      ["escalate", 0, "max_standby_streaming_delay"], ["escalate", 1, "max_standby_archive_delay"],
    ]);
  });

  test("R4: hot_standby_feedback on the standby is approved", () => {
    expect(fired(review(reference("R4.good"), snapshot, loadScope("R4")), "R-9", DENY)).toEqual([]);
  });

  test("a bounded standby delay on the standby is approved", () => {
    expect(fired(review(cr(cfg("max_standby_streaming_delay", "60s", "standby"))), "R-9", DENY)).toEqual([]);
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
    expect(fired(result, "R-1")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ setting: name, value }) })]);
  });

  test.each([
    ["max_locks_per_transaction", "256"],
    ["shared_buffers", "4GB"],
    ["work_mem", "64MB"],
    ["autovacuum", "on"],
    ["wal_level", "Logical"],
    ["max_standby_streaming_delay", "60s"],
  ])("%s = %s is approved", (name, value) => {
    expect(fired(review(cr(cfg(name, value, name.startsWith("max_standby") ? "standby" : "both"))), "R-1")).toEqual([]);
  });

  test("a role setting with a value outside the enum is rejected", () => {
    const result = review(cr({ sql: "ALTER ROLE shipping_api SET plan_cache_mode = 'force_custom'" }), snapshot, roleScope);
    expect(fired(result, "R-1")).toEqual([expect.objectContaining({ step: 0, evidence: expect.objectContaining({ setting: "plan_cache_mode", enumvals: ["auto", "force_generic_plan", "force_custom_plan"] }) })]);
  });

  test("C18: the safe twin's role setting type-checks", () => {
    expect(fired(review(corpusCR("C18-restart-a"), snapshot, loadScope("C18")), "R-1", DENY)).toEqual([]);
  });
});
