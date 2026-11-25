import { describe, expect, test } from "bun:test";
import { checkCommitMessage, compareBaseline, parseTestFailures, parseTypeErrors } from "./guardrails";

// The repo's guardrails: the typecheck and the test suite are compared with a
// committed baseline of known failures, and commit messages follow CLAUDE.md.

describe("parseTypeErrors", () => {
  test("keeps file, code and message, and drops the line and column", () => {
    const out = [
      "src/a.ts(12,3): error TS2339: Property 'x' does not exist on type 'Y'.",
      "src/b.ts(1,1): error TS7006: Parameter 'p' implicitly has an 'any' type.",
      "  continuation line of a long message",
      "/work/repo/src/c.ts(2,2): error TS7016: Could not find a declaration file for module './d.js'. '/work/repo/src/d.js' implicitly has an 'any' type.",
      "Found 3 errors.",
    ].join("\n");
    expect(parseTypeErrors(out, "/work/repo")).toEqual([
      "src/a.ts TS2339 Property 'x' does not exist on type 'Y'.",
      "src/b.ts TS7006 Parameter 'p' implicitly has an 'any' type.",
      "src/c.ts TS7016 Could not find a declaration file for module './d.js'. 'src/d.js' implicitly has an 'any' type.",
    ]);
  });
});

describe("parseTestFailures", () => {
  test("names each failure by its test file, and drops the timing", () => {
    const out = [
      "src/a.test.ts:",
      "(pass) works [0.10ms]",
      "(fail) group > breaks [1.20ms]",
      "",
      "src/b.test.ts:",
      "(fail) slow one [12.00s]",
      "# Unhandled error between tests",
      "(fail) no timing",
    ].join("\n");
    expect(parseTestFailures(out)).toEqual([
      "src/a.test.ts group > breaks",
      "src/b.test.ts slow one",
      "src/b.test.ts <unhandled error>",
      "src/b.test.ts no timing",
    ]);
  });

  test("ignores the failure summary bun repeats at the end outside an agent", () => {
    const out = ["src/a.test.ts:", "(fail) breaks [1.00ms]", "", "src/b.test.ts:", "(pass) ok", "", "1 tests failed:", "(fail) breaks [1.00ms]"].join("\n");
    expect(parseTestFailures(out)).toEqual(["src/a.test.ts breaks"]);
  });

  test("reads file headers in GitHub Actions group form", () => {
    const out = ["::group::src/a.test.ts:", "(fail) breaks [1.00ms]", "::endgroup::"].join("\n");
    expect(parseTestFailures(out)).toEqual(["src/a.test.ts breaks"]);
  });
});

describe("compareBaseline", () => {
  test("reports entries that are new and entries that no longer occur", () => {
    expect(compareBaseline(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });

  test("counts repeated entries, so a second copy of a known error is new", () => {
    expect(compareBaseline(["x"], ["x", "x"])).toEqual({ added: ["x"], removed: [] });
  });

  test("with a key, entries that differ only outside the key match", () => {
    const name = (e: string) => e.slice(e.indexOf(" ") + 1);
    expect(compareBaseline(["a.test.ts shared"], ["b.test.ts shared"], name)).toEqual({ added: [], removed: [] });
    expect(compareBaseline(["a.test.ts one"], ["a.test.ts two"], name)).toEqual({ added: ["a.test.ts two"], removed: ["a.test.ts one"] });
  });

  test("an unchanged set has nothing added or removed", () => {
    expect(compareBaseline(["b", "a"], ["a", "b"])).toEqual({ added: [], removed: [] });
  });
});

describe("checkCommitMessage", () => {
  test("accepts a short plain subject with a body and trailer", () => {
    expect(checkCommitMessage("feat(policy): add TS-1\n\nBody.\n\nCo-Authored-By: A <a@b.c>\n")).toEqual([]);
  });

  test("rejects a subject over 72 characters", () => {
    const subject = `Merge branch 'feat/precondition-gate' into worktree-agent-a18a99ded8a6a04c8`;
    expect(subject.length).toBe(75);
    expect(checkCommitMessage(`${subject}\n`)).toEqual([expect.stringContaining("75 characters")]);
  });

  test("accepts a subject of exactly 72 characters", () => {
    expect(checkCommitMessage(`${"a".repeat(72)}\n`)).toEqual([]);
  });

  test("rejects an emoji anywhere in the message", () => {
    expect(checkCommitMessage("fix: thing\n\nDone \u{1F680}\n")).toEqual([expect.stringContaining("emoji")]);
    expect(checkCommitMessage("fix: ✅ thing\n")).toEqual([expect.stringContaining("emoji")]);
  });

  test("accepts plain punctuation and non-English letters", () => {
    expect(checkCommitMessage("docs: 03 — policy rules, café, Σ\n")).toEqual([]);
  });

  test("rejects an empty subject", () => {
    expect(checkCommitMessage("\n\nbody\n")).toEqual([expect.stringContaining("empty")]);
  });

  test("ignores the comment lines git adds to the message", () => {
    expect(checkCommitMessage(`fix: x\n# ${"a".repeat(80)}\n`)).toEqual([]);
  });
});
