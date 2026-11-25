import { describe, expect, test } from "bun:test";
import { appliesTo, appliesToError } from "./applies-to";
import { cleanSnapshot, cr } from "./test-kit";
import { classify } from "./classify";

// A rule's applies_to (rules.yaml) selects the actions its check judges (#20, C5):
// action kinds, "all", or "lock>=MODE" with a Postgres lock mode name.

const actions = classify(cr(
  "UPDATE public.orders SET status = 'x' WHERE id = 1",
  "CREATE INDEX orders_status_idx ON public.orders (status)",
  "VACUUM (ANALYZE) public.orders",
), cleanSnapshot).actions;
const kinds = (entries: string[]) => actions.filter((a) => appliesTo(entries, a)).map((a) => a.action);

describe("applies_to selects actions", () => {
  test("by kind", () => {
    expect(kinds(["dml.bounded", "maint.vacuum_analyze"])).toEqual(["dml.bounded", "maint.vacuum_analyze"]);
  });

  test("all selects every action", () => {
    expect(kinds(["all"])).toEqual(["dml.bounded", "idx.create_blocking", "maint.vacuum_analyze"]);
  });

  test("lock>=MODE selects actions locking at that mode or stronger", () => {
    // UPDATE takes ROW EXCLUSIVE, CREATE INDEX SHARE, VACUUM SHARE UPDATE EXCLUSIVE.
    expect(kinds(["lock>=SHARE"])).toEqual(["idx.create_blocking"]);
    expect(kinds(["lock>=ROW EXCLUSIVE"])).toEqual(["dml.bounded", "idx.create_blocking", "maint.vacuum_analyze"]);
  });
});

describe("applies_to is validated", () => {
  test.each([
    [["dml.bounded", "lock>=SHARE"], undefined],
    [["dml.unbounded"], "dml.unbounded is not an action kind, all, or lock>=MODE"],
    [["lock>=SHARED"], "lock>=SHARED names no Postgres lock mode"],
    [["all", "dml.bounded"], "all cannot be combined with other entries"],
    [["dml.bounded", "dml.bounded"], "dml.bounded is listed twice"],
  ])("%j", (entries, error) => {
    expect(appliesToError(entries)).toBe(error);
  });
});
