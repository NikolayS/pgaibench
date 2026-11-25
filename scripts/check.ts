import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareBaseline, parseTestFailures, parseTypeErrors, testName } from "./guardrails";

// bun run check [types|tests] [--update]
//
// Runs the typecheck and the full test suite and compares each with its
// committed baseline of known failures in scripts/baselines/. Fails on any
// new failure and reports known failures that no longer occur. --update
// rewrites the baselines from the current run: use it after fixing known
// failures, never to hide a new one.

const ROOT = join(import.meta.dir, "..");

type Check = {
  name: string;
  baseline: string;
  run: () => Promise<string>;
  parse: (output: string) => string[];
  key?: (entry: string) => string;
};

// bun test changes its output format under CI (group markers, a repeated
// failure summary), so we run it with the CI variables removed.
const { CI: _ci, GITHUB_ACTIONS: _gha, ...LOCAL_ENV } = process.env;

async function output(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: LOCAL_ENV, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}\n${err}`;
}

const CHECKS: Check[] = [
  {
    name: "types",
    baseline: join(ROOT, "scripts", "baselines", "typecheck.txt"),
    run: () => output([join(ROOT, "node_modules", ".bin", "tsc"), "-p", "."]),
    parse: (out) => parseTypeErrors(out, ROOT),
  },
  {
    name: "tests",
    baseline: join(ROOT, "scripts", "baselines", "test-failures.txt"),
    run: () => output([process.execPath, "test"]),
    parse: parseTestFailures,
    key: testName,
  },
];

const readBaseline = (path: string) =>
  readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));

async function main(argv: string[]): Promise<number> {
  const update = argv.includes("--update");
  const only = argv.filter((a) => !a.startsWith("--"));
  const checks = CHECKS.filter((c) => only.length === 0 || only.includes(c.name));
  if (checks.length === 0) throw new Error(`Unknown check: ${only.join(" ")}. Use types or tests.`);
  let failed = false;
  for (const check of checks) {
    const current = check.parse(await check.run());
    if (update) {
      const header = `# Known ${check.name} failures. Regenerate with: bun run check ${check.name} --update\n`;
      writeFileSync(check.baseline, header + [...current].sort().join("\n") + "\n");
      console.log(`${check.name}: wrote ${current.length} known failures to ${check.baseline}`);
      continue;
    }
    const { added, removed } = compareBaseline(readBaseline(check.baseline), current, check.key);
    if (removed.length > 0) {
      console.log(`${check.name}: ${removed.length} known failures no longer occur. Run \`bun run check ${check.name} --update\` to drop them:`);
      for (const r of removed) console.log(`  ${r}`);
    }
    if (added.length > 0) {
      failed = true;
      console.log(`${check.name}: ${added.length} new failures:`);
      for (const a of added) console.log(`  ${a}`);
    } else {
      console.log(`${check.name}: OK, no failures beyond the baseline (${current.length} known).`);
    }
  }
  return failed ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
