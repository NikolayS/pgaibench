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

/** What every classified action carries, whatever its kind. */
type ActionBase = {
  /** Zero-based index of the change-request step this action comes from. */
  step: number;
  /** Schema-qualified objects the action touches or creates that must be in ticket scope. */
  objects: string[];
  /** Lock, scan and rewrite behavior (locks.ts). */
  lock: ActionLock;
  /** The transaction the action runs in. */
  txn: TxnInfo;
  /** Session state in effect when the action runs. */
  session: SessionState;
  /** The retry count the step declares, if any. */
  retries?: number;
};

/**
 * Each action kind with the facts it carries beyond ActionBase. A kind
 * appears in exactly one entry; the check below fails the typecheck otherwise.
 */
type ActionPayloads = [
  /** A config step: the nodes it acts on, the setting and its new value, as written. */
  { action: "cfg.set_reload" | "cfg.set_restart"; nodes: NodeName[]; setting: string; value: string },
  /** The restart a postmaster-context config step implies, one per node (ADR 0003). */
  { action: "node.restart"; nodes: NodeName[]; setting: string },
  /** ALTER ROLE or ALTER DATABASE ... SET or RESET; value only for SET name = value. */
  { action: "cfg.set_role"; setting?: string; value?: string },
  /** SET, SET LOCAL or RESET in the change request's own session. */
  { action: "cfg.set_session"; setting: string },
  /** A column-level ALTER TABLE action: the column it changes. */
  { action: "ddl.add_column" | "ddl.set_not_null" | "ddl.drop_column"; column: string },
  /** The column and its new type as written, e.g. "float8" or "varchar(20)". */
  { action: "ddl.alter_column_type"; column: string; new_type: string },
  /** The constraint an ADD CONSTRAINT or VALIDATE CONSTRAINT acts on. */
  { action: "ddl.add_check_not_valid" | "ddl.add_constraint_validating" | "ddl.validate_constraint" | "ddl.drop_constraint"; constraint: ConstraintInfo },
  /** Storage parameters set, e.g. { autovacuum_enabled: "false" }, and any RESET to their defaults. */
  { action: "ddl.set_reloption"; options: Record<string, string>; reset?: string[] },
  /** True with CASCADE. */
  { action: "obj.drop" | "obj.truncate"; cascade: boolean },
  /**
   * The statement kind and the row count of an INSERT ... VALUES; expected_rows
   * is the step's, if the step has exactly one DML statement.
   */
  { action: "dml.bounded"; dml: { statement: "update" | "delete" | "insert"; values_rows?: number }; expected_rows?: number },
  /** The extension's name. */
  { action: "ext.create"; extension: string },
  {
    action: "node.reload" | "obj.create" | "maint.vacuum_analyze" | "query.read"
      | "idx.create_concurrent" | "idx.create_blocking" | "idx.drop_concurrent" | "idx.drop_blocking" | "lock.table";
  },
];

type ActionPayload = ActionPayloads[number];

/** A classified action: its kind's payload on top of what every action carries. */
export type ClassifiedAction = ActionPayload extends infer P ? P extends ActionPayload ? ActionBase & P : never : never;

/**
 * The classified actions of the given kinds, with action narrowed to them. A
 * variant shared by several kinds (e.g. obj.drop and obj.truncate) is kept
 * for the kinds asked for.
 */
export type ActionOf<K extends ActionKind> = ClassifiedAction extends infer A
  ? A extends { action: infer X } ? ([Extract<X, K>] extends [never] ? never : A & { action: Extract<X, K> }) : never
  : never;

// Compile-time check: the payload entries cover the vocabulary in actions.ts,
// each kind exactly once. A missing kind or a kind in two entries is a type error here.
type KindsOf<T extends readonly unknown[]> = { [I in keyof T]: T[I] extends { action: infer A } ? A : never };
type Overlaps<T extends readonly unknown[], Seen = never> =
  T extends readonly [infer H, ...infer R] ? ([H & Seen] extends [never] ? Overlaps<R, Seen | H> : H & Seen) : never;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const actionKindsCovered: Exactly<KindsOf<ActionPayloads>[number], ActionKind> = true;
const actionKindsOnce: [Overlaps<KindsOf<ActionPayloads>>] extends [never] ? true : false = true;
void actionKindsCovered;
void actionKindsOnce;

export type ConstraintInfo = {
  name?: string;
  type?: "check" | "not_null" | "foreign_key" | "unique" | "primary_key" | "exclusion";
  /** The column the constraint proves NOT NULL (NOT NULL col, or CHECK (col IS NOT NULL)). */
  not_null_column?: string;
};

export type DenyCode =
  | "do_block" | "dynamic_sql" | "function_in_cr" | "vacuum_full" | "cluster" | "alter_system"
  | "session_kill" | "unknown_statement" | "parse_error" | "unknown_setting" | "unsettable_setting"
  | "unsafe_session_setting" | "prepared_transaction" | "malformed_step" | "locking_read" | "unknown_function"
  | "lock_outside_txn";

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

/**
 * An action before annotate() adds its transaction and session state. A
 * classifier may set lock itself (ALTER TABLE does, from the subcommand);
 * annotate() fills in the default lock profile otherwise.
 */
export type ActionDraft = ClassifiedAction extends infer A
  ? A extends ClassifiedAction ? Omit<A, "lock" | "txn" | "session" | "retries"> & { lock?: ActionLock } : never : never;

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
