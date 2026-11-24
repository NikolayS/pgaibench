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

/** Postgres memory units, in bytes (1024-based, as pg_settings uses them). */
export const MEMORY_UNITS: Record<string, number> = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
/** Postgres time units, in ms. */
export const TIME_UNITS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
// Thresholds may also name sizes in IEC units, e.g. 1GiB.
const THRESHOLD_UNITS: Record<string, number> = {
  ...MEMORY_UNITS, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, ...TIME_UNITS,
};

/**
 * A threshold from the rule data as a number: sizes in bytes, durations in ms,
 * and a plain number (B) as given. Every rule reads thresholds through this.
 */
export function thresholdValue(thresholds: RuleData["thresholds"], name: string): number {
  const raw = thresholds[name]?.value;
  if (typeof raw === "number") return raw;
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/.exec(raw ?? "");
  const unit = m ? (m[2] === undefined ? 1 : THRESHOLD_UNITS[m[2]]) : undefined;
  if (!m || unit === undefined) throw new Error(`Threshold ${name} has no readable value: ${raw}`);
  return Number(m[1]) * unit;
}
