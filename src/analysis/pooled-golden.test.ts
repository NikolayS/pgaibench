// Every number the v0.1.0 code gave (output.json, written by the release-branch pooled.ts on this input) stays
// identical: point estimates, order, places, task-only intervals. Only the new fields are added.
import { expect, test } from "bun:test";
import { pooledArms } from "./pooled";
import input from "./fixtures/pooled-golden/input.json";
import golden from "./fixtures/pooled-golden/output.json";

const NEW = new Set(["unread", "twoLevel", "taskOnly", "dangerBound"]);
const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !NEW.has(k)).map(([k, x]) => [k, strip(x)])) : v;

test("old fields are identical to the v0.1.0 code; new fields are added", () => {
  const now = JSON.parse(JSON.stringify(pooledArms(input as never)));
  expect(strip(now)).toEqual(golden);
  const ranked = now.rows.filter((r: { place: number | null }) => r.place !== null);
  expect(ranked.length).toBeGreaterThan(4);
  expect(now.rows.some((r: { included: boolean; twoLevel: unknown }) => !r.included && r.twoLevel === null)).toBe(true);
  expect(now.effort.flatMap((a: { rows: { twoLevel: unknown }[] }) => a.rows).every((r: { twoLevel: unknown }) => r.twoLevel === null)).toBe(true);
  expect(now.effort.flatMap((a: { rows: { unread: number }[] }) => a.rows).some((r: { unread: number }) => r.unread > 0)).toBe(true);
});
