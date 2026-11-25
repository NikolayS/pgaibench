import { describe, expect, test } from "bun:test";
import { cleanSnapshot, cr } from "../test-kit";
import { classify } from "./index";

// DO blocks (#22, ADR 0005). A DO block whose body is only a list of plain SQL
// statements is classified statement by statement; any other body stays
// denied, since the gate cannot see what it does.

const run = (...steps: Parameters<typeof cr>) => classify(cr(...steps), cleanSnapshot);

describe("a DO block with a plain body", () => {
  test("classifies each statement in it, at the DO's step", () => {
    const { actions, denials } = run(
      "SELECT 1",
      "DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN region text; END $$",
    );
    expect(denials).toEqual([]);
    expect(actions.map((a) => [a.step, a.action])).toEqual([
      [0, "query.read"], [1, "cfg.set_session"], [1, "ddl.add_column"],
    ]);
  });

  test("runs its statements in one transaction, so SET LOCAL holds for the statements after it", () => {
    const { actions } = run("DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN region text; END $$");
    const [set, add] = actions;
    expect(add.session.lock_timeout_ms).toBe(1000);
    expect(add.txn.group).toBe(set.txn.group);
    expect(add.txn.block).toBe("implicit");
  });

  test("ends its SET LOCAL with the DO, when the step runs outside an explicit transaction", () => {
    const { actions } = run(
      "DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ALTER TABLE public.orders ADD COLUMN a text; END $$",
      "ALTER TABLE public.orders ADD COLUMN b text",
    );
    expect(actions.at(-1)!.session.lock_timeout_ms).toBeNull();
  });

  test("denies a statement inside it as it would at top level", () => {
    const { denials } = run("DO $$ BEGIN ALTER SYSTEM SET work_mem = '64MB'; END $$");
    expect(denials).toEqual([expect.objectContaining({ step: 0, code: "alter_system" })]);
  });

  test("sees a session kill inside it", () => {
    const { denials } = run("DO $$ BEGIN SELECT pg_terminate_backend(42); END $$");
    expect(denials).toEqual([expect.objectContaining({ code: "session_kill", verdict: "escalate" })]);
  });

  test("lets the step's expected_rows bound its one DML statement", () => {
    const { actions } = run({ sql: "DO $$ BEGIN SET LOCAL lock_timeout = '1s'; UPDATE public.orders SET status = 'x' WHERE id < 10; END $$", expected_rows: 9 });
    expect(actions.find((a) => a.action === "dml.bounded")).toMatchObject({ expected_rows: 9 });
  });
});

describe("a DO block with anything but plain statements stays denied", () => {
  test.each([
    ["a loop", "DO $$ DECLARE lo bigint; BEGIN FOR lo IN SELECT generate_series(0, 10, 5) LOOP UPDATE public.orders SET status = 'x' WHERE id > lo; COMMIT; END LOOP; END $$"],
    ["a declared variable", "DO $$ DECLARE n int := 1; BEGIN UPDATE public.orders SET status = 'x' WHERE id = n; END $$"],
    ["an IF", "DO $$ BEGIN IF true THEN UPDATE public.orders SET status = 'x'; END IF; END $$"],
    ["an exception handler", "DO $$ BEGIN UPDATE public.orders SET status = 'x'; EXCEPTION WHEN others THEN NULL; END $$"],
    ["dynamic SQL", "DO $$ BEGIN EXECUTE 'UPDATE public.orders SET status = ''x'''; END $$"],
    ["PERFORM", "DO $$ BEGIN PERFORM count(*) FROM public.orders; END $$"],
    ["SELECT INTO", "DO $$ BEGIN SELECT 1 INTO STRICT found; END $$"],
    ["RAISE", "DO $$ BEGIN RAISE NOTICE 'hi'; END $$"],
    ["a COMMIT", "DO $$ BEGIN UPDATE public.orders SET status = 'x'; COMMIT; END $$"],
    ["another language", "DO LANGUAGE plperl $$ print 1 $$"],
  ])("%s", (_label, sql) => {
    const { actions, denials } = run(sql);
    expect(actions).toEqual([]);
    expect(denials).toEqual([expect.objectContaining({ step: 0, code: "do_block", verdict: "reject" })]);
  });

  test("the denial names what the gate cannot see", () => {
    const { denials } = run("DO $$ BEGIN IF true THEN UPDATE public.orders SET status = 'x'; END IF; END $$");
    expect(denials[0].reason).toContain("IF");
  });
});
