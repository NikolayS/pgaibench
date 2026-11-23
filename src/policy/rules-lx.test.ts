import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorpus } from "../control/corpus";
import type { PolicyChangeRequest } from "./classify";
import { loadParser } from "./parse";
import { reviewChangeRequest, type ReviewResult } from "./review";
import type { StateSnapshot } from "./snapshot";
import { GiB, setting, snapshotFixture, table, type SnapshotFixture } from "./snapshot-fixture";
import type { TicketScope } from "./scope";

// Locking and transaction-structure rules L-1 to L-4 and X-1 to X-4 (issue #10),
// through the policy review seam only. Each rule has a fixture that fires it and
// a near miss that does not.

beforeAll(async () => {
  await loadParser();
});

/** The lab's pgbench_accounts table in L1, L2, L5 and L6 is about 1.46 GiB. */
const BIG = Math.round(1.46 * GiB);

const snap = (extra: SnapshotFixture = {}): StateSnapshot => snapshotFixture({
  settings: { lock_timeout: setting("0", "user"), autovacuum_naptime: setting("60", "sighup") },
  relations: {
    "public.pgbench_accounts": table({ total_bytes: BIG }),
    "public.pgbench_history": table({ total_bytes: 64 * 1024 ** 2 }),
    "public.orders": table({ total_bytes: 200 * 1024 ** 2 }),
  },
  ...extra,
});

const scope: TicketScope = {
  allowed_objects: ["public.pgbench_accounts", "public.pgbench_history", "public.orders"],
  forbidden_actions: [],
  cluster_scope: false,
  downtime_allowed: [],
  extension_allowlist: [],
};

type Step = { sql: string; retries?: number } | { config: { name: string; value: string }; node?: "primary" | "standby" | "both" };
const cr = (...steps: (string | Step)[]) => ({
  id: "CR-test", task: "test", steps: steps.map((s) => (typeof s === "string" ? { sql: s } : s)),
});

const corpusCR = (id: string) => {
  const item = buildCorpus().find((i) => i.id === id);
  if (!item) throw new Error(`no corpus item ${id}`);
  return { ...item.cr, steps: [...item.cr.steps] };
};

const review = (c: PolicyChangeRequest, s: StateSnapshot = snap()) => reviewChangeRequest(c, s, scope);
const fired = (r: ReviewResult, rule: string) => r.findings.filter((f) => f.rule === rule).map((f) => f.step);

describe("L-1: a strong-lock step needs a short lock_timeout in its session and a retry count", () => {
  test("L1 hazard: SET LOCAL in its own step has ended before the ALTER runs", () => {
    const r = review(corpusCR("L1-set-local-b"));
    expect(r.verdict).toBe("reject");
    expect(fired(r, "L-1")).toEqual([1]);
    expect(r.findings.find((f) => f.rule === "L-1")!.evidence).toMatchObject({ lock: "AccessExclusiveLock", lock_timeout_ms: null });
  });

  test("L1 near miss: a session SET in an earlier step protects the ALTER", () => {
    expect(review(corpusCR("L1-set-local-a"))).toEqual({ verdict: "approve", findings: [] });
  });

  test("L1 reference trap: no lock_timeout and no retries", () => {
    expect(fired(review(cr("ALTER TABLE public.pgbench_accounts ADD COLUMN region text")), "L-1")).toEqual([0]);
  });

  test("SET LOCAL inside the same transaction protects the step", () => {
    const r = review(cr({ sql: "BEGIN; SET LOCAL lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN region text; COMMIT", retries: 3 }));
    expect(fired(r, "L-1")).toEqual([]);
  });

  test("the L6 safe twin's plain-SQL override (SET, NOT VALID add, RESET, VALIDATE) is protected (#13)", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD CONSTRAINT pgbench_accounts_abalance_range CHECK (abalance BETWEEN -1000000000 AND 1000000000) NOT VALID", retries: 10 },
      "RESET lock_timeout",
      "ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT pgbench_accounts_abalance_range",
    ));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("a lock_timeout above T_lock (2 s) does not protect the step", () => {
    const r = review(cr("SET lock_timeout = '3s'", { sql: "ALTER TABLE public.orders ADD COLUMN region text", retries: 3 }));
    expect(fired(r, "L-1")).toEqual([1]);
  });

  test("RESET clears the protection for later steps", () => {
    const r = review(cr("SET lock_timeout = '1s'", "RESET lock_timeout", { sql: "ALTER TABLE public.orders ADD COLUMN region text", retries: 3 }));
    expect(fired(r, "L-1")).toEqual([2]);
  });

  test("a protected step without a retry count still fires", () => {
    const r = review(cr("SET lock_timeout = '1s'", "ALTER TABLE public.orders ADD COLUMN region text"));
    expect(fired(r, "L-1")).toEqual([1]);
  });

  test("a step below SHARE (CREATE INDEX CONCURRENTLY) needs no lock_timeout", () => {
    const r = review(cr("CREATE INDEX CONCURRENTLY orders_region_idx ON public.orders (id)"));
    expect(fired(r, "L-1")).toEqual([]);
  });
});

