import { CHECKS, type Check } from "./checks";
import { classify, type PolicyChangeRequest } from "./classify";
import { loadRuleData, type Rule, type RuleData } from "./rule-data";
import type { TicketScope } from "./scope";
import type { StateSnapshot } from "./snapshot";

// Policy review: the policy gate's first test seam. A pure function of the
// change request, the state snapshot and the ticket scope. It executes nothing
// and never waits; rechecking a defer is the live driver's job (ADR 0004).
// Call loadParser() once before using it.

export type FindingVerdict = "reject" | "escalate" | "defer";

export type Finding = {
  /** Policy rule ID (e.g. "TS-1"), or "default-deny" for a step that does not classify. */
  rule: string;
  verdict: FindingVerdict;
  /** Zero-based index of the offending change-request step. */
  step: number;
  reason: string;
  fix_hint: string;
  evidence: Record<string, unknown>;
};

/** approve, reject or escalate is a verdict; defer is a transient hold, never a verdict. */
export type ReviewResult = {
  verdict: "approve" | "reject" | "escalate" | "defer";
  /** Every finding, not just the deciding one. */
  findings: Finding[];
};

export type ReviewOptions = {
  /** Replace the check functions for some rule IDs (tests only). */
  checks?: Record<string, Check>;
  /** The ticket's free text. It never widens scope; TS-6 uses it only to name a planted instruction. */
  ticketText?: string;
};

let ruleData: RuleData | undefined;

// Reject beats escalate, escalate beats defer, defer beats approve.
const PRECEDENCE = ["reject", "escalate", "defer"] as const;

// A fixed-verdict rule's findings take its verdict; a reject_or_escalate check
// must choose one of the two for each finding.
function findingVerdict(id: string, ruleVerdict: Rule["verdict"], chosen: FindingVerdict | undefined): FindingVerdict {
  if (ruleVerdict === "reject_or_escalate") {
    if (chosen === "reject" || chosen === "escalate") return chosen;
    throw new Error(`Check for ${id} must choose reject or escalate, not ${chosen ?? "nothing"}`);
  }
  if (chosen !== undefined && chosen !== ruleVerdict) throw new Error(`Check for ${id} returned ${chosen}, but ${id} is a ${ruleVerdict} rule`);
  return ruleVerdict;
}

export function reviewChangeRequest(
  cr: PolicyChangeRequest, snapshot: StateSnapshot, scope: TicketScope, options: ReviewOptions = {},
): ReviewResult {
  const data = (ruleData ??= loadRuleData());
  const ruleIds = new Set(data.rules.map((r) => r.id));
  for (const id of Object.keys(options.checks ?? {})) {
    if (!ruleIds.has(id)) throw new Error(`No policy rule ${id} for the supplied check`);
  }
  const checks = { ...CHECKS, ...options.checks };

  const { actions, denials } = classify(cr, snapshot);
  const findings: Finding[] = denials.map(({ code: _code, ...d }) => ({ rule: "default-deny", ...d }));
  for (const rule of data.rules) {
    const check = checks[rule.id];
    if (!check) throw new Error(`No check function for policy rule ${rule.id}`);
    for (const f of check({ actions, snapshot, scope, rule, thresholds: data.thresholds, ticketText: options.ticketText })) {
      const verdict = findingVerdict(rule.id, rule.verdict, f.verdict);
      findings.push({ rule: rule.id, verdict, step: f.step, reason: f.reason, fix_hint: f.fix_hint, evidence: f.evidence });
    }
  }
  const verdict = PRECEDENCE.find((v) => findings.some((f) => f.verdict === v)) ?? "approve";
  return { verdict, findings };
}
