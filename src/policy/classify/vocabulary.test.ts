import { describe, expect, test } from "bun:test";
import { constraint, snapshotFixture, table } from "../snapshot-fixture";
import { cleanSnapshot, cr } from "../test-kit";
import { classify } from "./index";

// Statements added to the action vocabulary once DO bodies were classified
// (#22): ALTER TABLE ... DROP CONSTRAINT, ALTER TABLE ... RESET (...), and
// LOCK TABLE.

const run = (...steps: Parameters<typeof cr>) => classify(cr(...steps), cleanSnapshot);

describe("ALTER TABLE ... DROP CONSTRAINT", () => {
  test("is ddl.drop_constraint under ACCESS EXCLUSIVE on the table", () => {
    const { actions, denials } = run("ALTER TABLE public.orders DROP CONSTRAINT orders_status_check");
    expect(denials).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({
      action: "ddl.drop_constraint", objects: ["public.orders"], constraint: { name: "orders_status_check" },
      lock: expect.objectContaining({ mode: "AccessExclusiveLock", scans: false, rewrites: false, relations: ["public.orders"] }),
    })]);
  });

  test("dropping a foreign key also touches and locks the referenced table", () => {
    const snapshot = snapshotFixture({
      relations: { "public.orders": table(), "public.customers": table() },
      constraints: [constraint("orders_customer_fk", "public.orders", "foreign_key", { references: "public.customers" })],
    });
    const { actions } = classify(cr("ALTER TABLE public.orders DROP CONSTRAINT orders_customer_fk"), snapshot);
    expect(actions[0]).toMatchObject({
      objects: ["public.orders", "public.customers"],
      constraint: { name: "orders_customer_fk", type: "foreign_key" },
      lock: { mode: "AccessExclusiveLock", relations: ["public.orders", "public.customers"] },
    });
  });
});

describe("ALTER TABLE ... RESET (storage parameters)", () => {
  test("is ddl.set_reloption with the parameters it resets", () => {
    const { actions, denials } = run("ALTER TABLE public.orders RESET (autovacuum_enabled, toast.autovacuum_vacuum_scale_factor)");
    expect(denials).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({
      action: "ddl.set_reloption", options: {}, reset: ["autovacuum_enabled", "toast.autovacuum_vacuum_scale_factor"],
      lock: expect.objectContaining({ mode: "ShareUpdateExclusiveLock" }),
    })]);
  });

  test("merges with SET in the same statement into one action", () => {
    const { actions } = run("ALTER TABLE public.orders SET (fillfactor = 90), RESET (autovacuum_enabled)");
    expect(actions).toEqual([expect.objectContaining({ action: "ddl.set_reloption", options: { fillfactor: "90" }, reset: ["autovacuum_enabled"] })]);
  });

  test("a SET alone carries no reset list", () => {
    expect(run("ALTER TABLE public.orders SET (fillfactor = 90)").actions[0]).not.toHaveProperty("reset");
  });
});

describe("LOCK TABLE", () => {
  test("in a transaction is lock.table with the mode it asks for, on every table it names", () => {
    const { actions, denials } = run("BEGIN; LOCK TABLE public.orders, secret_lookup IN SHARE ROW EXCLUSIVE MODE; COMMIT");
    expect(denials).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({
      action: "lock.table", objects: ["public.orders", "public.secret_lookup"],
      lock: { mode: "ShareRowExclusiveLock", scans: false, rewrites: false, relations: ["public.orders", "public.secret_lookup"] },
    })]);
  });

  test("with no mode takes ACCESS EXCLUSIVE", () => {
    expect(run("BEGIN; LOCK public.orders; COMMIT").actions[0].lock.mode).toBe("AccessExclusiveLock");
  });

  test("inside a plain DO block is classified, even as its only statement", () => {
    expect(run("DO $$ BEGIN LOCK TABLE public.orders IN SHARE MODE; END $$").denials).toEqual([]);
    expect(run("DO $$ BEGIN SET LOCAL lock_timeout = '1s'; LOCK TABLE public.orders IN SHARE MODE; END $$").actions.at(-1))
      .toMatchObject({ action: "lock.table", session: { lock_timeout_ms: 1000 } });
  });

  test("outside any transaction is denied, since Postgres rejects it", () => {
    const { actions, denials } = run("LOCK TABLE public.orders IN SHARE MODE");
    expect(actions).toEqual([]);
    expect(denials).toEqual([expect.objectContaining({ step: 0, code: "lock_outside_txn", verdict: "reject" })]);
  });
});