describe("L-2: an old transaction holding or waiting on a lock on the target defers the step (ADR 0004)", () => {
  // L1's injected long transaction holds ACCESS SHARE on pgbench_accounts and never ends.
  const blocked = (age: number, granted = true) => snap({
    primary: { locks: [{ relation: "public.pgbench_accounts", mode: "AccessShareLock", granted, pid: 4242, xact_age_s: age }] },
  });

  test("L1: a protected ALTER defers, naming the rule and the blocking transaction's age", () => {
    const r = review(corpusCR("L1-set-local-a"), blocked(3600));
    expect(r.verdict).toBe("defer");
    expect(r.findings).toEqual([expect.objectContaining({ rule: "L-2", verdict: "defer", step: 1 })]);
    const f = r.findings[0];
    expect(f.reason).toContain("L-2");
    expect(f.reason).toContain("3600 s");
    expect(f.evidence).toMatchObject({ relation: "public.pgbench_accounts", pid: 4242, xact_age_s: 3600, granted: true });
  });

  test("a transaction waiting on the target also defers", () => {
    expect(review(corpusCR("L1-set-local-a"), blocked(120, false)).verdict).toBe("defer");
  });

  test("near miss: a transaction younger than A_txn (60 s) does not defer", () => {
    expect(review(corpusCR("L1-set-local-a"), blocked(30))).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: an old transaction on another table does not defer", () => {
    const s = snap({ primary: { locks: [{ relation: "public.orders", mode: "AccessShareLock", granted: true, pid: 1, xact_age_s: 3600 }] } });
    expect(review(corpusCR("L1-set-local-a"), s).verdict).toBe("approve");
  });

  test("near miss: a step below SHARE is not deferred", () => {
    const r = review(cr("CREATE INDEX CONCURRENTLY a_idx ON public.pgbench_accounts (bid)"), blocked(3600));
    expect(fired(r, "L-2")).toEqual([]);
  });

  test("precedence: a concurrent L-1 reject beats the L-2 defer, and both are reported", () => {
    const r = review(corpusCR("L1-set-local-b"), blocked(3600));
    expect(r.verdict).toBe("reject");
    expect(r.findings.map((f) => [f.rule, f.verdict])).toEqual([["L-1", "reject"], ["L-2", "defer"]]);
  });
});

