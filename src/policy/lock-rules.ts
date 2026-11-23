import type { Check, CheckContext } from "./checks";
import type { ClassifiedAction } from "./classify";
import { lockStrength, type LockMode } from "./locks";

// Locking and transaction-structure rules L-1 to L-4 and X-1 to X-4 (issue #10).
// They read the lock, transaction and session data the classifier attaches to
// each action (locks.ts).

const UNITS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, B: 1, kB: 1024, MB: 1024 ** 2, GiB: 1024 ** 3, GB: 1024 ** 3, MiB: 1024 ** 2, TiB: 1024 ** 4 };

/** A threshold from the rule data in ms (durations) or bytes (sizes). */
function threshold(ctx: CheckContext, name: string): number {
  const raw = ctx.thresholds[name]?.value;
  if (typeof raw === "number") return raw;
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(raw ?? "");
  if (!m || UNITS[m[2]] === undefined) throw new Error(`Threshold ${name} has no readable value: ${raw}`);
  return Number(m[1]) * UNITS[m[2]];
}

const atLeast = (a: ClassifiedAction, mode: LockMode) => lockStrength(a.lock?.mode ?? null) >= lockStrength(mode);

const describe = (a: ClassifiedAction) => `Step ${a.step} (${a.action} on ${a.lock?.relations.join(", ") || a.objects.join(", ")})`;

// L-1: a step taking SHARE or stronger runs with lock_timeout <= T_lock set in
// its own session (SET, or SET LOCAL in the same transaction), and declares retries.
export const lockTimeoutSet: Check = (ctx) => {
  const limit = threshold(ctx, "T_lock");
  return ctx.actions.filter((a) => atLeast(a, "ShareLock")).flatMap((a) => {
    const ms = a.session?.lock_timeout_ms ?? null;
    const protectedStep = ms !== null && ms > 0 && ms <= limit;
    const retries = (a.retries ?? 0) > 0;
    if (protectedStep && retries) return [];
    const missing = [
      ...(protectedStep ? [] : [ms === null || ms === 0 ? "no lock_timeout is set in its session" : `its session's lock_timeout (${ms} ms) is above T_lock (${limit} ms)`]),
      ...(retries ? [] : ["it declares no retry count"]),
    ];
    return [{
      step: a.step,
      reason: `${describe(a)} takes ${a.lock!.mode}, but ${missing.join(" and ")}. Waiting for that lock queues every later query on the table.`,
      fix_hint: `Run SET lock_timeout = '1s' (at most ${limit / 1000}s) in an earlier step, or SET LOCAL in the same transaction, and give the step a retry count.`,
      evidence: { action: a.action, lock: a.lock!.mode, relations: a.lock!.relations, lock_timeout_ms: ms, retries: a.retries ?? null },
    }];
  });
};

const appliesTo = (ctx: CheckContext, a: ClassifiedAction) => ctx.rule.applies_to.includes(a.action);

