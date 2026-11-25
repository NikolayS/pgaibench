// Pure logic behind the repo's guardrails (scripts/check.ts and
// scripts/check-commit-msg.ts). The typecheck and the test suite are not
// clean on main, so each is compared with a committed baseline of known
// failures in scripts/baselines/: only a new failure fails the check.

/**
 * tsc errors as "file TSxxxx message", without line and column, so edits elsewhere in a file do not churn the baseline.
 * Absolute paths under root become relative, so the baseline matches on every checkout.
 */
export function parseTypeErrors(output: string, root = ""): string[] {
  const out: string[] = [];
  const text = root === "" ? output : output.split(`${root.replace(/\/$/, "")}/`).join("");
  for (const line of text.split("\n")) {
    const m = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
    if (m) out.push(`${m[1]} ${m[2]} ${m[3]}`);
  }
  return out;
}

/**
 * bun test failures as "test-file test name", without timing. Unhandled errors count as failures of their file.
 * Outside an AI agent, bun repeats every failure after an "N tests failed:" line; parsing stops there.
 */
export function parseTestFailures(output: string): string[] {
  const out: string[] = [];
  let file = "";
  for (const line of output.split("\n")) {
    const header = /^(?:::group::)?(\S.*\.test\.tsx?):$/.exec(line);
    if (/^\d+ tests? failed:$/.test(line)) break;
    if (header) file = header[1];
    else if (line.startsWith("(fail) ")) out.push(`${file} ${line.slice(7).replace(/ \[[\d.]+m?s\]$/, "")}`);
    else if (line.includes("Unhandled error between tests")) out.push(`${file} <unhandled error>`);
  }
  return out;
}

/** Compares two lists as multisets of their keys: a second copy of a known entry is new. */
export function compareBaseline(
  baseline: readonly string[],
  current: readonly string[],
  key: (entry: string) => string = (e) => e,
): { added: string[]; removed: string[] } {
  const known = new Map<string, string[]>();
  for (const e of baseline) known.set(key(e), [...(known.get(key(e)) ?? []), e]);
  const added: string[] = [];
  for (const e of current) {
    const left = known.get(key(e));
    if (left !== undefined && left.length > 0) left.pop();
    else added.push(e);
  }
  const removed = [...known.values()].flat();
  return { added: added.sort(), removed: removed.sort() };
}

/**
 * A test failure's key is its name without the file. A test defined in a file
 * that other test files import runs, and is reported, under whichever importer
 * bun runs first, and that order differs between machines.
 */
export const testName = (entry: string) => entry.slice(entry.indexOf(" ") + 1);

export const MAX_SUBJECT = 72;

// Characters shown as emoji by default, and any character followed by the emoji variation selector.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;

/** CLAUDE.md's commit message rules. Returns one problem per broken rule. */
export function checkCommitMessage(message: string): string[] {
  const lines = message.split("\n").filter((l) => !l.startsWith("#"));
  const subject = lines.find((l) => l.trim() !== "") ?? "";
  const problems: string[] = [];
  if (subject.trim() === "" || subject !== lines[0]) problems.push("The subject line is empty.");
  else if ([...subject].length > MAX_SUBJECT) {
    problems.push(`The subject is ${[...subject].length} characters; the limit is ${MAX_SUBJECT}.`);
  }
  if (EMOJI.test(lines.join("\n"))) problems.push("The message contains an emoji.");
  return problems;
}
