import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadRuleData, RULES_YAML_PATH, type RuleData } from "./rule-data";

// Regenerates the rule documentation from the rule data.
// Usage: bun run policy:rules-md

const ROOT = join(import.meta.dir, "..", "..");
export const RULES_MD_PATH = join(ROOT, "docs", "policy-gate", "spec", "03-rules.md");

export function renderRulesMarkdown(data: RuleData): string {
  const { rules } = data;
  const out = [
    "# 03 — Policy rules", "",
    `Generated from \`${relative(ROOT, RULES_YAML_PATH)}\` (the source of truth) by \`${relative(ROOT, import.meta.path)}\`.`,
    `${rules.length} rules; each returns **reject** (back to the Analyst with rule ID, reason and`,
    "fix hint), **defer** (state is temporarily unsafe; recheck every 10s for up to D_budget,",
    "then escalate) or",
    "**escalate** (human decides).", "",
    "Prefixes: `TS` ticket scope, `R` replication/settings, `L` locking, `X` transaction",
    "structure, `I` indexes, `U` object usage, `T` type safety, `S` scale.", "",
    "`scope: plan` rules evaluate the whole ordered CR (ordering, transaction grouping);",
    "`scope: step` rules evaluate one step against `Σ`.", "", "## Thresholds", "",
    "| Name | Default | Meaning |", "| --- | --- | --- |",
  ];
  for (const [name, t] of Object.entries(data.thresholds)) out.push(`| \`${name}\` | ${t.value} | ${t.meaning} |`);
  out.push("", "## Rules", "",
    "| Rule | Scope | Applies to | Condition | On failure | Targets |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const r of rules) {
    let condition = r.condition.trim().replaceAll("\n", " ");
    if (r.settings?.length) condition += ` Settings: ${r.settings.join(", ")}.`;
    if (r.fix_hint) condition += ` Fix: ${r.fix_hint}`;
    const appliesTo = r.applies_to.map((a) => `\`${a}\``).join(", ");
    out.push(`| \`${r.id}\` | ${r.scope} | ${appliesTo} | ${condition} | ${r.verdict} | ${r.targets.join(", ") || "—"} |`);
  }
  out.push("", "## Actor postconditions", "");
  for (const p of data.postconditions) out.push(`- After \`${p.after}\`: ${p.check}`);
  out.push("", "## Notes", "",
    "- The R-2 settings are the ones a hot standby must match or exceed (PG docs, Hot Standby).",
    "- Numeric parts of R-1, R-2 and R-4 are small linear constraints; an SMT solver is",
    "  optional today but a natural fit if setting interdependencies grow (spec/06).",
    "- Ordering rules (R-2, R-3, X-2, X-4) are the best candidates for TLA+ verification.",
    "- R-5 (postmaster setting changed without a restart) was retired: the Actor always restarts",
    "  after a config step on a postmaster setting, and ALTER SYSTEM in SQL steps is denied (ADR 0003).");
  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const data = loadRuleData();
  writeFileSync(RULES_MD_PATH, renderRulesMarkdown(data));
  console.log(`wrote ${relative(ROOT, RULES_MD_PATH)} (${data.rules.length} rules)`);
}
