import { constValue, type Node } from "./ast";
import { deny, ok, type StatementClassifier } from "./types";

// Transaction control, session settings and per-role or per-database settings.

const UNSAFE_SESSION_SETTINGS = new Set(["search_path", "role", "session_authorization", "session_replication_role"]);

const PREPARED_TRANSACTION_KINDS = new Set(["TRANS_STMT_PREPARE", "TRANS_STMT_COMMIT_PREPARED", "TRANS_STMT_ROLLBACK_PREPARED"]);

const SESSION_KILLS = new Set(["pg_terminate_backend", "pg_cancel_backend"]);

// The first session-kill function called anywhere in a parse tree, if any.
export function findSessionKill(node: unknown): string | undefined {
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

export const SESSION_STATEMENTS: Record<string, StatementClassifier> = {
  TransactionStmt: ({ body, step }) => {
    // Transaction boundaries and savepoints are not actions. A prepared
    // transaction outlives the change request, holding its locks.
    if (PREPARED_TRANSACTION_KINDS.has(body.kind)) {
      return deny(step, "prepared_transaction", `Step ${step} uses a prepared (two-phase) transaction, which can outlive the change request and hold its locks.`,
        "Use plain BEGIN and COMMIT.", { kind: body.kind });
    }
    return ok();
  },
  VariableSetStmt: ({ body, step }) => {
    // SET, SET LOCAL and RESET change the session state that later steps run under.
    if (UNSAFE_SESSION_SETTINGS.has(body.name)) {
      return deny(step, "unsafe_session_setting", `Step ${step} sets ${body.name}, which changes how later statements resolve objects, which privileges they use, or whether triggers and foreign keys fire.`,
        "Remove the SET and schema-qualify object names.", { setting: body.name });
    }
    return ok({ step, action: "cfg.set_session", objects: [], setting: body.name });
  },
  // ALTER ROLE ALL has no role and reaches every role.
  AlterRoleSetStmt: ({ body, step }) => ok({
    step, action: "cfg.set_role", objects: [`role:${body.role ? body.role.rolename : "*"}`], setting: body.setstmt?.name,
    ...(body.setstmt?.kind === "VAR_SET_VALUE" ? { value: (body.setstmt.args ?? []).map(constValue).join(", ") } : {}),
  }),
  AlterDatabaseSetStmt: ({ body, step }) => ok({
    step, action: "cfg.set_role", objects: [`database:${body.dbname}`], setting: body.setstmt?.name,
    ...(body.setstmt?.kind === "VAR_SET_VALUE" ? { value: (body.setstmt.args ?? []).map(constValue).join(", ") } : {}),
  }),
};
