import { calledFunctions, functionName, hasNode, READ_ONLY_FUNCTIONS, type Node } from "./ast";
import { deny, ok, type Classified, type StatementClassifier } from "./types";

// SELECT: a read, a reload, or denied.

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

export const SELECT_STATEMENTS: Record<string, StatementClassifier> = {
  SelectStmt: ({ stmt, body, step }) => classifySelect(stmt, body, step),
};
