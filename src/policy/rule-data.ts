import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The policy rules and thresholds, loaded from rules.yaml (the source of truth
// for rule text) and validated with zod.

export const RULES_YAML_PATH = join(import.meta.dir, "rules.yaml");

const ruleSchema = z.object({
  id: z.string().regex(/^(TS|R|L|X|I|U|T|S)-\d+$/),
  scope: z.enum(["step", "plan"]),
  applies_to: z.array(z.string().min(1)).min(1),
  settings: z.array(z.string().min(1)).optional(),
  condition: z.string().trim().min(1),
  verdict: z.enum(["reject", "defer", "escalate", "reject_or_escalate"]),
  fix_hint: z.string().min(1).optional(),
  targets: z.array(z.string()),
}).strict();

export const ruleDataSchema = z.object({
  version: z.number().int().nonnegative(),
  thresholds: z.record(z.string(), z.object({ value: z.union([z.string(), z.number()]), meaning: z.string().min(1) }).strict()),
  rules: z.array(ruleSchema).min(1),
  postconditions: z.array(z.object({ after: z.string().min(1), check: z.string().min(1) }).strict()),
}).strict().superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.rules.forEach((r, i) => {
    if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `Duplicate rule ID ${r.id}` });
    seen.add(r.id);
  });
});

export type RuleData = z.infer<typeof ruleDataSchema>;
export type Rule = RuleData["rules"][number];

export function parseRuleData(value: unknown): RuleData {
  return ruleDataSchema.parse(value);
}

export function loadRuleData(path = RULES_YAML_PATH): RuleData {
  return parseRuleData(Bun.YAML.parse(readFileSync(path, "utf8")));
}
