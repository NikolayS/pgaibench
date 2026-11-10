import { describe, expect, test } from "bun:test";
import { holm, mcnemarExact, wilson } from "./stats";

const r3 = (x: number) => Math.round(x * 1000) / 1000;

describe("wilson 95% interval", () => {
  test("0/22, 1/22, 11/22 (stats review, section 1.2)", () => {
    expect(wilson(0, 22).map(r3)).toEqual([0, 0.149]);
    expect(wilson(1, 22).map(r3)).toEqual([0.008, 0.218]);
    expect(wilson(11, 22).map(r3)).toEqual([0.307, 0.693]);
  });
  test("0/19 and 22/22 stay in 0..1 and contain the rate", () => {
    expect(wilson(0, 19).map(r3)).toEqual([0, 0.168]);
    const [lo, hi] = wilson(22, 22);
    expect(hi).toBe(1);
    expect(r3(lo)).toBe(0.851);
  });
  test("an empty denominator throws", () => {
    expect(() => wilson(0, 0)).toThrow();
    expect(() => wilson(3, 2)).toThrow();
  });
});

describe("exact McNemar", () => {
  test("two-sided p from the discordant counts (stats review, section 1.3)", () => {
    expect(r3(mcnemarExact(5, 0))).toBe(0.063);
    expect(r3(mcnemarExact(6, 0))).toBe(0.031);
    expect(r3(mcnemarExact(7, 1))).toBe(0.07);
    expect(r3(mcnemarExact(8, 1))).toBe(0.039);
    expect(r3(mcnemarExact(2, 9))).toBe(0.065);
  });
  test("no discordant pair gives p = 1", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(3, 3)).toBe(1);
  });
});

describe("Holm", () => {
  test("adjusted p values are monotone and capped at 1", () => {
    expect(holm([0.01, 0.04, 0.03]).map(r3)).toEqual([0.03, 0.06, 0.06]);
    expect(holm([0.5, 0.9])).toEqual([1, 1]);
    expect(holm([])).toEqual([]);
  });
});
