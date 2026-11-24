import { INDEX_USAGE_CHECKS } from "./index-usage";
import { LOCKING_CHECKS } from "./locking";
import { REPLICATION_CHECKS } from "./replication";
import { TICKET_SCOPE_CHECKS } from "./ticket-scope";
import type { Check } from "./types";

export type { Check, CheckContext, RuleFinding } from "./types";

// The policy gate's checks, one per rule ID in rules.yaml. Each rule family
// keeps its checks in its own module and map; a new rule changes only its
// family's module.

/** One registry from the family maps. A rule ID in two families is an error, not an override. */
export function mergeFamilies(...families: Record<string, Check>[]): Record<string, Check> {
  const merged: Record<string, Check> = {};
  for (const family of families) {
    for (const [id, check] of Object.entries(family)) {
      if (id in merged) throw new Error(`rule ${id} has a check in two rule families`);
      merged[id] = check;
    }
  }
  return merged;
}

export const CHECKS: Record<string, Check> = mergeFamilies(TICKET_SCOPE_CHECKS, REPLICATION_CHECKS, LOCKING_CHECKS, INDEX_USAGE_CHECKS);
