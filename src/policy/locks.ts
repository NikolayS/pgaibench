import type { ActionKind } from "./actions";
import { parseTimeoutMs } from "../scenarios/bounded";
import { lockModes } from "./snapshot";

// Lock, scan and rewrite behavior of each action, as data, and the transaction
// and session state each action runs under (issue #10). The classifier attaches
// both to every action; the locking and transaction rules (checks/locking.ts) read
// them instead of hard-coding Postgres semantics.

export type LockMode = (typeof lockModes)[number];

/** Table-level lock strength, weakest first (PG 18 docs, "Explicit Locking", table 13.2). */
export const lockStrength = (mode: LockMode | null): number => (mode === null ? -1 : lockModes.indexOf(mode));

export type LockProfile = {
  /** The strongest table-level lock the action takes on the relations it acts on; null for none. */
  mode: LockMode | null;
  /** Reads every row of the relation while holding the lock. */
  scans: boolean;
  /** Rewrites the whole relation while holding the lock. */
  rewrites: boolean;
};

const none: LockProfile = { mode: null, scans: false, rewrites: false };
const lock = (mode: LockMode, scans = false, rewrites = false): LockProfile => ({ mode, scans, rewrites });

// From the PG 18 lock documentation and the ALTER TABLE, CREATE INDEX, DROP
// INDEX, VACUUM and TRUNCATE pages. Classifier cases override a profile where
// the statement changes it (a foreign key takes SHARE ROW EXCLUSIVE; a column
// default from a volatile function rewrites).
export const LOCK_PROFILES: Record<ActionKind, LockProfile> = {
  "cfg.set_reload": none,
  "cfg.set_restart": none,
  "cfg.set_role": none,
  "cfg.set_session": none,
  "node.reload": none,
  "node.restart": none,
  "ddl.add_column": lock("AccessExclusiveLock"),
  "ddl.add_check_not_valid": lock("AccessExclusiveLock"),
  "ddl.validate_constraint": lock("ShareUpdateExclusiveLock", true),
  "ddl.add_constraint_validating": lock("AccessExclusiveLock", true),
  "ddl.set_not_null": lock("AccessExclusiveLock", true),
  // Without the column's current type we cannot tell a binary-coercible change
  // from a rewrite, so we assume the rewrite.
  "ddl.alter_column_type": lock("AccessExclusiveLock", true, true),
  "ddl.drop_column": lock("AccessExclusiveLock"),
  "ddl.set_reloption": lock("ShareUpdateExclusiveLock"),
  // Dropping a foreign key also locks the referenced table; the classifier
  // names it. We assume ACCESS EXCLUSIVE there too, the stronger reading.
  "ddl.drop_constraint": lock("AccessExclusiveLock"),
  "idx.create_concurrent": lock("ShareUpdateExclusiveLock", true),
  "idx.create_blocking": lock("ShareLock", true),
  "idx.drop_concurrent": lock("ShareUpdateExclusiveLock"),
  "idx.drop_blocking": lock("AccessExclusiveLock"),
  "obj.create": none,
  "obj.drop": lock("AccessExclusiveLock"),
  "obj.truncate": lock("AccessExclusiveLock"),
  "ext.create": none,
  "maint.vacuum_analyze": lock("ShareUpdateExclusiveLock", true),
  "dml.bounded": lock("RowExclusiveLock", true),
  "query.read": lock("AccessShareLock", true),
  // LOCK TABLE takes the mode it names; the classifier sets it.
  "lock.table": lock("AccessExclusiveLock"),
  // REVOKE takes ACCESS SHARE on the table while it updates the table's
  // pg_class row (pg_locks during a REVOKE in an open transaction, Postgres
  // 18.6; #22).
  "priv.revoke": lock("AccessShareLock"),
};

/** The lock an action takes and the relations it takes it on. */
export type ActionLock = LockProfile & { relations: string[] };

/**
 * The transaction an action runs in. Actions with the same group share one
 * transaction. explicit: inside BEGIN ... COMMIT; implicit: one of several
 * statements in one SQL step (the simple-query protocol runs them as one
 * transaction); none: a statement that commits on its own, or a config step,
 * which the Actor runs on its own connection outside any transaction block.
 */
