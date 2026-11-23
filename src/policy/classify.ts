import type { ActionKind, NodeName } from "./actions";
import { LOCK_PROFILES, TxnTracker, type ActionLock, type SessionState, type TxnInfo } from "./locks";
import { parseSql } from "./parse";
import type { StateSnapshot } from "./snapshot";

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
  /** The column a column-level ALTER TABLE action changes. */
  column?: string;
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

type Classified = { actions: ClassifiedAction[]; denials: Denial[] };

const deny = (
  step: number, code: DenyCode, reason: string, fix_hint: string,
  evidence: Record<string, unknown> = {}, verdict: Denial["verdict"] = "reject",
): Classified => ({ actions: [], denials: [{ step, verdict, code, reason, fix_hint, evidence: { code, ...evidence } }] });

const ok = (...actions: ClassifiedAction[]): Classified => ({ actions, denials: [] });

// Session settings that change which objects later statements resolve to, the
// privileges they run with, or whether triggers and foreign keys fire.
const UNSAFE_SESSION_SETTINGS = new Set(["search_path", "role", "session_authorization", "session_replication_role"]);

const PREPARED_TRANSACTION_KINDS = new Set(["TRANS_STMT_PREPARE", "TRANS_STMT_COMMIT_PREPARED", "TRANS_STMT_ROLLBACK_PREPARED"]);

/** Stands for every relation in the database, which no ticket scope lists. */
const ALL_RELATIONS = "*";

// Built-in functions a query.read may call: none writes, locks, signals or
// changes settings. Any other function in a SELECT is denied, because the
// parse tree cannot show what a user-defined function does.
const READ_ONLY_FUNCTIONS = new Set([
  "count", "sum", "min", "max", "avg", "bool_and", "bool_or", "string_agg", "array_agg",
  "now", "current_setting", "age", "date_trunc", "date_part", "extract", "to_char", "round", "abs",
  "lower", "upper", "length", "format_type", "quote_ident", "split_part",
  "pg_size_pretty", "pg_total_relation_size", "pg_relation_size", "pg_table_size", "pg_indexes_size",
  "pg_describe_object", "pg_get_indexdef", "pg_get_constraintdef", "pg_get_viewdef",
  "pg_is_in_recovery", "pg_current_wal_lsn", "pg_last_wal_replay_lsn", "pg_wal_lsn_diff",
]);

const functionName = (call: Node): string => {
  const parts: string[] = call.funcname.map((p: Node) => p.String?.sval);
  return parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : parts.join(".");
};

// Every function a parse tree calls.
function calledFunctions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => calledFunctions(n, out));
  else if (node !== null && typeof node === "object") {
    const call = (node as Node).FuncCall;
    if (call) out.push(functionName(call));
    Object.values(node).forEach((v) => calledFunctions(v, out));
  }
  return out;
}

// True if any node in the tree passes the test.
function hasNode(node: unknown, test: (n: Node) => boolean): boolean {
  if (Array.isArray(node)) return node.some((n) => hasNode(n, test));
  if (node === null || typeof node !== "object") return false;
  return test(node as Node) || Object.values(node).some((v) => hasNode(v, test));
}

function classifySelect(stmt: Node, body: Node, step: number): Classified {
  const targets: Node[] = body.targetList ?? [];
  const onlyCall = targets.length === 1 && !body.fromClause ? targets[0].ResTarget?.val?.FuncCall : undefined;
  if (onlyCall && functionName(onlyCall) === "pg_reload_conf" && !onlyCall.args) {
    return ok({ step, action: "node.reload", objects: [] });
  }
  if (hasNode(stmt, (n) => n.SelectStmt?.intoClause)) {
    return deny(step, "unknown_statement", `Step ${step} is SELECT ... INTO, which creates a table.`,
      "Use CREATE TABLE ... AS only if the ticket scope allows the new table.", { statement: "SelectStmt" });
  }
  if (hasNode(stmt, (n) => n.CommonTableExpr && !n.CommonTableExpr.ctequery?.SelectStmt)) {
    return deny(step, "unknown_statement", `Step ${step} has a data-modifying WITH query, which the policy gate does not classify.`,
      "Write each change as its own SQL step.", { statement: "SelectStmt" });
  }
  if (hasNode(stmt, (n) => n.SelectStmt?.lockingClause)) {
    return deny(step, "locking_read", `Step ${step} locks rows with FOR UPDATE or FOR SHARE.`,
      "Remove the locking clause; a change request may not hold row locks across steps.");
  }
  const unknown = [...new Set(calledFunctions(stmt).filter((f) => !READ_ONLY_FUNCTIONS.has(f)))];
  if (unknown.length > 0) {
    return deny(step, "unknown_function", `Step ${step} calls ${unknown.join(", ")}, which the policy gate does not know to be read-only.`,
      "Use only read-only built-in functions, or write the change as explicit SQL steps.", { functions: unknown });
  }
  // A read changes nothing, so it touches no object for ticket scope.
  return ok({ step, action: "query.read", objects: [] });
}

