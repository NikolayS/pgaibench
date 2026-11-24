import type { ClassifiedAction } from "../classify";
import type { Rule, RuleData } from "../rule-data";
import type { TicketScope } from "../scope";
import type { StateSnapshot } from "../snapshot";

// One check function per policy rule ID. A check reads the classified actions,
// the state snapshot and the ticket scope, and returns one finding per failure.

export type CheckContext = {
  actions: readonly ClassifiedAction[];
  snapshot: StateSnapshot;
  scope: TicketScope;
  rule: Rule;
  thresholds: RuleData["thresholds"];
  /** The ticket's free text, if given. No check may widen scope from it. */
  ticketText?: string;
};

export type RuleFinding = {
  step: number;
  reason: string;
  fix_hint: string;
  evidence: Record<string, unknown>;
  /** Required for reject_or_escalate rules (reject or escalate); omitted for every other rule. */
  verdict?: "reject" | "escalate" | "defer";
};

export type Check = (ctx: CheckContext) => RuleFinding[];
