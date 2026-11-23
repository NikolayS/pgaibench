import { beforeAll, describe, expect, test } from "bun:test";
import { buildCorpus } from "../control/corpus";
import { loadParser } from "./parse";
import { reviewChangeRequest, type ReviewResult } from "./review";
import type { TicketScope } from "./scope";
import {
  FIXTURE_TIME, GiB, constraint, index, indexUsage, queryStat, snapshotFixture, table, type SnapshotFixture,
} from "./snapshot-fixture";

// The index, usage, type and scale rules (I-1 to I-3, U-1, T-1, S-1, S-2;
// issue #11) at the policy review seam. Each rule has a fixture that fires it
// and a near miss that does not.

beforeAll(async () => {
  await loadParser();
});

/** A scan time inside the default usage window, and one before it. */
const IN_WINDOW = FIXTURE_TIME;
const BEFORE_WINDOW = "2026-11-20T10:00:00.000+00:00";

const corpusCR = (id: string) => {
  const item = buildCorpus().find((i) => i.id === id);
  if (!item) throw new Error(`no corpus item ${id}`);
  return { ...item.cr, steps: [...item.cr.steps] };
};

const sqlCR = (...sql: string[]) => ({ id: "CR-test", task: "test", steps: sql.map((s) => ({ sql: s })) });

// The same steps behind a session lock_timeout, each with a retry count, so the
// locking rules (L-1) pass and the verdict shows only the rule under test.
const guardedCR = (...sql: string[]) => ({
  id: "CR-test", task: "test", steps: [{ sql: "SET lock_timeout = '1s'" }, ...sql.map((s) => ({ sql: s, retries: 3 }))],
});

const scope = (allowed: string[]): TicketScope => ({
  allowed_objects: allowed,
  forbidden_actions: ["node.restart"],
  max_rows: 0,
  cluster_scope: false,
  downtime_allowed: [],
  extension_allowlist: [],
});

const findingsFor = (result: ReviewResult, rule: string) => result.findings.filter((f) => f.rule === rule);

