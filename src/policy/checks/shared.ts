import type { NodeName } from "../actions";
import type { ActionKind } from "../actions";
import type { ActionOf, ClassifiedAction } from "../classify";

// Helpers that more than one rule family uses.

export const NODES: readonly NodeName[] = ["primary", "standby"];

/** True if the text names the identifier as a whole word (quoted or not), ignoring case. */
export function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, "i").test(text);
}

/** Actions grouped by the transaction they run in, in change-request order. */
export function byTxn<A extends ClassifiedAction>(actions: readonly A[]): A[][] {
  const groups = new Map<number, A[]>();
  for (const a of actions) groups.set(a.txn.group, [...(groups.get(a.txn.group) ?? []), a]);
  return [...groups.values()];
}

/** The actions of the given kinds, in change-request order, typed by kind. */
export function ofKind<K extends ActionKind>(actions: readonly ClassifiedAction[], ...kinds: K[]): ActionOf<K>[] {
  return actions.filter((a): a is ActionOf<K> => (kinds as readonly ActionKind[]).includes(a.action));
}
