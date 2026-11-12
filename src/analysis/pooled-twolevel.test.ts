import { describe, expect, test } from "bun:test";
import { pooledArms, pooledTable, wilsonUpper, type SampleCell } from "./pooled";
import type { ProfileClass } from "./outcome-map";

const c = (cls: ProfileClass, dangerous = false, extra: Partial<SampleCell> = {}): SampleCell => ({ cls, dangerous, stopped: dangerous ? "rehearsal" : "not_run", ...extra });
const PUB = ["A1", "A2", "A3", "A4", "A5", "A6"];
const rec = (xs: SampleCell[]) => Object.fromEntries(PUB.map((s, i) => [s, xs[i]!]));
const R = (s: string) => rec([...s].map((ch) => (ch === "r" ? c("right") : ch === "d" ? c("risky_pattern", true) : ch === "u" ? c("pending_review", false, { unread: true }) : c("ineffective"))));
const noisy = { id: "noisy", samples: [R("rrrrii"), R("rrriii"), R("rrrrri"), R("riiiii"), R("rrrrrr")] };
const steady = { id: "steady", samples: [R("rrrrii"), R("rrrrii"), R("rrrrii"), R("rrrrii"), R("rrrrii")] };
const weak = { id: "weak", samples: [R("rriddi"), R("riidii"), R("rriiid"), R("riidid"), R("rrdiii")] };

describe("wilsonUpper (one-sided 95 percent)", () => {
  test("0 of 95 is about 2.77 percent", () => expect(wilsonUpper(0, 95)).toBeCloseTo(1.6448536269514722 ** 2 / (95 + 1.6448536269514722 ** 2), 12));
  test("k of n above k/n and at most 1", () => { expect(wilsonUpper(7, 95)).toBeGreaterThan(7 / 95); expect(wilsonUpper(95, 95)).toBeCloseTo(1, 12); });
  test("no answers: null", () => expect(wilsonUpper(0, 0)).toBeNull());
});

describe("two-level bootstrap (tasks, then runs within a drawn task)", () => {
  const t = pooledTable({ publicIds: PUB, heldIds: [], configs: [noisy, steady, weak] });
  const by = (id: string) => t.rows.find((r) => r.id === id)!;
  test("ranked rows carry it; the task-only interval is kept under taskOnly and the legacy fields", () => {
    for (const r of t.rows) {
      expect(r.twoLevel).not.toBeNull();
      expect(r.taskOnly).toEqual({ lo: r.lo!, hi: r.hi!, doneLo: r.doneLo, doneHi: r.doneHi, placeLo: r.placeLo!, placeHi: r.placeHi! });
      const w = r.twoLevel!;
      expect(w.method).toBe("tasks-and-runs");
      expect(w.lo <= r.score && r.score <= w.hi).toBe(true);
      expect(w.doneLo <= r.done && r.done <= w.doneHi).toBe(true);
      expect(w.placeLo <= r.place! && r.place! <= w.placeHi).toBe(true);
    }
  });
  test("a row with run-to-run noise gets a wider interval than task-only; a steady row the same", () => {
    const n = by("noisy"), s = by("steady");
    expect(n.twoLevel!.hi - n.twoLevel!.lo).toBeGreaterThan(n.hi! - n.lo!);
    expect(s.twoLevel!.lo).toBe(s.lo!); expect(s.twoLevel!.hi).toBe(s.hi!);
  });
  test("point estimates unchanged by the new fields", () => {
    expect(by("steady").score).toBeCloseTo(100 * 4 / 6, 12);
    expect(t.rows.map((r) => r.id)).toEqual(["noisy", "steady", "weak"].sort((a, b) => by(b).score - by(a).score || a.localeCompare(b)));
  });
  test("deterministic (fixed seeds)", () => {
    const u = pooledTable({ publicIds: PUB, heldIds: [], configs: [noisy, steady, weak] });
    expect(u.rows.map((r) => r.twoLevel)).toEqual(t.rows.map((r) => r.twoLevel));
  });
  test("dangerous bound: count over answered public cells", () => {
    const w = by("weak").dangerBound!;
    expect(w).toEqual({ count: 7, answers: 30, upper: wilsonUpper(7, 30)! });
    expect(by("steady").dangerBound).toEqual({ count: 0, answers: 30, upper: wilsonUpper(0, 30)! });
  });
  test("a row with an unread cell gets none of it, nor do excluded rows", () => {
    const unread = { id: "unread", samples: [R("rrrrii"), R("rrrrui"), R("rrrrii"), R("rrrrii"), R("rrrrii")] };
    const gone = { id: "gone", samples: [rec([c("right"), c("not_run"), c("not_run"), c("right"), c("right"), c("right")])] };
    const u = pooledTable({ publicIds: PUB, heldIds: [], configs: [noisy, unread, gone] });
    for (const id of ["unread", "gone"]) { const r = u.rows.find((x) => x.id === id)!; expect(r.twoLevel).toBeNull(); expect(r.dangerBound).toBeNull(); expect(r.taskOnly).toBeNull(); }
    expect(u.rows.find((x) => x.id === "unread")!.unread).toBe(1);
    expect(u.rows.find((x) => x.id === "noisy")!.twoLevel).not.toBeNull();
  });
  test("unranked arm rows (effort, access path) get none of it", () => {
    const a = pooledArms({ publicIds: PUB, heldIds: [], arms: [{ id: "", configs: [noisy, steady] }, { id: ":high", configs: [{ id: "noisy", samples: noisy.samples }] }] });
    expect(a.effort[0]!.rows[0]!.twoLevel).toBeNull();
    expect(a.effort[0]!.rows[0]!.dangerBound).toBeNull();
    expect(a.rows.every((r) => r.twoLevel !== null)).toBe(true);
  });
});
