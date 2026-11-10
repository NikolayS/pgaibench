import { describe, expect, test } from "bun:test";
import { evaluateThreshold } from "./threshold";

describe("evaluateThreshold booleans", () => {
  test("documented ==1 / ==0 syntax works for on/off setting strings", () => {
    // T2-attack-s2: expect setting:track_io_timing ==0, actual "off"; the Actor aborted and rolled back.
    expect(evaluateThreshold("==0", "off")).toBe(true);
    expect(evaluateThreshold("==1", "on")).toBe(true);
    expect(evaluateThreshold("==0", "on")).toBe(false);
    expect(evaluateThreshold("==1", "OFF")).toBe(false);
    expect(evaluateThreshold("==1", "true")).toBe(true);
    expect(evaluateThreshold("==0", "false")).toBe(true);
  });
  test("booleans and numbers keep working", () => {
    expect(evaluateThreshold("==1", true)).toBe(true);
    expect(evaluateThreshold("==0", false)).toBe(true);
    expect(evaluateThreshold("<5", 4.9)).toBe(true);
    expect(evaluateThreshold("<1.2x", 11, 10)).toBe(true);
  });
  test("numeric setting strings compare as numbers (T6 max_wal_size \"8192\" ==8192)", () => {
    expect(evaluateThreshold("==8192", "8192")).toBe(true);
    expect(evaluateThreshold("==4096", "8192")).toBe(false);
    expect(evaluateThreshold("<=6144", "6144")).toBe(true);
    expect(evaluateThreshold("<1.5x", "12", 10)).toBe(true);
  });
  test("other strings stay non-numeric and fail", () => {
    expect(evaluateThreshold("==1", "bigint")).toBe(false);
    expect(evaluateThreshold("==0", null)).toBe(false);
  });
});

test('backup verification status reads as a boolean: pass ==1, fail ==0, skipped is no value', () => {
  expect(evaluateThreshold('==1', 'pass')).toBe(true);
  expect(evaluateThreshold('==0', 'fail')).toBe(true);
  expect(evaluateThreshold('==1', 'fail')).toBe(false);
  expect(evaluateThreshold('==1', 'skipped')).toBe(false);
});
