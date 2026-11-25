import { INDEX_USAGE_CHECKS } from "./index-usage";
import { LOCKING_CHECKS } from "./locking";
import { REPLICATION_CHECKS } from "./replication";
import { TICKET_SCOPE_CHECKS } from "./ticket-scope";
import { mergeDisjoint } from "../merge-disjoint";
import type { Check } from "./types";

export type { Check, CheckContext, RuleFinding } from "./types";

// The policy gate's checks, one per rule ID in rules.yaml. Each rule family
// keeps its checks in its own module and map; a new rule changes only its
// family's module. A rule ID in two families is an error, not an override.

export const CHECKS: Record<string, Check> = mergeDisjoint("rule", TICKET_SCOPE_CHECKS, REPLICATION_CHECKS, LOCKING_CHECKS, INDEX_USAGE_CHECKS);
