import { LOCK_PROFILES, TxnTracker, type SessionState, type TxnInfo } from "../locks";
import { mergeDisjoint } from "../merge-disjoint";
import { parseSql } from "../parse";
import type { StateSnapshot } from "../snapshot";
import { ALTER_TABLE_STATEMENTS, markNotNullProofs } from "./alter-table";
import type { Node } from "./ast";
import { classifyConfig } from "./config";
import { DENIED_STATEMENTS } from "./denied";
import { DO_STATEMENTS, plainDoBody } from "./do-block";
import { LOCK_STATEMENTS } from "./lock-table";
import { PRIVILEGE_STATEMENTS } from "./privileges";
import { DML_STATEMENT_CLASSIFIERS, DML_STATEMENTS } from "./dml";
import { OBJECT_STATEMENTS } from "./objects";
import { SELECT_STATEMENTS } from "./select";
import { findSessionKill, SESSION_STATEMENTS } from "./session";
import { deny, type Classification, type Classified, type ClassifiedAction, type Denial, type PolicyChangeRequest, type PolicyStep, type StatementClassifier } from "./types";

export type {
  ActionOf, Classification, ClassifiedAction, ConstraintInfo, Denial, DenyCode, PolicyChangeRequest, PolicyStep,
} from "./types";

// Statement classifiers by parse-tree node type, one table per statement
// family. A statement type in two families is an error, not an override; a
// type in no table is outside the vocabulary and is denied.
const STATEMENTS: Record<string, StatementClassifier> = mergeDisjoint("statement type",
  SESSION_STATEMENTS, SELECT_STATEMENTS, DML_STATEMENT_CLASSIFIERS, OBJECT_STATEMENTS, ALTER_TABLE_STATEMENTS, DENIED_STATEMENTS, DO_STATEMENTS, LOCK_STATEMENTS, PRIVILEGE_STATEMENTS);

function classifyStatement(stmt: Node, step: number, snapshot: StateSnapshot): Classified {
  const [type] = Object.keys(stmt);
  const body = stmt[type];
  const kill = findSessionKill(stmt);
  if (kill) {
    return deny(step, "session_kill", `Step ${step} calls ${kill}; a human decides on session kills.`,
      "Escalate to a human instead of ending sessions in the change request.", { function: kill }, "escalate");
  }
  const classified = Object.hasOwn(STATEMENTS, type) ? STATEMENTS[type]({ stmt, type, body, step, snapshot }) : undefined;
  return classified ?? deny(step, "unknown_statement", `Step ${step} is a ${type} statement, which is not in the policy gate's action vocabulary.`,
    "Use only statements the policy gate can classify, or escalate.", { statement: type });
}

type Annotated = { actions: ClassifiedAction[]; denials: Denial[] };

// Every action gets its lock behavior (the kind's default profile unless the
// classifier set one), transaction and session state, and its step's retry count.
function annotate(c: Classified, at: { txn: TxnInfo; session: SessionState }, retries: unknown): Annotated {
  return {
    actions: c.actions.map((a) => ({
      ...a,
      lock: a.lock ?? { ...LOCK_PROFILES[a.action], relations: a.objects.filter((o) => !o.startsWith("role:")) },
      txn: at.txn,
      session: at.session,
      ...(typeof retries === "number" ? { retries } : {}),
    }) as ClassifiedAction),
    denials: c.denials,
  };
}

// Postgres rejects LOCK TABLE outside a transaction block, so the gate denies
// it there rather than approve a step that cannot run.
function lockInTxn(c: Annotated): Annotated {
  const outside = c.actions.filter((a) => a.action === "lock.table" && a.txn.block === "none");
  if (outside.length === 0) return c;
  return {
    actions: c.actions.filter((a) => !outside.includes(a)),
    denials: [...c.denials, ...outside.map((a) => deny(a.step, "lock_outside_txn",
      `Step ${a.step} runs LOCK TABLE outside a transaction, which Postgres rejects: the lock would end with the statement.`,
      "Put the LOCK TABLE and the statements it protects in one transaction: BEGIN ... COMMIT, one multi-statement step, or a DO block.",
      { relations: a.lock.relations }).denials[0])],
  };
}

// A statement that runs outside any transaction state (BEGIN, COMMIT and the
// like) is never an action, so it can only be denied or produce nothing.
function unannotated(c: Classified, step: number): Annotated {
  if (c.actions.length > 0) throw new Error(`step ${step}: a transaction-control statement produced actions`);
  return { actions: [], denials: c.denials };
}

export function classify(cr: PolicyChangeRequest, snapshot: StateSnapshot): Classification {
  const out: Classification = { actions: [], denials: [] };
  const add = (c: Annotated, expected: { expected_rows?: number } = {}) => {
    out.actions.push(...c.actions.map((a) => (a.action === "dml.bounded" ? { ...a, ...expected } : a)));
    out.denials.push(...c.denials);
  };
  const tracker = new TxnTracker();
  cr.steps.forEach((raw, step) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      add(unannotated(deny(step, "malformed_step", `Step ${step} is not a step object.`, "Write each step as a SQL step or a config step.", { value: raw }), step));
      return;
    }
    const s = raw as PolicyStep;
    if ("sql" in s && typeof s.sql === "string") {
      const parsed = parseSql(s.sql);
      if (!parsed.ok) {
        add(unannotated(deny(step, "parse_error", `Step ${step} does not parse as Postgres SQL: ${parsed.error}.`,
          "Fix the SQL syntax.", { error: parsed.error }), step));
        return;
      }
      // A DO block with a plain body runs its statements in order, in one
      // transaction, so it is classified as those statements (ADR 0005).
      let inDoBlock = false;
      const expand = (st: Node): Node[] => {
        if (!st.DoStmt) return [st];
        const b = plainDoBody(st.DoStmt);
        if (b.plain) inDoBlock = true;
        return b.plain ? b.statements.flatMap(expand) : [st];
      };
      const stmts = parsed.stmts.flatMap(({ stmt }) => (stmt ? expand(stmt as Node) : []));
      const isDml = (st: Node) => DML_STATEMENTS.has(Object.keys(st)[0]);
      // A step's expected_rows bounds its DML only when there is exactly one DML statement to bound.
      const expected = stmts.filter(isDml).length === 1 && typeof s.expected_rows === "number"
        ? { expected_rows: s.expected_rows } : {};
      tracker.beginStep(stmts.length, inDoBlock);
      for (const stmt of stmts) {
        const at = tracker.statement(stmt);
        const c = classifyStatement(stmt, step, snapshot);
        add(lockInTxn(at ? annotate(c, at, s.retries) : unannotated(c, step)), isDml(stmt) ? expected : {});
      }
      tracker.endStep();
    } else if ("config" in s && typeof s.config?.name === "string") {
      add(annotate(classifyConfig(s, step, snapshot), tracker.config(), undefined));
    } else {
      add(unannotated(deny(step, "unknown_statement", `Step ${step} is not a SQL step or a config step.`,
        "Use only SQL steps and config steps.", { statement: Object.keys(s as object)[0] }), step));
    }
  });
  return { ...out, actions: markNotNullProofs(out.actions, snapshot) };
}
