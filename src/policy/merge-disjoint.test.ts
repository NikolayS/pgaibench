import { expect, test } from "bun:test";
import { mergeDisjoint } from "./merge-disjoint";

// The check registry and the classifier's dispatch table are each merged from
// one table per family (#20, C2 and C3). A plain object spread would keep the
// last of two entries with the same key without a word.

test("tables merge into one", () => {
  expect(mergeDisjoint("rule", { "TS-1": 1 }, { "R-1": 2 })).toEqual({ "TS-1": 1, "R-1": 2 });
});

test("a key in two tables is refused, naming the key and what it is", () => {
  expect(() => mergeDisjoint("rule", { "L-1": 1 }, { "L-1": 2 })).toThrow("rule L-1");
  expect(() => mergeDisjoint("statement type", { DropStmt: 1 }, { DropStmt: 2 })).toThrow("statement type DropStmt");
});