export type TxnInfo = {
  group: number;
  block: "explicit" | "implicit" | "none";
  /** Ordinal of the statement (or config step) in the change request; subcommands of one ALTER TABLE share it. */
  statement: number;
};

/** Session state in effect when an action runs. */
export type SessionState = {
  /** lock_timeout in ms set by the change request (0 disables it); null when the CR has not set it. */
  lock_timeout_ms: number | null;
};

type Node = Record<string, any>;

// All SQL steps of a change request run in order on one reserved connection
// (src/actor/session.ts), so a session SET persists into later steps until a
// RESET, unless its transaction rolls back, which undoes it; SET LOCAL lasts
// until its transaction ends. Config steps run on a harness connection and
// never change the CR session.
export class TxnTracker {
  private next = 0;
  private group: number | null = null;
  private explicit = false;
  private session: number | null = null;
  /** The session value when the open transaction began; a ROLLBACK restores it. */
  private sessionAtTxnStart: number | null = null;
  private local: number | null | undefined = undefined;
  private multi = false;
  private statements = 0;

  /** Call before the statements of a SQL step. */
  beginStep(statementCount: number, inBlock = false): void {
    // A DO block runs its statements in a transaction even when it is the
    // step's only statement (inBlock), as does a step with several statements.
    this.multi = statementCount > 1 || inBlock;
  }

  /** Call after the statements of a SQL step: an implicit transaction ends with its step. */
  endStep(): void {
    if (!this.explicit) this.endTxn();
  }

  /** Update state for one statement and return what its actions run under. */
  statement(stmt: Node): { txn: TxnInfo; session: SessionState } | null {
    const [type] = Object.keys(stmt);
    const body = stmt[type];
    if (type === "TransactionStmt") {
      if (body.kind === "TRANS_STMT_BEGIN" || body.kind === "TRANS_STMT_START") {
        // A BEGIN inside a multi-statement step turns its implicit transaction explicit.
        if (this.group === null) this.beginTxn();
        this.explicit = true;
      } else if (body.kind === "TRANS_STMT_COMMIT" || body.kind === "TRANS_STMT_ROLLBACK") {
        if (body.kind === "TRANS_STMT_ROLLBACK" && this.group !== null) this.session = this.sessionAtTxnStart;
        this.endTxn();
      }
      return null;
    }
    if (this.group === null) this.beginTxn();
    this.statements++;
    if (type === "VariableSetStmt") this.setVariable(body);
    return { txn: this.current(), session: this.sessionState() };
  }

  /** What a config step runs under: its own connection, during any open CR transaction. */
  config(): { txn: TxnInfo; session: SessionState } {
    const group = this.explicit && this.group !== null ? this.group : ++this.next;
    return { txn: { group, block: this.explicit ? "explicit" : "none", statement: ++this.statements }, session: { lock_timeout_ms: null } };
  }

  private current(): TxnInfo {
    return { group: this.group!, block: this.explicit ? "explicit" : this.multi ? "implicit" : "none", statement: this.statements };
  }

  private sessionState(): SessionState {
    return { lock_timeout_ms: this.local !== undefined ? this.local : this.session };
  }

  private beginTxn(): void {
    this.group = ++this.next;
    this.sessionAtTxnStart = this.session;
  }

  private endTxn(): void {
    this.group = null;
    this.explicit = false;
    this.local = undefined;
  }

  private setVariable(body: Node): void {
    if (body.kind === "VAR_RESET_ALL" || (body.name === "lock_timeout" && (body.kind === "VAR_RESET" || body.kind === "VAR_SET_DEFAULT"))) {
      this.session = null;
      this.local = undefined;
      return;
    }
    if (body.name !== "lock_timeout" || body.kind !== "VAR_SET_VALUE") return;
    const value = timeoutArg(body.args?.[0]?.A_Const);
    if (body.is_local) this.local = value;
    else {
      this.session = value;
      this.local = undefined;
    }
  }
}

// A lock_timeout value in ms; a bare number is in ms, the setting's unit.
// An unreadable value counts as unset (no protection).
function timeoutArg(c: Node | undefined): number | null {
  if (!c) return null;
  if (c.ival) return c.ival.ival ?? 0;
  if (c.fval) return Number(c.fval.fval);
  if (c.sval) return parseTimeoutMs(c.sval.sval);
  return null;
}
