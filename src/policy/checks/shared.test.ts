import { expect, test } from "bun:test";
import { classify } from "../classify";
import { cleanSnapshot, cr } from "../test-kit";
import { ofKind } from "./shared";

// ofKind() narrows classified actions to the variants a check reads (#20, C4).

const { actions } = classify(cr(
  "ALTER TABLE public.orders ALTER COLUMN a TYPE text",
  "UPDATE public.orders SET a = 1",
  "ALTER TABLE public.orders DROP COLUMN b",
), cleanSnapshot);

test("keeps the actions of the named kinds, in change-request order", () => {
  expect(ofKind(actions, "ddl.drop_column", "ddl.alter_column_type").map((a): [number, string] => [a.step, a.action])).toEqual([
    [0, "ddl.alter_column_type"], [2, "ddl.drop_column"],
  ]);
});

test("the result is typed by kind, so payload fields need no assertion", () => {
  const [change] = ofKind(actions, "ddl.alter_column_type");
  const newType: string = change.new_type;
  expect(newType).toBe("text");
  expect(ofKind(actions, "ext.create")).toEqual([]);
});
