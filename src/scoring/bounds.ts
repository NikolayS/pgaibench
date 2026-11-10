// Bound ledger: where each bound of a CR (a rehearsal threshold or a step
// expectation) was judged. The one rule (src/telemetry/collect.ts
// evaluateExpectations) leaves a bound that a context cannot measure not
// judged there; the first later context with a real value judges it. A
// bound judged nowhere is counted (bounds_never_judged in outcome.json).
import type { CR } from "../schema/types";
import type { TelemetryRecord } from "../run/types";

export type BoundContext = "rehearsal" | "production" | "end_of_window";
export interface BoundEntry { source: string; metric: string; expression: string; judged_at: BoundContext | null; not_judged: { context: BoundContext; reason: string }[] }
export interface BoundLedger { bounds: BoundEntry[]; bounds_judged_rehearsal: number; bounds_judged_production: number; bounds_never_judged: number; bounds_pending_production: number }

type Rec = Pick<TelemetryRecord, "diff" | "actor"> & Partial<Pick<TelemetryRecord, "deferred_expectations">>;

/** A step judged its expectations when it ran and reached them (passed, or failed on one). */
const reached = (st: NonNullable<Rec["actor"]>["steps"][number] | undefined) => !!st && !st.skipped && (st.ok || /^Expectation breached/.test(st.error ?? ""));

export function boundLedger(cr: Pick<CR, "steps" | "rehearsal">, rehearsal: Rec | null, production: Rec | null): BoundLedger {
  const bounds: BoundEntry[] = [];
  const contexts: [BoundContext, Rec | null][] = [["rehearsal", rehearsal], ["production", production]];
  for (const [metric, expression] of Object.entries(cr.rehearsal?.thresholds ?? {})) {
    const e: BoundEntry = { source: "threshold", metric, expression: String(expression), judged_at: null, not_judged: [] };
    for (const [context, r] of contexts) {
      const t = r?.diff.thresholds.find(x => x.metric === metric);
      if (!t) continue;
      if (t.not_judged) e.not_judged.push({ context, reason: t.not_judged });
      else e.judged_at ??= context;
    }
    bounds.push(e);
  }
  cr.steps.forEach((step, i) => {
    for (const [metric, expression] of Object.entries(("expect" in step ? step.expect : {}) as Record<string, string>)) {
      const e: BoundEntry = { source: `step ${i + 1}`, metric, expression: String(expression), judged_at: null, not_judged: [] };
      for (const [context, r] of contexts) {
        const st = r?.actor?.steps[i];
        const nj = st?.not_judged?.find(n => n.metric === metric);
        if (nj) e.not_judged.push({ context, reason: nj.reason });
        else if (reached(st)) e.judged_at ??= context;
      }
      const d = production?.deferred_expectations?.find(x => x.step === i && x.metric === metric);
      if (d && !d.not_judged) e.judged_at ??= "end_of_window";
      else if (d?.not_judged) e.not_judged.push({ context: "end_of_window", reason: d.not_judged });
      bounds.push(e);
    }
  });
  const open = bounds.filter(b => b.judged_at === null && b.not_judged.length > 0).length;
  return {
    bounds,
    bounds_judged_rehearsal: bounds.filter(b => b.judged_at === "rehearsal").length,
    bounds_judged_production: bounds.filter(b => b.judged_at === "production" || b.judged_at === "end_of_window").length,
    bounds_never_judged: production ? open : 0,
    bounds_pending_production: production ? 0 : open,
  };
}
