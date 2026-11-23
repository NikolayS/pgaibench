import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectSqlSteps, loadParser, parseSql } from "./parse";

// Parser spike (issue #2): prove libpg-query loads under Bun and parses every
// SQL step we will later classify. Runs offline: no network, no database.

beforeAll(async () => {
  await loadParser();
});

describe("parseSql", () => {
  test("parses a statement into one raw statement", () => {
    const result = parseSql("SELECT 1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stmts).toHaveLength(1);
  });

  test("reports a syntax error instead of throwing", () => {
    const result = parseSql("SELEC 1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("syntax error");
  });

  test("throws before loadParser() instead of reporting a parse error", () => {
    // A fresh process, because this file has already loaded the parser.
    const script = `import { parseSql } from ${JSON.stringify(join(import.meta.dir, "parse.ts"))};
try { parseSql("SELECT 1"); console.log("returned"); } catch (e) { console.log(String(e)); }`;
    const out = Bun.spawnSync([process.execPath, "-e", script]).stdout.toString();
    expect(out).toContain("loadParser");
  });

  test("accepts Postgres 18 syntax", () => {
    // Virtual generated columns and NOT NULL ... NOT VALID are new in Postgres 18.
    for (const sql of [
      "CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL)",
      "ALTER TABLE t ADD CONSTRAINT t_a_nn NOT NULL a NOT VALID",
    ]) {
      expect(parseSql(sql)).toMatchObject({ ok: true });
    }
  });
});

describe("change request corpus", () => {
  const steps = collectSqlSteps();

  test("covers the public reference change requests and the Track 2 corpus", () => {
    // Counted independently with jq on 2026-11-23: 53 of the 56 reference files
    // hold 161 SQL texts (the other 3 only escalate). 29 of the 36 Track 2 items
    // hold 61 SQL steps (the other 7 are config steps only). Update these when
    // the corpus changes, so a step can never drop out of the check silently.
    const reference = steps.filter((s) => s.source === "reference");
    const track2 = steps.filter((s) => s.source === "track2");
    expect(new Set(reference.map((s) => s.origin)).size).toBe(53);
    expect(reference).toHaveLength(161);
    expect(new Set(track2.map((s) => s.origin)).size).toBe(29);
    expect(track2).toHaveLength(61);
  });

  test("every SQL step parses", () => {
    const failures = steps
      .map((step) => ({ step, result: parseSql(step.sql) }))
      .filter(({ result }) => !result.ok)
      .map(({ step, result }) => `${step.origin} ${step.field}: ${result.ok ? "" : result.error}\n  ${step.sql}`);
    if (failures.length > 0) console.error(`Parse failures:\n${failures.join("\n")}`);
    expect(failures).toEqual([]);
  });
});