const SESSION_KILLS = new Set(["pg_terminate_backend", "pg_cancel_backend"]);

// The first session-kill function called anywhere in a parse tree, if any.
function findSessionKill(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findSessionKill(n);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const call = (node as Node).FuncCall;
  if (call) {
    const name = call.funcname?.at(-1)?.String?.sval;
    if (SESSION_KILLS.has(name)) return name;
  }
  for (const v of Object.values(node)) {
    const hit = findSessionKill(v);
    if (hit) return hit;
  }
  return undefined;
}

const DEFAULT_SCHEMA = "public";

type Node = Record<string, any>;

const qualify = (schemaname: string | undefined, relname: string) => `${schemaname ?? DEFAULT_SCHEMA}.${relname}`;

const nameFromList = (list: Node): string => {
  const parts = (list.List?.items ?? []).map((i: Node) => i.String?.sval as string);
  return parts.length === 1 ? qualify(undefined, parts[0]) : parts.join(".");
};

function classifyStatement(stmt: Node, step: number, snapshot: StateSnapshot): Classified {
  const [type] = Object.keys(stmt);
  const body = stmt[type];
  const kill = findSessionKill(stmt);
  if (kill) {
    return deny(step, "session_kill", `Step ${step} calls ${kill}; a human decides on session kills.`,
      "Escalate to a human instead of ending sessions in the change request.", { function: kill }, "escalate");
  }
  switch (type) {
    case "TransactionStmt":
      // Transaction boundaries and savepoints are not actions. A prepared
      // transaction outlives the change request, holding its locks.
      if (PREPARED_TRANSACTION_KINDS.has(body.kind)) {
        return deny(step, "prepared_transaction", `Step ${step} uses a prepared (two-phase) transaction, which can outlive the change request and hold its locks.`,
          "Use plain BEGIN and COMMIT.", { kind: body.kind });
      }
      return ok();
    case "VariableSetStmt":
      // SET, SET LOCAL and RESET change the session state that later steps run under.
      if (UNSAFE_SESSION_SETTINGS.has(body.name)) {
        return deny(step, "unsafe_session_setting", `Step ${step} sets ${body.name}, which changes how later statements resolve objects, which privileges they use, or whether triggers and foreign keys fire.`,
          "Remove the SET and schema-qualify object names.", { setting: body.name });
      }
      return ok({ step, action: "cfg.set_session", objects: [], setting: body.name });
    case "IndexStmt":
      // A new index on a table is in scope when its table is.
      return ok({
        step,
        action: body.concurrent ? "idx.create_concurrent" : "idx.create_blocking",
        objects: [qualify(body.relation.schemaname, body.relation.relname)],
      });
    case "SelectStmt":
      return classifySelect(stmt, body, step);
    case "AlterRoleSetStmt":
      return ok({ step, action: "cfg.set_role", objects: [`role:${body.role?.rolename}`], setting: body.setstmt?.name });
    case "DropStmt":
      if (body.removeType === "OBJECT_INDEX") {
        const indexes: string[] = body.objects.map(nameFromList);
        const tables = indexes.flatMap((i) => {
          const rel = snapshot.relations[i];
          return rel?.kind === "index" ? [rel.table] : [];
        });
        return ok({
          step,
          action: body.concurrent ? "idx.drop_concurrent" : "idx.drop_blocking",
          objects: [...new Set([...indexes, ...tables])],
        });
      }
      break;
    case "VacuumStmt": {
      const options = new Set((body.options ?? []).map((o: Node) => o.DefElem?.defname));
      if (options.has("full")) {
        return deny(step, "vacuum_full", `Step ${step} runs VACUUM FULL, which rewrites the table under ACCESS EXCLUSIVE.`,
          "Use plain VACUUM, or escalate if the table needs a rewrite.");
      }
      // VACUUM and ANALYZE share a node; with no relation list they cover the whole database.
      const rels: Node[] = body.rels ?? [];
      const objects = rels.length === 0
        ? [ALL_RELATIONS]
        : rels.map((r) => qualify(r.VacuumRelation.relation.schemaname, r.VacuumRelation.relation.relname));
      return ok({ step, action: "maint.vacuum_analyze", objects });
    }
    case "AlterTableStmt":
      if (body.objtype === "OBJECT_TABLE") return classifyAlterTable(body, step);
      break;
    case "UpdateStmt":
    case "DeleteStmt":
    case "InsertStmt":
      return ok({ step, action: "dml.bounded", objects: [qualify(body.relation.schemaname, body.relation.relname)] });
    case "DoStmt":
      return deny(step, "do_block", `Step ${step} is a DO block, whose statements the policy gate cannot see.`,
        "Write each statement as its own SQL step.");
    case "ExecuteStmt":
      return deny(step, "dynamic_sql", `Step ${step} executes a prepared statement whose text the policy gate cannot see.`,
        "Write the statement out in full as its own SQL step.");
    case "CreateFunctionStmt":
      return deny(step, "function_in_cr", `Step ${step} creates a function or procedure in the change request; its body is opaque to the policy gate.`,
        "Write the statements as SQL steps instead of wrapping them in a function.");
    case "ClusterStmt":
      return deny(step, "cluster", `Step ${step} runs CLUSTER, which rewrites the table under ACCESS EXCLUSIVE.`,
        "Escalate if the table needs a rewrite.");
    case "AlterSystemStmt":
      return deny(step, "alter_system", `Step ${step} runs ALTER SYSTEM in a SQL step, which bypasses the Actor's node ordering and restart handling.`,
        "Use a config step ({ config: { name, value }, node }) instead of ALTER SYSTEM.", { setting: body.setstmt?.name });
  }
  return deny(step, "unknown_statement", `Step ${step} is a ${type} statement, which is not in the policy gate's action vocabulary.`,
    "Use only statements the policy gate can classify, or escalate.", { statement: type });
}

