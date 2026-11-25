import { describe, expect, test } from "bun:test";
import { constraint, snapshotFixture, table } from "../snapshot-fixture";
import { cr } from "../test-kit";
import { classify } from "./index";

// SET NOT NULL skips its full-table scan when a validated constraint already
// proves the column. The classifier records a proof validated earlier in the
// same change request (proof_step), so L-4 judges the SET NOT NULL from its
// own action and the snapshot's catalog (#20, C5).

const snapshot = snapshotFixture({
  relations: { "public.accounts": table(), "public.branches": table() },
  constraints: [constraint("bid_nn_old", "public.accounts", "check", { validated: false, definition: "CHECK ((bid IS NOT NULL))" })],
});
const SET_NOT_NULL = "ALTER TABLE public.accounts ALTER COLUMN bid SET NOT NULL";
const proofStep = (...steps: string[]) => {
  const a = classify(cr(...steps), snapshot).actions.find((x) => x.action === "ddl.set_not_null");
  return a && "proof_step" in a ? a.proof_step : undefined;
};

describe("ddl.set_not_null records the step that proves its column", () => {
  test("a NOT VALID CHECK (col IS NOT NULL) validated in a later step", () => {
    expect(proofStep(
      "ALTER TABLE public.accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL) NOT VALID",
      "ALTER TABLE public.accounts VALIDATE CONSTRAINT bid_nn",
      SET_NOT_NULL,
    )).toBe(1);
  });

  test("a NOT NULL constraint added with validation", () => {
    expect(proofStep("ALTER TABLE public.accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL)", SET_NOT_NULL)).toBe(0);
  });

  test("validating a NOT VALID constraint already in the catalog", () => {
    expect(proofStep("ALTER TABLE public.accounts VALIDATE CONSTRAINT bid_nn_old", SET_NOT_NULL)).toBe(0);
  });

  test.each([
    ["no validation", ["ALTER TABLE public.accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL) NOT VALID", SET_NOT_NULL]],
    ["another column", ["ALTER TABLE public.accounts ADD CONSTRAINT aid_nn CHECK (aid IS NOT NULL)", SET_NOT_NULL]],
    ["another table", ["ALTER TABLE public.branches ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL)", SET_NOT_NULL]],
    ["a proof after the SET NOT NULL", [SET_NOT_NULL, "ALTER TABLE public.accounts ADD CONSTRAINT bid_nn CHECK (bid IS NOT NULL)"]],
  ])("none with %s", (_, steps) => {
    expect(proofStep(...steps)).toBeUndefined();
  });
});
