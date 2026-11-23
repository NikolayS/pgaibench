import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS } from "./checks";
import { RULES_MD_PATH, renderRulesMarkdown } from "./gen-rules-md";
import { loadRuleData, parseRuleData, RULES_YAML_PATH } from "./rule-data";

// Schema tests for the policy rule data (issue #3). The rule data file is the
// source of truth for rule text; each rule ID maps to exactly one check function.

describe("rule data", () => {
  test("loads and validates the 30 rules and the thresholds", () => {
    const data = loadRuleData();
    expect(data.rules).toHaveLength(30);
    expect(data.rules.map((r) => r.id)).toContain("TS-1");
    expect(data.rules.map((r) => r.id)).not.toContain("R-5");
    expect(data.thresholds.B.value).toBe(10000);
    expect(data.thresholds.T_lock.value).toBe("2s");
  });

  test("every rule ID has a check function and every check function has a rule", () => {
    const ruleIds = loadRuleData().rules.map((r) => r.id).sort();
    expect(Object.keys(CHECKS).sort()).toEqual(ruleIds);
  });

  test("rule IDs are unique", () => {
    const ids = loadRuleData().rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("malformed rule data is refused", () => {
    const good = Bun.YAML.parse(readFileSync(RULES_YAML_PATH, "utf8")) as { rules: Record<string, unknown>[] };
    const withBadVerdict = { ...good, rules: [{ ...good.rules[0], verdict: "maybe" }, ...good.rules.slice(1)] };
    expect(() => parseRuleData(withBadVerdict)).toThrow();
    const withDuplicate = { ...good, rules: [...good.rules, good.rules[0]] };
    expect(() => parseRuleData(withDuplicate)).toThrow(/duplicate/i);
  });
});

describe("rule documentation", () => {
  test("the committed rule documentation is what the generator writes", () => {
    expect(readFileSync(RULES_MD_PATH, "utf8")).toBe(renderRulesMarkdown(loadRuleData()));
  });

  test("the Python generator is gone", () => {
    const pack = join(import.meta.dir, "..", "..", "docs", "policy-gate", "scripts");
    expect(existsSync(join(pack, "gen-rules-md.py"))).toBe(false);
  });
});
