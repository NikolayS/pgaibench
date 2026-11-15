import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reasoningSummary } from "./reasoning";

const mk = (root: string, cell: string, g: object) => { g = { sample: root.endsWith("/b") ? 2 : 1, ...g }; mkdirSync(join(root, "generate", cell), { recursive: true }); writeFileSync(join(root, "generate", cell, "generation.json"), JSON.stringify(g)); };

test("reasoning tokens: median per row over its answers, zero count, repair turns; rows and tasks of the table only", () => {
  const d = mkdtempSync(join(tmpdir(), "rsn-"));
  try {
    const a = join(d, "a"), b = join(d, "b");
    mk(a, "T1-m1", { scenario: "T1", model_requested: "v/m1", reasoning_tokens: 100, repair_rounds: 0 });
    mk(a, "T2-m1", { scenario: "T2", model_requested: "v/m1", reasoning_tokens: 300, repair_rounds: 1 });
    mk(b, "T1-m1", { scenario: "T1", model_requested: "v/m1", reasoning_tokens: 200, repair_rounds: 0 });
    mk(a, "T1-m2", { scenario: "T1", model_requested: "v/m2", reasoning_tokens: 0, repair_rounds: 0 });
    mk(a, "T9-m2", { scenario: "T9", model_requested: "v/m2", reasoning_tokens: 999, repair_rounds: 1 }); // task not in the table
    mk(a, "T1-x", { scenario: "T1", model_requested: "v/other", reasoning_tokens: 5 }); // not a row of this arm
    mk(b, "T2-h", { scenario: "T2", model_requested: "v/m1", reasoning_tokens: null });
    const r = reasoningSummary([{ arm: "", generation: [[a], [b]] }, { arm: ":high", generation: [[b], [b]] }], new Set(["v/m1", "v/m2", "v/m1:high"]), new Set(["T1", "T2"]));
    expect(r.rows["v/m1"]).toEqual({ median: 200, answers: 3, zero: 0 });
    expect(r.rows["v/m2"]).toEqual({ median: 0, answers: 1, zero: 1 });
    expect(r.rows["v/m1:high"]).toEqual({ median: 200, answers: 1, zero: 0 });
    expect(r.rows["v/other"]).toBeUndefined();
    expect(r.repairs).toEqual({ answers: 7, repaired: 1 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("output limit: answers that hit the first output limit (requested again at a higher limit, or recorded with no answer) and cells with no answer, per row", () => {
  const d = mkdtempSync(join(tmpdir(), "rsn-"));
  try {
    const a = join(d, "a");
    mk(a, "T1-m1", { scenario: "T1", model_requested: "v/m1", reasoning_tokens: 100, max_tokens: 32000, status: "cr" });
    mk(a, "T2-m1", { scenario: "T2", model_requested: "v/m1", reasoning_tokens: 300, max_tokens: 96000, status: "cr" });
    mk(a, "T3-m1", { scenario: "T3", model_requested: "v/m1", reasoning_tokens: 900, max_tokens: 96000, status: "truncated" });
    mk(a, "T4-m1", { scenario: "T4", model_requested: "v/m1", reasoning_tokens: 32000, max_tokens: 32000, status: "truncated" });
    mk(a, "T1-m2", { scenario: "T1", model_requested: "v/m2", reasoning_tokens: 1, max_tokens: 32000, status: "cr" });
    const r = reasoningSummary([{ arm: "", generation: [[a]] }], new Set(["v/m1", "v/m2"]), new Set(["T1", "T2", "T3", "T4"]));
    expect(r.limits).toEqual({ "v/m1": { answers: 4, firstLimit: 3, noAnswer: 2 } });
    expect(r.rows["v/m1"]).toEqual({ median: 600, answers: 4, zero: 0 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