/** The size of the relation an action acts on (its first locked relation); undefined when the snapshot does not list it. */
function targetSize(ctx: CheckContext, a: ClassifiedAction): { relation: string; total_bytes: number } | undefined {
  const relation = a.lock?.relations[0] ?? a.objects[0];
  const rel = relation === undefined ? undefined : ctx.snapshot.relations[relation];
  return rel ? { relation, total_bytes: rel.total_bytes } : undefined;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

// L-3: a validating constraint, blocking index build or rewriting column type
// change scans or rewrites its table under a lock that blocks writes, so the
// table may be at most S_scan. A relation the snapshot does not list (created
// earlier in the change request) is not measured.
export const lockedScanSize: Check = (ctx) => {
  const limit = threshold(ctx, "S_scan");
  return ctx.actions
    .filter((a) => appliesTo(ctx, a) && (a.action !== "ddl.alter_column_type" || a.lock?.rewrites))
    .flatMap((a) => {
      const size = targetSize(ctx, a);
      if (!size || size.total_bytes <= limit) return [];
      return [{
        step: a.step,
        reason: `${describe(a)} ${a.lock?.rewrites ? "rewrites" : "scans"} ${size.relation} (${gib(size.total_bytes)}, above S_scan ${gib(limit)}) while holding ${a.lock?.mode}, blocking writes for the whole ${a.lock?.rewrites ? "rewrite" : "scan"}.`,
        fix_hint: ctx.rule.fix_hint ?? "Use a form that does not scan under a blocking lock.",
        evidence: { action: a.action, relation: size.relation, total_bytes: size.total_bytes, limit_bytes: limit, lock: a.lock?.mode },
      }];
    });
};

// The column a catalog constraint definition proves NOT NULL, if any.
function provenColumn(definition: string): string | undefined {
  const m = /^NOT NULL "?(\w+)"?$/i.exec(definition.trim()) ?? /^CHECK \(+"?(\w+)"? IS NOT NULL\)+$/i.exec(definition.trim());
  return m?.[1];
}

// Whether a validated constraint proves the column NOT NULL before the action
// runs: one already in the catalog, or one validated earlier in the change request.
function notNullProven(ctx: CheckContext, a: ClassifiedAction, table: string, column: string): boolean {
  const catalog = ctx.snapshot.constraints.filter((c) => c.table === table);
  if (catalog.some((c) => c.validated && provenColumn(c.definition) === column)) return true;
  const earlier = ctx.actions.slice(0, ctx.actions.indexOf(a)).filter((x) => x.objects[0] === table);
  const proves = (name: string | undefined) =>
    earlier.some((x) => x.action === "ddl.add_check_not_valid" && x.constraint?.name === name && x.constraint?.not_null_column === column)
    || catalog.some((c) => c.name === name && provenColumn(c.definition) === column);
  return earlier.some((x) =>
    (x.action === "ddl.add_constraint_validating" && x.constraint?.not_null_column === column)
    || (x.action === "ddl.validate_constraint" && proves(x.constraint?.name)));
}

// L-4: SET NOT NULL scans the table under ACCESS EXCLUSIVE unless a validated
// constraint already proves the column, so a table above S_scan needs the proof.
export const setNotNullProven: Check = (ctx) => {
  const limit = threshold(ctx, "S_scan");
  return ctx.actions.filter((a) => appliesTo(ctx, a)).flatMap((a) => {
    const size = targetSize(ctx, a);
    if (!size || size.total_bytes <= limit || notNullProven(ctx, a, size.relation, a.column!)) return [];
    return [{
      step: a.step,
      reason: `${describe(a)} scans ${size.relation} (${gib(size.total_bytes)}, above S_scan ${gib(limit)}) under ACCESS EXCLUSIVE to check ${a.column}, because no validated constraint proves ${a.column} NOT NULL.`,
      fix_hint: ctx.rule.fix_hint ?? "Prove the column NOT NULL with a validated constraint first.",
      evidence: { action: a.action, relation: size.relation, column: a.column, total_bytes: size.total_bytes, limit_bytes: limit },
    }];
  });
};

// X-1: these actions must run outside a transaction block. Postgres refuses a
// concurrent index build or VACUUM inside one (a multi-statement step is an
// implicit block), and a config step or reload takes effect at once, outside
// the transaction's rollback.
export const outsideTxnBlock: Check = (ctx) =>
  ctx.actions.filter((a) => appliesTo(ctx, a) && a.txn && a.txn.block !== "none").map((a) => ({
    step: a.step,
    reason: a.txn!.block === "explicit"
      ? `Step ${a.step} (${a.action}) runs while a BEGIN is open; it must run outside a transaction block.`
      : `Step ${a.step} (${a.action}) shares its SQL step with other statements, which run as one implicit transaction; it must run outside a transaction block.`,
    fix_hint: "Put the statement in its own SQL step, after the COMMIT of any open transaction.",
    evidence: { action: a.action, block: a.txn!.block, txn_group: a.txn!.group },
  }));

// Actions grouped by the transaction they run in, in change-request order.
function byTxn(actions: readonly ClassifiedAction[]): ClassifiedAction[][] {
  const groups = new Map<number, ClassifiedAction[]>();
  for (const a of actions) if (a.txn) groups.set(a.txn.group, [...(groups.get(a.txn.group) ?? []), a]);
  return [...groups.values()];
}

// X-3: locks are held until COMMIT, so a second ACCESS EXCLUSIVE statement on a
// large relation in the same transaction stretches the time it stays locked.
export const oneBigExclusivePerTxn: Check = (ctx) => {
  const limit = threshold(ctx, "S_scan");
  const big = (a: ClassifiedAction) => a.lock?.mode === "AccessExclusiveLock"
    && a.lock.relations.find((r) => (ctx.snapshot.relations[r]?.total_bytes ?? 0) > limit);
  return byTxn(ctx.actions).flatMap((group) => {
    // One hit per statement: the subcommands of one ALTER TABLE take the lock once.
    const seen = new Set<number>();
    const [first, ...rest] = group.filter((a) => big(a) && !seen.has(a.txn!.statement) && seen.add(a.txn!.statement));
    return rest.map((a) => {
        const relation = big(a) as string;
        return {
          step: a.step,
          reason: `Step ${a.step} (${a.action}) takes ACCESS EXCLUSIVE on ${relation}, above S_scan, in the same transaction as step ${first.step} (${first.action}); the lock is held across both until COMMIT.`,
          fix_hint: "COMMIT between the two statements, each with its own lock_timeout and retries.",
          evidence: { action: a.action, relation, first_step: first.step, txn_group: a.txn!.group },
        };
      });
  });
};

// X-4: DML in the same transaction as a SHARE ROW EXCLUSIVE or stronger lock
// keeps that lock held while the DML runs, which grows with the rows it changes.
export const noDdlWithDml: Check = (ctx) => byTxn(ctx.actions).flatMap((group) => {
  const dml = group.find((a) => a.action === "dml.bounded");
  if (!dml) return [];
  return group.filter((a) => a !== dml && a.action !== "dml.bounded" && atLeast(a, "ShareRowExclusiveLock")).map((a) => ({
    step: a.step,
    reason: `Step ${a.step} (${a.action}) takes ${a.lock!.mode} on ${a.lock!.relations.join(", ")} in the same transaction as DML in step ${dml.step}, so the lock is held until the DML commits.`,
    fix_hint: "COMMIT the schema change first, then run the DML in its own transactions, batched to at most B rows each.",
    evidence: { action: a.action, lock: a.lock!.mode, relation: a.lock!.relations[0], dml_step: dml.step, txn_group: a.txn!.group },
  }));
});

// X-2: a NOT VALID add holds its ACCESS EXCLUSIVE lock until COMMIT, so a
// VALIDATE in the same transaction scans the table under that lock.
export const notValidCommitted: Check = (ctx) => ctx.actions.flatMap((v, i) => {
  if (v.action !== "ddl.validate_constraint") return [];
  const add = ctx.actions.slice(0, i).find((a) =>
    a.action === "ddl.add_check_not_valid" && a.objects[0] === v.objects[0] && a.txn?.group === v.txn?.group
    && (a.constraint?.name === undefined || a.constraint.name === v.constraint?.name));
  if (!add) return [];
  return [{
    step: v.step,
    reason: `Step ${v.step} validates ${v.constraint?.name} on ${v.objects[0]} in the same transaction as its NOT VALID add (step ${add.step}), so the scan runs under the add's ACCESS EXCLUSIVE lock.`,
    fix_hint: "COMMIT after the NOT VALID add, then VALIDATE CONSTRAINT in its own transaction.",
    evidence: { constraint: v.constraint?.name, relation: v.objects[0], add_step: add.step, txn_group: v.txn?.group },
  }];
});

// L-2: no transaction older than A_txn holds or waits on a lock on a relation
// the step locks at SHARE or stronger. The review never waits: it defers, and
// the live driver rechecks (ADR 0004). Locks are read from the primary, where
// the step runs; the oldest blocker is reported.
export const noOldBlocker: Check = (ctx) => {
  const limitS = threshold(ctx, "A_txn") / 1000;
  const locks = ctx.snapshot.nodes.primary.locks;
  return ctx.actions.filter((a) => atLeast(a, "ShareLock")).flatMap((a) => {
    const old = locks
      .filter((l) => a.lock!.relations.includes(l.relation) && (l.xact_age_s ?? 0) > limitS)
      .sort((x, y) => (y.xact_age_s ?? 0) - (x.xact_age_s ?? 0));
    if (old.length === 0) return [];
    const l = old[0];
    return [{
      step: a.step,
      reason: `L-2: ${describe(a)} needs ${a.lock!.mode}, but a transaction ${l.xact_age_s} s old (pid ${l.pid}, older than A_txn ${limitS} s) ${l.granted ? "holds" : "waits on"} ${l.mode} on ${l.relation}.`,
      fix_hint: "Wait for the old transaction to end; if it does not end within D_budget, a human decides whether to end it.",
      evidence: { action: a.action, relation: l.relation, mode: l.mode, granted: l.granted, pid: l.pid, xact_age_s: l.xact_age_s, blockers: old.length },
    }];
  });
};