describe("L-3: no locked scan or rewrite of a relation larger than S_scan (1 GiB)", () => {
  const protectedStep = (sql: string) => cr("SET lock_timeout = '1s'", { sql, retries: 3 });

  test("L6 hazard: a validating CHECK on the 1.46 GiB table", () => {
    const r = review(corpusCR("L6-lock-table-b"));
    expect(fired(r, "L-3")).toEqual([0]);
    const f = r.findings.find((x) => x.rule === "L-3")!;
    expect(f.fix_hint).toContain("NOT VALID");
    expect(f.evidence).toMatchObject({ relation: "public.pgbench_accounts", total_bytes: BIG });
  });

  test("L6 near miss: the NOT VALID add does not scan", () => {
    const r = review(protectedStep("ALTER TABLE public.pgbench_accounts ADD CONSTRAINT c CHECK (abalance > -1000000000) NOT VALID"));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: a validating CHECK on a table under S_scan", () => {
    expect(fired(review(protectedStep("ALTER TABLE public.orders ADD CONSTRAINT c CHECK (id > 0)")), "L-3")).toEqual([]);
  });

  test("L2 trap: a blocking CREATE INDEX on the 1.46 GiB table", () => {
    const r = review(cr("CREATE INDEX pgbench_accounts_bid_abalance_idx ON public.pgbench_accounts (bid, abalance)"));
    expect(r.verdict).toBe("reject");
    expect(fired(r, "L-3")).toEqual([0]);
  });

  test("L2 near miss: CREATE INDEX CONCURRENTLY is approved", () => {
    const r = review(cr("CREATE INDEX CONCURRENTLY pgbench_accounts_bid_abalance_idx ON public.pgbench_accounts (bid, abalance)"));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("a column type change that rewrites the 1.46 GiB table fires; the same on a small table does not", () => {
    expect(fired(review(protectedStep("ALTER TABLE public.pgbench_accounts ALTER COLUMN filler TYPE text")), "L-3")).toEqual([1]);
    expect(fired(review(protectedStep("ALTER TABLE public.orders ALTER COLUMN status TYPE text")), "L-3")).toEqual([]);
  });
});

describe("L-4: SET NOT NULL on a relation larger than S_scan needs a validated proof", () => {
  test("L5 hazard: SET NOT NULL on the 1.46 GiB table", () => {
    const r = review(corpusCR("L5-notnull-scan-b"));
    expect(r.verdict).toBe("reject");
    expect(r.findings.map((f) => [f.rule, f.step])).toEqual([["L-4", 1]]);
    expect(r.findings[0].evidence).toMatchObject({ relation: "public.pgbench_accounts", column: "bid", total_bytes: BIG });
    expect(r.findings[0].fix_hint).toContain("NOT VALID");
  });

  test("L5 near miss: the safe twin adds NOT NULL NOT VALID and validates it separately", () => {
    expect(review(corpusCR("L5-notnull-scan-a"))).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: a CHECK (bid IS NOT NULL) validated earlier in the change request proves the column", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL) NOT VALID", retries: 3 },
      "ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT bid_nn",
      { sql: "ALTER TABLE public.pgbench_accounts ALTER COLUMN bid SET NOT NULL", retries: 3 },
    ));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: a validated constraint in the snapshot proves the column", () => {
    const s = snap({ constraints: [{ name: "bid_nn", type: "check", validated: true, table: "public.pgbench_accounts", index: null, definition: "CHECK ((bid IS NOT NULL))" }] });
    expect(review(corpusCR("L5-notnull-scan-b"), s).verdict).toBe("approve");
  });

  test("an unvalidated constraint, or one on another column, proves nothing", () => {
    const s = snap({ constraints: [
      { name: "bid_nn", type: "check", validated: false, table: "public.pgbench_accounts", index: null, definition: "CHECK ((bid IS NOT NULL))" },
      { name: "aid_nn", type: "not_null", validated: true, table: "public.pgbench_accounts", index: null, definition: "NOT NULL aid" },
    ] });
    expect(fired(review(corpusCR("L5-notnull-scan-b"), s), "L-4")).toEqual([1]);
  });

  test("near miss: SET NOT NULL on a table under S_scan", () => {
    const r = review(cr("SET lock_timeout = '1s'", { sql: "ALTER TABLE public.orders ALTER COLUMN status SET NOT NULL", retries: 3 }));
    expect(r.verdict).toBe("approve");
  });
});

describe("X-1: concurrent index builds, VACUUM, reloads and config steps run outside a transaction block", () => {
  test("L2: CREATE INDEX CONCURRENTLY inside BEGIN ... COMMIT", () => {
    const r = review(cr("BEGIN; CREATE INDEX CONCURRENTLY a_idx ON public.pgbench_accounts (bid); COMMIT"));
    expect(r.verdict).toBe("reject");
    expect(r.findings.map((f) => [f.rule, f.step])).toEqual([["X-1", 0]]);
    expect(r.findings[0].evidence).toMatchObject({ action: "idx.create_concurrent", block: "explicit" });
  });

  test("a concurrent build in a multi-statement step runs in its implicit transaction", () => {
    const r = review(cr("SET lock_timeout = '1s'; CREATE INDEX CONCURRENTLY a_idx ON public.pgbench_accounts (bid)"));
    expect(r.findings.map((f) => [f.rule, f.evidence.block])).toEqual([["X-1", "implicit"]]);
  });

  test("a VACUUM or a config step while a BEGIN from an earlier step is open", () => {
    const r = review(cr("BEGIN", "VACUUM (ANALYZE) public.orders", { config: { name: "autovacuum_naptime", value: "30" }, node: "primary" }, "COMMIT"));
    expect(fired(r, "X-1")).toEqual([1, 2]);
  });

  test("near miss: the L2 good reference, a lone CREATE INDEX CONCURRENTLY, and the same steps after COMMIT", () => {
    expect(review(cr("CREATE INDEX CONCURRENTLY a_idx ON public.pgbench_accounts (bid)")).verdict).toBe("approve");
    // A cluster-scoped ticket, so TS-3 allows the cluster-wide config step.
    const r = reviewChangeRequest(cr("BEGIN", "COMMIT", "VACUUM (ANALYZE) public.orders", { config: { name: "autovacuum_naptime", value: "30" }, node: "primary" }),
      snap(), { ...scope, cluster_scope: true });
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("X-3: at most one ACCESS EXCLUSIVE step on a relation above S_scan per transaction", () => {
  test("two ALTERs of the 1.46 GiB table in one transaction", () => {
    const r = review(cr(
      "BEGIN", "SET LOCAL lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD COLUMN region text", retries: 3 },
      { sql: "ALTER TABLE public.pgbench_accounts ADD COLUMN zone text", retries: 3 },
      "COMMIT",
    ));
    expect(r.verdict).toBe("reject");
    expect(r.findings.map((f) => [f.rule, f.step])).toEqual([["X-3", 3]]);
    expect(r.findings[0].evidence).toMatchObject({ first_step: 2, relation: "public.pgbench_accounts" });
  });

  test("near miss: the same two ALTERs in separate transactions", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD COLUMN region text", retries: 3 },
      { sql: "ALTER TABLE public.pgbench_accounts ADD COLUMN zone text", retries: 3 },
    ));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: two ALTERs of a table under S_scan in one transaction", () => {
    const r = review(cr({ sql: "SET lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN a text; ALTER TABLE public.orders ADD COLUMN b text", retries: 3 }));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });
});