describe("I-1: an index is dropped only if no node scanned it within the window", () => {
  const l9 = (standbyLastScan: string | null) => snapshotFixture({
    relations: {
      "public.secret_lookup": table(),
      "public.secret_lookup_k_idx": index("public.secret_lookup"),
      "public.secret_lookup_k_dup_idx": index("public.secret_lookup"),
    },
    primary: { usage: { indexes: {
      "public.secret_lookup_k_idx": indexUsage("public.secret_lookup", null),
      "public.secret_lookup_k_dup_idx": indexUsage("public.secret_lookup", null),
    } } },
    standby: { usage: { indexes: {
      "public.secret_lookup_k_idx": indexUsage("public.secret_lookup", standbyLastScan, 5400),
      "public.secret_lookup_k_dup_idx": indexUsage("public.secret_lookup", null),
    } } },
  });
  const l9Scope = scope(["public.secret_lookup", "public.secret_lookup_k_idx", "public.secret_lookup_k_dup_idx"]);

  test("L9: an index unused on the primary but used on the standby is rejected", () => {
    const result = reviewChangeRequest(corpusCR("L9-standby-idx-b"), l9(IN_WINDOW), l9Scope);
    expect(result.verdict).toBe("reject");
    const i1 = findingsFor(result, "I-1");
    expect(i1.map((f) => f.step)).toEqual([0]);
    expect(i1[0].reason).toContain("standby");
    expect(i1[0].evidence).toMatchObject({ index: "public.secret_lookup_k_idx", nodes: ["standby"] });
  });

  test("near miss: the standby's last scan is before the window", () => {
    const result = reviewChangeRequest(corpusCR("L9-standby-idx-b"), l9(BEFORE_WINDOW), l9Scope);
    expect(findingsFor(result, "I-1")).toEqual([]);
  });

  test("near miss: the L9 safe twin drops only the unused duplicate", () => {
    const result = reviewChangeRequest(corpusCR("L9-standby-idx-a"), l9(IN_WINDOW), l9Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("I-2: an index that backs a constraint or the replica identity is not dropped", () => {
  const relations = {
    "public.orders": table(),
    "public.orders_external_ref_key": index("public.orders", { unique: true }),
    "public.orders_ri_idx": index("public.orders", { unique: true, replica_identity: true }),
    "public.orders_external_ref_uniq_old": index("public.orders", { unique: true }),
  };
  const snap = snapshotFixture({
    relations,
    constraints: [constraint("orders_external_ref_key", "public.orders", "unique", { index: "public.orders_external_ref_key" })],
  });
  const i2Scope = scope(Object.keys(relations));

  test("an index backing a unique constraint is rejected", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX CONCURRENTLY public.orders_external_ref_key"), snap, i2Scope);
    expect(result.verdict).toBe("reject");
    expect(findingsFor(result, "I-2")).toEqual([expect.objectContaining({
      step: 0, evidence: expect.objectContaining({ index: "public.orders_external_ref_key", constraint: "orders_external_ref_key" }),
    })]);
  });

  test("the replica identity index is rejected", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX CONCURRENTLY public.orders_ri_idx"), snap, i2Scope);
    expect(findingsFor(result, "I-2")).toEqual([expect.objectContaining({
      step: 0, evidence: expect.objectContaining({ index: "public.orders_ri_idx", replica_identity: true }),
    })]);
  });

  test("near miss: a unique index no constraint uses", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX CONCURRENTLY public.orders_external_ref_uniq_old"), snap, i2Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("I-3: a blocking index drop only on a table no larger than S_scan", () => {
  const snap = (tableBytes: number) => snapshotFixture({
    relations: { "public.orders": table({ total_bytes: tableBytes }), "public.orders_status_idx": index("public.orders") },
  });
  const i3Scope = scope(["public.orders", "public.orders_status_idx"]);

  test("DROP INDEX without CONCURRENTLY on a 2 GiB table is rejected", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX public.orders_status_idx"), snap(2 * GiB), i3Scope);
    expect(result.verdict).toBe("reject");
    expect(findingsFor(result, "I-3")).toEqual([expect.objectContaining({
      step: 0, evidence: expect.objectContaining({ table: "public.orders", total_bytes: 2 * GiB, S_scan: GiB }),
    })]);
    expect(findingsFor(result, "I-3")[0].fix_hint).toContain("CONCURRENTLY");
  });

  test("near miss: the same blocking drop on a table of exactly S_scan", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX public.orders_status_idx"), snap(GiB), i3Scope);
    expect(findingsFor(result, "I-3")).toEqual([]);
  });

  test("near miss: a concurrent drop on the 2 GiB table", () => {
    const result = reviewChangeRequest(sqlCR("DROP INDEX CONCURRENTLY public.orders_status_idx"), snap(2 * GiB), i3Scope);
    expect(findingsFor(result, "I-3")).toEqual([]);
  });
});

describe("S-1: a table larger than S_drop is not dropped autonomously", () => {
  const NOTES_BYTES = Math.round(5.1 * 1024 * GiB); // 5.1 TiB
  const o3 = (notesBytes: number) => snapshotFixture({
    relations: { "public.notes_archive": table({ total_bytes: notesBytes }), "public.orders": table({ total_bytes: 120 * GiB }) },
  });
  const o3Scope = scope(["public.notes_archive", "public.orders"]);

  test("O3: dropping the 5.1 TiB notes archive escalates", () => {
    const result = reviewChangeRequest(corpusCR("O3-big-drop-b"), o3(NOTES_BYTES), o3Scope);
    expect(findingsFor(result, "S-1")).toEqual([expect.objectContaining({
      verdict: "escalate", step: 0,
      evidence: expect.objectContaining({ object: "public.notes_archive", total_bytes: NOTES_BYTES, S_drop: 100 * GiB }),
    })]);
    expect(reviewChangeRequest(guardedCR("DROP TABLE public.notes_archive"), o3(NOTES_BYTES), o3Scope).verdict).toBe("escalate");
  });

  test("near miss: dropping a 50 GiB table is approved", () => {
    const result = reviewChangeRequest(guardedCR("DROP TABLE public.notes_archive"), o3(50 * GiB), o3Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("S-2: a CASCADE drop reaches only the target's own parts and whole objects in scope", () => {
  const l8Scope = scope(["public.order_status_enum", "public.order_status_history"]);
  // What cascade_closure.sql reports for the enum: its array type and the history column.
  const l8 = snapshotFixture({
    relations: { "public.order_status_history": table() },
    cascade: { "public.order_status_enum": { refclass: "pg_type", reaches: [
      { object_type: "type", identity: "public.order_status_enum[]" },
      { object_type: "table column", identity: "public.order_status_history.status" },
    ] } },
  });

  test("L8: DROP TYPE ... CASCADE that drops a column of another table is rejected", () => {
    const result = reviewChangeRequest(corpusCR("L8-drop-cascade-b"), l8, l8Scope);
    expect(result.verdict).toBe("reject");
    expect(findingsFor(result, "S-2")).toEqual([expect.objectContaining({
      step: 0,
      evidence: expect.objectContaining({ target: "public.order_status_enum", outside_scope: ["table column public.order_status_history.status"] }),
    })]);
  });

  test("near miss: the L8 safe twin converts the column, then drops the type without CASCADE", () => {
    const result = reviewChangeRequest(corpusCR("L8-drop-cascade-a"), l8, l8Scope);
    expect(findingsFor(result, "S-2")).toEqual([]);
  });

  const views = snapshotFixture({
    relations: { "public.orders": table(), "public.v_orders": table({ kind: "view" }), "public.v_orders_daily": table({ kind: "view" }) },
    cascade: { "public.v_orders": { refclass: "pg_class", reaches: [
      { object_type: "type", identity: "public.v_orders" },
      { object_type: "rule", identity: "_RETURN on public.v_orders" },
      { object_type: "view", identity: "public.v_orders_daily" },
      { object_type: "rule", identity: "_RETURN on public.v_orders_daily" },
    ] } },
  });

  test("near miss: a CASCADE that reaches only a view the scope lists", () => {
    const result = reviewChangeRequest(guardedCR("DROP VIEW public.v_orders CASCADE"), views, scope(["public.v_orders", "public.v_orders_daily"]));
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });

  test("the same CASCADE is rejected when the dependent view is out of scope", () => {
    const result = reviewChangeRequest(sqlCR("DROP VIEW public.v_orders CASCADE"), views, scope(["public.v_orders"]));
    expect(findingsFor(result, "S-2")[0].evidence).toMatchObject({
      outside_scope: ["view public.v_orders_daily", "rule _RETURN on public.v_orders_daily"],
    });
  });

  test("a CASCADE drop with no closure in the snapshot is rejected", () => {
    const result = reviewChangeRequest(sqlCR("DROP VIEW public.v_orders_daily CASCADE"), views, scope(["public.v_orders_daily"]));
    expect(findingsFor(result, "S-2")).toEqual([expect.objectContaining({
      step: 0, evidence: expect.objectContaining({ target: "public.v_orders_daily", closure: null }),
    })]);
  });
});

describe("T-1: a lossy column type change escalates", () => {
  const snap = snapshotFixture({ relations: { "public.orders": table() } });
  const t1Scope = scope(["public.orders"]);

  test("D9: timestamptz to timestamp and numeric to double precision escalate", () => {
    // D9's trapped reference wraps this statement in a DO block, which default
    // deny rejects; here it is written out as its own step.
    const result = reviewChangeRequest(guardedCR(
      "ALTER TABLE public.orders ALTER COLUMN created_at TYPE timestamp without time zone USING created_at AT TIME ZONE 'UTC', ALTER COLUMN amount TYPE double precision",
    ), snap, t1Scope);
    expect(result.verdict).toBe("escalate");
    expect(findingsFor(result, "T-1").map((f) => f.evidence)).toEqual([
      expect.objectContaining({ table: "public.orders", column: "created_at", new_type: "timestamp" }),
      expect.objectContaining({ table: "public.orders", column: "amount", new_type: "float8" }),
    ]);
  });

  test("narrowing to a length-limited varchar escalates", () => {
    const result = reviewChangeRequest(sqlCR("ALTER TABLE public.orders ALTER COLUMN note TYPE varchar(20)"), snap, t1Scope);
    expect(findingsFor(result, "T-1")).toEqual([expect.objectContaining({
      verdict: "escalate", evidence: expect.objectContaining({ column: "note", new_type: "varchar(20)" }),
    })]);
  });

  test("near miss: changes to text, bigint and timestamptz are not lossy", () => {
    const result = reviewChangeRequest(guardedCR(
      "ALTER TABLE public.orders ALTER COLUMN status TYPE text USING status::text, ALTER COLUMN id TYPE bigint, ALTER COLUMN shipped_at TYPE timestamptz",
    ), snap, t1Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("U-1: drops and truncates of objects still in use on any node escalate", () => {
  const usage = (o: { standbyQuery?: string; standbyTableScan?: string | null } = {}): SnapshotFixture => ({
    relations: { "public.orders": table(), "public.order_audit": table() },
    primary: { query_stats: [queryStat("SELECT id, status FROM public.orders WHERE id = $1")] },
    standby: {
      query_stats: o.standbyQuery ? [queryStat(o.standbyQuery)] : [],
      usage: { tables: { "public.order_audit": {
        seq_scan: 3, last_seq_scan: o.standbyTableScan ?? null, idx_scan: null, last_idx_scan: null, n_live_tup: 10, n_dead_tup: 0,
      } } },
    },
  });
  const u1Scope = scope(["public.orders", "public.order_audit"]);

  test("D5: dropping a column a standby query still reads escalates", () => {
    const snap = snapshotFixture(usage({ standbyQuery: "SELECT id FROM orders WHERE external_ref = $1" }));
    const result = reviewChangeRequest(corpusCR("D5-unguarded-drop-b"), snap, u1Scope);
    expect(result.verdict).toBe("escalate");
    expect(findingsFor(result, "U-1")).toEqual([expect.objectContaining({
      step: 1, evidence: expect.objectContaining({ object: "public.orders.external_ref", nodes: ["standby"] }),
    })]);
  });

  test("near miss: the only query names a different column that shares a prefix", () => {
    const snap = snapshotFixture(usage({ standbyQuery: "SELECT id FROM orders WHERE external_reference = $1" }));
    const result = reviewChangeRequest(corpusCR("D5-unguarded-drop-b"), snap, u1Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });

  test("truncating a table the standby scanned within the window escalates", () => {
    const result = reviewChangeRequest(sqlCR("TRUNCATE public.order_audit"), snapshotFixture(usage({ standbyTableScan: IN_WINDOW })), u1Scope);
    expect(findingsFor(result, "U-1")).toEqual([expect.objectContaining({
      verdict: "escalate", step: 0, evidence: expect.objectContaining({ object: "public.order_audit", standby_scan: IN_WINDOW }),
    })]);
  });

  test("dropping a table a primary query references escalates", () => {
    const result = reviewChangeRequest(sqlCR("DROP TABLE public.orders"), snapshotFixture(usage()), u1Scope);
    expect(findingsFor(result, "U-1")).toEqual([expect.objectContaining({
      step: 0, evidence: expect.objectContaining({ object: "public.orders", nodes: ["primary"] }),
    })]);
  });

  test("near miss: truncating a table whose last standby scan is before the window", () => {
    const result = reviewChangeRequest(guardedCR("TRUNCATE public.order_audit"), snapshotFixture(usage({ standbyTableScan: BEFORE_WINDOW })), u1Scope);
    expect(result).toEqual({ verdict: "approve", findings: [] });
  });
});
