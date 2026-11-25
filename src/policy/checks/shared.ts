import type { NodeName } from "../actions";
import type { ActionKind } from "../actions";
import type { ActionOf, ClassifiedAction } from "../classify";
import type { Check, CheckContext, RuleFinding } from "./types";

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

/**
 * A check that judges only actions of the given kinds, typed by kind. The kinds
 * stay readable on the check (kindsOf), so a test can hold them equal to the
 * rule's applies_to in rules.yaml, which review.ts filters by (#20, C5).
 */
export function forKinds<K extends ActionKind>(
  kinds: readonly K[], fn: (ctx: Omit<CheckContext, "actions"> & { actions: ActionOf<K>[] }) => RuleFinding[],
): Check {
  const check: Check = (ctx) => fn({ ...ctx, actions: ofKind(ctx.actions, ...kinds) });
  return Object.assign(check, { kinds });
}

/** The kinds a forKinds check narrows to, or undefined for any other check. */
export const kindsOf = (check: Check): readonly ActionKind[] | undefined => (check as { kinds?: readonly ActionKind[] }).kinds;
