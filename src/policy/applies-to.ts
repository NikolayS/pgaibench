import { ACTION_KINDS, type ActionKind } from "./actions";
import type { ClassifiedAction } from "./classify";
import { lockStrength, type LockMode } from "./locks";

// A rule's applies_to in rules.yaml selects the classified actions its check
// judges; review.ts passes the check only those (#20, C5). Each entry is an
// action kind, "all", or "lock>=MODE": every action that locks at MODE or
// stronger, with MODE a Postgres lock mode name such as SHARE.

const LOCK_MODES: Record<string, LockMode> = {
  "ACCESS SHARE": "AccessShareLock", "ROW SHARE": "RowShareLock", "ROW EXCLUSIVE": "RowExclusiveLock",
  "SHARE UPDATE EXCLUSIVE": "ShareUpdateExclusiveLock", "SHARE": "ShareLock",
  "SHARE ROW EXCLUSIVE": "ShareRowExclusiveLock", "EXCLUSIVE": "ExclusiveLock", "ACCESS EXCLUSIVE": "AccessExclusiveLock",
};

const LOCK_PREFIX = "lock>=";

/** Why an applies_to list selects wrongly, or undefined if it is valid. */
export function appliesToError(entries: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e)) return `${e} is listed twice`;
    seen.add(e);
    if (e === "all") continue;
    if (e.startsWith(LOCK_PREFIX)) {
      if (!(e.slice(LOCK_PREFIX.length) in LOCK_MODES)) return `${e} names no Postgres lock mode`;
      continue;
    }
    if (!(ACTION_KINDS as readonly string[]).includes(e)) return `${e} is not an action kind, all, or lock>=MODE`;
  }
  if (entries.includes("all") && entries.length > 1) return "all cannot be combined with other entries";
  return undefined;
}

/** True if a rule with these applies_to entries judges the action. */
export function appliesTo(entries: readonly string[], a: ClassifiedAction): boolean {
  return entries.some((e) => {
    if (e === "all") return true;
    if (e.startsWith(LOCK_PREFIX)) return lockStrength(a.lock.mode) >= lockStrength(LOCK_MODES[e.slice(LOCK_PREFIX.length)]!);
    return a.action === (e as ActionKind);
  });
}
