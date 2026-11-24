import type { ActionKind, NodeName } from "../actions";
import type { ActionLock, SessionState, TxnInfo } from "../locks";
import type { StateSnapshot } from "../snapshot";
import type { Node } from "./ast";

// The classifier turns each change-request step into typed actions from the
// closed vocabulary, or into a default-deny finding. It never executes anything.

export type PolicyStep =
  | { sql: string; expected_rows?: number; retries?: number }
  | { config: { name: string; value: string }; node?: "primary" | "standby" | "both" }
  | { shell: string };

/** The full change-request schema or the reduced Track 2 item shape. */
export type PolicyChangeRequest = { id: string; task: string; steps: readonly unknown[] };

export type ClassifiedAction = {
  /** Zero-based index of the change-request step this action comes from. */
  step: number;
  action: ActionKind;
  /** Schema-qualified objects the action touches or creates that must be in ticket scope. */
  objects: string[];
  /** Nodes a config step or implied restart acts on. */
  nodes?: NodeName[];
  /** The setting a config step or role setting changes. */
  setting?: string;
  /** The new value a config step or role setting writes, as written in the change request. */
  value?: string;
  /** Storage parameters a ddl.set_reloption step sets, e.g. { autovacuum_enabled: "false" }. */
  options?: Record<string, string>;
  /** obj.drop and obj.truncate: true with CASCADE. */
  cascade?: boolean;
  /** The column a column-level ALTER TABLE action changes. */
  column?: string;
  /** ddl.alter_column_type: the new type as written, e.g. "float8" or "varchar(20)". */
  new_type?: string;
  /** Lock, scan and rewrite behavior (locks.ts); classify() always sets it. */
  lock?: ActionLock;
  /** The transaction the action runs in; classify() always sets it. */
  txn?: TxnInfo;
  /** Session state in effect when the action runs; classify() always sets it. */
  session?: SessionState;
  /** The retry count the step declares, if any. */
  retries?: number;
  /** The constraint an ADD CONSTRAINT or VALIDATE CONSTRAINT acts on. */
  constraint?: ConstraintInfo;
  /** dml.bounded: the statement kind, and the row count of an INSERT ... VALUES. */
  dml?: { statement: "update" | "delete" | "insert"; values_rows?: number };
  /** dml.bounded: the expected_rows its step declares, if the step has exactly one DML statement. */
  expected_rows?: number;
  /** ext.create: the extension's name. */
  extension?: string;
};

export type ConstraintInfo = {
  name?: string;
  type?: "check" | "not_null" | "foreign_key" | "unique" | "primary_key" | "exclusion";
  /** The column the constraint proves NOT NULL (NOT NULL col, or CHECK (col IS NOT NULL)). */
  not_null_column?: string;
};

export type DenyCode =
  | "do_block" | "dynamic_sql" | "function_in_cr" | "vacuum_full" | "cluster" | "alter_system"
  | "session_kill" | "unknown_statement" | "parse_error" | "unknown_setting" | "unsettable_setting"
  | "unsafe_session_setting" | "prepared_transaction" | "malformed_step" | "locking_read" | "unknown_function";

/** A statement or step the classifier refuses (default deny). Session kills escalate. */
export type Denial = {
  step: number;
  verdict: "reject" | "escalate";
  code: DenyCode;
  reason: string;
  fix_hint: string;
  evidence: Record<string, unknown>;
};

export type Classification = { actions: ClassifiedAction[]; denials: Denial[] };

/** An action before annotate() stamps its transaction and session state. */
export type ActionDraft = ClassifiedAction;

export type Classified = { actions: ActionDraft[]; denials: Denial[] };

export const deny = (
  step: number, code: DenyCode, reason: string, fix_hint: string,
  evidence: Record<string, unknown> = {}, verdict: Denial["verdict"] = "reject",
): Classified => ({ actions: [], denials: [{ step, verdict, code, reason, fix_hint, evidence: { code, ...evidence } }] });

export const ok = (...actions: ActionDraft[]): Classified => ({ actions, denials: [] });

/** What a statement classifier sees: the whole statement, its type and body, and the step. */
export type StatementContext = { stmt: Node; type: string; body: Node; step: number; snapshot: StateSnapshot };

/**
 * Classifies one statement type. Undefined means the statement is outside the
 * vocabulary (e.g. DROP of an object kind obj.drop does not cover), and the
 * dispatcher denies it as unknown_statement.
 */
export type StatementClassifier = (ctx: StatementContext) => Classified | undefined;
