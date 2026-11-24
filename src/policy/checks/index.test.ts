import { expect, test } from "bun:test";
import { mergeFamilies } from "./index";
import type { Check } from "./types";

// The registry merges one map per rule family (#20, C2). A plain object
// spread would keep the last of two checks with the same rule ID without a
// word, and the rules.yaml parity test cannot see that.

const none: Check = () => [];
const other: Check = () => [];

test("family maps merge into one registry", () => {
  expect(mergeFamilies({ "TS-1": none }, { "R-1": other })).toEqual({ "TS-1": none, "R-1": other });
});

test("a rule ID in two families is refused, naming the ID", () => {
  expect(() => mergeFamilies({ "L-1": none }, { "L-1": other })).toThrow("L-1");
});
