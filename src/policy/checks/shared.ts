import type { NodeName } from "../actions";
import type { ClassifiedAction } from "../classify";

// Helpers that more than one rule family uses.

export const NODES: readonly NodeName[] = ["primary", "standby"];

/** True if the text names the identifier as a whole word (quoted or not), ignoring case. */
export function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, "i").test(text);
}

/** Actions grouped by the transaction they run in, in change-request order. */
export function byTxn(actions: readonly ClassifiedAction[]): ClassifiedAction[][] {
  const groups = new Map<number, ClassifiedAction[]>();
  for (const a of actions) if (a.txn) groups.set(a.txn.group, [...(groups.get(a.txn.group) ?? []), a]);
  return [...groups.values()];
}