const CONSTRAINT_TYPES: Record<string, ConstraintInfo["type"]> = {
  CONSTR_CHECK: "check", CONSTR_NOTNULL: "not_null", CONSTR_FOREIGN: "foreign_key",
  CONSTR_UNIQUE: "unique", CONSTR_PRIMARY: "primary_key", CONSTR_EXCLUSION: "exclusion",
};

// Functions whose value differs per row, so a column default that calls one rewrites the table.
const VOLATILE_DEFAULTS = new Set(["random", "gen_random_uuid", "uuidv4", "uuidv7", "clock_timestamp", "nextval", "timeofday"]);

// The column a constraint proves NOT NULL: NOT NULL col, or CHECK (col IS NOT NULL).
function notNullColumn(c: Node): string | undefined {
  if (c.contype === "CONSTR_NOTNULL" && c.keys?.length === 1) return c.keys[0].String?.sval;
  const test = c.contype === "CONSTR_CHECK" ? c.raw_expr?.NullTest : undefined;
  const fields = test?.nulltesttype === "IS_NOT_NULL" ? test.arg?.ColumnRef?.fields : undefined;
  return fields?.length === 1 ? fields[0].String?.sval : undefined;
}

// ALTER TABLE: one action per subcommand. A subcommand outside the vocabulary
// denies the whole statement.
function classifyAlterTable(body: Node, step: number): Classified {
  const target = qualify(body.relation.schemaname, body.relation.relname);
  const actions: ClassifiedAction[] = [];
  for (const { AlterTableCmd: cmd } of body.cmds as Node[]) {
    const base = { step, objects: [target] };
    switch (cmd.subtype) {
      case "AT_AddColumn": {
        const volatile = calledFunctions(cmd.def?.ColumnDef?.constraints).some((f) => VOLATILE_DEFAULTS.has(f));
        actions.push({ ...base, action: "ddl.add_column", column: cmd.def?.ColumnDef?.colname,
          lock: { ...LOCK_PROFILES["ddl.add_column"], rewrites: volatile, scans: volatile, relations: [target] } });
        continue;
      }
      case "AT_AddConstraint": {
        const c: Node = cmd.def.Constraint;
        const type = CONSTRAINT_TYPES[c.contype];
        if (!type) break;
        const notValid = c.skip_validation === true;
        const action = notValid ? "ddl.add_check_not_valid" : "ddl.add_constraint_validating";
        const constraint: ConstraintInfo = { name: c.conname, type, not_null_column: notNullColumn(c) };
        // A foreign key takes SHARE ROW EXCLUSIVE on both tables (PG 18 ALTER TABLE).
        const referenced = type === "foreign_key" ? qualify(c.pktable.schemaname, c.pktable.relname) : undefined;
        const lock: ActionLock = referenced
          ? { ...LOCK_PROFILES[action], mode: "ShareRowExclusiveLock", relations: [target, referenced] }
          : { ...LOCK_PROFILES[action], relations: [target] };
        actions.push({ ...base, objects: referenced ? [target, referenced] : [target], action, constraint, lock });
        continue;
      }
      case "AT_ValidateConstraint":
        actions.push({ ...base, action: "ddl.validate_constraint", constraint: { name: cmd.name } });
        continue;
      case "AT_SetNotNull":
        actions.push({ ...base, action: "ddl.set_not_null", column: cmd.name });
        continue;
      case "AT_AlterColumnType":
        actions.push({ ...base, action: "ddl.alter_column_type", column: cmd.name });
        continue;
    }
    return deny(step, "unknown_statement", `Step ${step} has an ALTER TABLE ${cmd.subtype} subcommand, which is not in the policy gate's action vocabulary.`,
      "Use only statements the policy gate can classify, or escalate.", { statement: "AlterTableStmt", subtype: cmd.subtype });
  }
  return ok(...actions);
}

