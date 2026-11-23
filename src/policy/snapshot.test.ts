import { describe, expect, test } from "bun:test";
import twoNode from "./fixtures/snapshot-two-node.json";
import { loadParser } from "./parse";
import { reviewChangeRequest } from "./review";
import { scannedInWindow, stateSnapshotSchema } from "./snapshot";
import { index, indexUsage, setting, snapshotFixture, table } from "./snapshot-fixture";

// Schema tests for the state snapshot (issue #6): the full two-node shape the
// policy rules read. No database; fixtures are literal JSON.

const clone = (): any => structuredClone(twoNode);

describe("state snapshot schema", () => {
  test("a synthetic two-node snapshot validates", () => {
    const result = stateSnapshotSchema.safeParse(twoNode);
    expect(result.error).toBeUndefined();
    expect(result.data!.nodes.standby.usage.indexes["public.orders_customer_created_idx"].idx_scan).toBe(812);
  });

  test.each([
    ["the standby is missing", (s: any) => { delete s.nodes.standby; }],
    ["a node is neither primary nor standby", (s: any) => { s.nodes.replica = s.nodes.standby; }],
    ["a setting has an unknown context", (s: any) => { s.nodes.standby.settings.hot_standby_feedback.context = "reload"; }],
    ["a setting has no context", (s: any) => { delete s.nodes.primary.settings.work_mem.context; }],
    ["a last-scan time is not a timestamp", (s: any) => { s.nodes.standby.usage.indexes["public.orders_pkey"].last_idx_scan = "yesterday"; }],
    ["a scan count is negative", (s: any) => { s.nodes.primary.usage.tables["public.orders"].seq_scan = -1; }],
    ["a lock mode is unknown", (s: any) => { s.nodes.primary.locks[0].mode = "AccessExclusive"; }],
    ["a relation size is missing", (s: any) => { delete s.relations["public.orders"].total_bytes; }],
    ["an index has no table", (s: any) => { delete s.relations["public.orders_pkey"].table; }],
    ["a field is unknown", (s: any) => { s.nodes.primary.extra = true; }],
    ["the snapshot time is missing", (s: any) => { delete s.collected_at; }],
    ["an index belongs to a table the snapshot does not list", (s: any) => { s.relations["public.orders_pkey"].table = "public.customers"; }],
    ["a constraint's backing index is not a listed index", (s: any) => { s.constraints[0].index = "public.orders"; }],
    ["the usage window starts after the snapshot time", (s: any) => { s.usage_window_start = "2026-11-23T10:00:01.000+00:00"; }],
  ])("a snapshot is rejected when %s", (_label, corrupt) => {
    const s = clone();
    corrupt(s);
    expect(stateSnapshotSchema.safeParse(s).success).toBe(false);
  });
});

describe("snapshot fixtures for tests", () => {
  test("an empty fixture is a valid snapshot of a healthy two-node cluster", () => {
    const s = snapshotFixture();
    expect(stateSnapshotSchema.safeParse(s).error).toBeUndefined();
    expect(s.nodes.primary.replication.in_recovery).toBe(false);
    expect(s.nodes.standby.replication.in_recovery).toBe(true);
    expect(s.nodes.primary.locks).toEqual([]);
  });

  test("shared settings apply to both nodes, and per-node settings override them", () => {
    const s = snapshotFixture({
      settings: { work_mem: setting("4MB", "user"), shared_buffers: setting("128MB", "postmaster") },
      standby: { settings: { work_mem: setting("8MB", "user") } },
    });
    expect(s.nodes.primary.settings.work_mem).toMatchObject({ value: "4MB", context: "user" });
    expect(s.nodes.standby.settings.work_mem.value).toBe("8MB");
    expect(s.nodes.standby.settings.shared_buffers.context).toBe("postmaster");
  });

  test("tables, indexes and per-node usage can be given in a few lines", () => {
    const s = snapshotFixture({
      relations: {
        "public.orders": table({ total_bytes: 2 * 1024 ** 3 }),
        "public.orders_idx": index("public.orders"),
      },
      standby: { usage: { indexes: { "public.orders_idx": indexUsage("public.orders", "2026-11-23T09:59:00.000+00:00") } } },
    });
    expect(s.relations["public.orders"]).toMatchObject({ kind: "table", total_bytes: 2 * 1024 ** 3 });
    expect(scannedInWindow(s, s.nodes.standby.usage.indexes["public.orders_idx"].last_idx_scan)).toBe(true);
  });

  test("a fixture that is not a valid snapshot throws", () => {
    expect(() => snapshotFixture({ relations: { "public.orders_idx": index("public.missing") } })).toThrow();
  });
});

describe("policy review over a full snapshot", () => {
  test("a restart under a no-restart scope is found on each node from the snapshot's setting contexts", async () => {
    await loadParser();
    const cr = { id: "CR", task: "t", steps: [{ config: { name: "max_locks_per_transaction", value: "128" } }] };
    const scope = { allowed_objects: [], forbidden_actions: ["node.restart" as const], cluster_scope: false, downtime_allowed: [], extension_allowlist: [] };
    const result = reviewChangeRequest(cr, stateSnapshotSchema.parse(twoNode), scope);
    expect(result.findings.filter((f) => f.rule === "TS-2").map((f) => [f.rule, f.evidence.node])).toEqual([["TS-2", "primary"], ["TS-2", "standby"]]);
  });
});

describe("usage within the window", () => {
  const s = stateSnapshotSchema.parse(twoNode);
  const idx = "public.orders_customer_created_idx";

  test("an index the standby scanned inside the window counts as used there, not on the primary", () => {
    expect(scannedInWindow(s, s.nodes.standby.usage.indexes[idx].last_idx_scan)).toBe(true);
    expect(scannedInWindow(s, s.nodes.primary.usage.indexes[idx].last_idx_scan)).toBe(false);
  });

  test("a relation never scanned is not used", () => {
    expect(scannedInWindow(s, null)).toBe(false);
  });

  test("a scan exactly at the window start counts, a scan just before it does not", () => {
    expect(scannedInWindow(s, "2026-11-23T09:30:00.000+00:00")).toBe(true);
    expect(scannedInWindow(s, "2026-11-23T10:29:59.999+01:00")).toBe(false);
  });
});