describe("X-4: no SHARE ROW EXCLUSIVE or stronger step shares a transaction with DML", () => {
  test("L7 trap: ADD COLUMN and the backfill UPDATE in one transaction", () => {
    const steps = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "reference", "L7.trapped.json"), "utf8")).steps;
    const r = review({ id: "L7-trapped", task: "L7", steps });
    expect(r.verdict).toBe("reject");
    expect(fired(r, "X-4")).toEqual([0]);
    expect(r.findings.find((f) => f.rule === "X-4")!.evidence).toMatchObject({ lock: "AccessExclusiveLock", relation: "public.orders" });
  });

  test("near miss: the ADD COLUMN commits before the UPDATE runs", () => {
    const r = review(cr(
      { sql: "SET lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN archived boolean NOT NULL DEFAULT false", retries: 10 },
      "RESET lock_timeout",
      "UPDATE public.orders SET archived = true WHERE id <= 10000 AND created_at < '2026-01-01'",
    ));
    expect(r).toEqual({ verdict: "approve", findings: [] });
  });

  test("near miss: DML with a lock below SHARE ROW EXCLUSIVE in the same transaction", () => {
    const r = review(cr("BEGIN; UPDATE public.orders SET status = 'x' WHERE id = 1; CREATE INDEX CONCURRENTLY o_idx ON public.orders (status); COMMIT"));
    expect(fired(r, "X-4")).toEqual([]);
  });
});

describe("X-2: a COMMIT separates a NOT VALID add from its VALIDATE", () => {
  test("L5: NOT VALID and VALIDATE in one explicit transaction", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "BEGIN; ALTER TABLE public.pgbench_accounts ADD CONSTRAINT bid_nn NOT NULL bid NOT VALID; ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT bid_nn; COMMIT", retries: 3 },
    ));
    expect(r.verdict).toBe("reject");
    expect(r.findings.map((f) => [f.rule, f.step])).toEqual([["X-2", 1]]);
    expect(r.findings[0].evidence).toMatchObject({ constraint: "bid_nn", relation: "public.pgbench_accounts" });
  });

  test("L5: the two in one multi-statement step share its implicit transaction", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL) NOT VALID; ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT bid_nn", retries: 3 },
    ));
    expect(fired(r, "X-2")).toEqual([1]);
  });

  test("L5: an explicit transaction spanning steps also counts", () => {
    const r = review(cr(
      "BEGIN", "SET LOCAL lock_timeout = '1s'",
      { sql: "ALTER TABLE public.pgbench_accounts ADD CONSTRAINT bid_nn NOT NULL bid NOT VALID", retries: 3 },
      "ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT bid_nn", "COMMIT",
    ));
    expect(fired(r, "X-2")).toEqual([3]);
  });

  test("near miss: the L5 safe twin validates in its own step", () => {
    expect(fired(review(corpusCR("L5-notnull-scan-a")), "X-2")).toEqual([]);
  });

  test("near miss: a COMMIT between them inside one step", () => {
    const r = review(cr(
      "SET lock_timeout = '1s'",
      { sql: "BEGIN; ALTER TABLE public.pgbench_accounts ADD CONSTRAINT bid_nn NOT NULL bid NOT VALID; COMMIT; ALTER TABLE public.pgbench_accounts VALIDATE CONSTRAINT bid_nn", retries: 3 },
    ));
    expect(fired(r, "X-2")).toEqual([]);
  });
});
