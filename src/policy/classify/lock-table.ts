import { lockModes } from "../snapshot";
import { qualify, type Node } from "./ast";
import { ok, type StatementClassifier } from "./types";

// LOCK TABLE (#22): changes nothing, but holds the lock it names until the
// transaction ends. A change request uses it to take locks in a safe order
// (L6.good takes SHARE ROW EXCLUSIVE first, so its foreign key cannot deadlock
// with the workload). Postgres allows it only inside a transaction; classify()
// denies one that runs outside any (lock_outside_txn).

export const LOCK_STATEMENTS: Record<string, StatementClassifier> = {
  LockStmt: ({ body, step }) => {
    const relations: string[] = (body.relations ?? []).map((r: Node) => qualify(r.RangeVar.schemaname, r.RangeVar.relname));
    // The parse tree numbers lock modes 1 (ACCESS SHARE) to 8 (ACCESS EXCLUSIVE), weakest first.
    const mode = lockModes[(body.mode ?? 8) - 1] ?? "AccessExclusiveLock";
    return ok({ step, action: "lock.table", objects: relations, lock: { mode, scans: false, rewrites: false, relations } });
  },
};