const RELOAD_CONTEXTS = new Set(["sighup", "superuser", "user", "backend", "superuser-backend"]);

// Config steps classify without parsing. The Actor restarts each targeted node
// after a postmaster-context setting, so such a step implies node.restart per
// node; an omitted node means both nodes (ADR 0003).
function classifyConfig(
  s: Extract<PolicyStep, { config: unknown }>, step: number, snapshot: StateSnapshot,
): Classified {
  if (s.node !== undefined && !["primary", "standby", "both"].includes(s.node)) {
    return deny(step, "malformed_step", `Step ${step} targets node ${JSON.stringify(s.node)}, which is not primary, standby or both.`,
      "Set node to primary, standby or both, or omit it for both nodes.", { node: s.node });
  }
  const nodes: NodeName[] = s.node === "primary" || s.node === "standby" ? [s.node] : ["primary", "standby"];
  const setting = s.config.name;
  const context = snapshot.nodes[nodes[0]].settings[setting]?.context;
  if (context === "postmaster") {
    return ok(
      { step, action: "cfg.set_restart", objects: [], nodes, setting },
      ...nodes.map((n): ClassifiedAction => ({ step, action: "node.restart", objects: [], nodes: [n], setting })),
    );
  }
  if (context && RELOAD_CONTEXTS.has(context)) return ok({ step, action: "cfg.set_reload", objects: [], nodes, setting });
  if (context === undefined) {
    return deny(step, "unknown_setting", `Step ${step} sets ${setting}, which the state snapshot does not list.`,
      "Check the setting name against pg_settings.", { setting });
  }
  return deny(step, "unsettable_setting", `Step ${step} sets ${setting}, whose context (${context}) cannot be changed by a config step.`,
    "Remove the step; this setting cannot be changed on a running cluster.", { setting, context });
}

// Every action gets its lock behavior, transaction and session state, and its step's retry count.
function annotate(c: Classified, at: { txn: TxnInfo; session: SessionState }, retries: unknown): Classified {
  for (const a of c.actions) {
    a.lock ??= { ...LOCK_PROFILES[a.action], relations: a.objects.filter((o) => !o.startsWith("role:")) };
    a.txn = at.txn;
    a.session = at.session;
    if (typeof retries === "number") a.retries = retries;
  }
  return c;
}

export function classify(cr: PolicyChangeRequest, snapshot: StateSnapshot): Classification {
  const out: Classification = { actions: [], denials: [] };
  const add = (c: Classified) => {
    out.actions.push(...c.actions);
    out.denials.push(...c.denials);
  };
  const tracker = new TxnTracker();
  cr.steps.forEach((raw, step) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      add(deny(step, "malformed_step", `Step ${step} is not a step object.`, "Write each step as a SQL step or a config step.", { value: raw }));
      return;
    }
    const s = raw as PolicyStep;
    if ("sql" in s && typeof s.sql === "string") {
      const parsed = parseSql(s.sql);
      if (!parsed.ok) {
        add(deny(step, "parse_error", `Step ${step} does not parse as Postgres SQL: ${parsed.error}.`,
          "Fix the SQL syntax.", { error: parsed.error }));
        return;
      }
      tracker.beginStep(parsed.stmts.length);
      for (const { stmt } of parsed.stmts) {
        if (!stmt) continue;
        const at = tracker.statement(stmt as Node);
        const c = classifyStatement(stmt as Node, step, snapshot);
        add(at ? annotate(c, at, s.retries) : c);
      }
      tracker.endStep();
    } else if ("config" in s && typeof s.config?.name === "string") {
      add(annotate(classifyConfig(s, step, snapshot), tracker.config(), undefined));
    } else {
      add(deny(step, "unknown_statement", `Step ${step} is not a SQL step or a config step.`,
        "Use only SQL steps and config steps.", { statement: Object.keys(s as object)[0] }));
    }
  });
  return out;
}
