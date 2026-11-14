// The clone note matches the prereg: the clone archives into its own directory (w_prod-oracle-v2.8) and has no standby.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("clone note: own archive directory, no standby; no stale 'no WAL archive'", () => {
  const src = readFileSync(join(import.meta.dir, "lab.ts"), "utf8");
  expect(src).not.toContain("no WAL archive");
  expect(src).toContain('"the clone archives WAL into its own directory, deleted with the clone, and has no standby by design"');
});
