import { deny, type StatementClassifier } from "./types";

// Statements the policy gate always denies: their effect is hidden from it
// (EXECUTE, a function body; DO blocks are in do-block.ts), they rewrite a table under ACCESS EXCLUSIVE
// (CLUSTER), or they bypass the Actor (ALTER SYSTEM).

export const DENIED_STATEMENTS: Record<string, StatementClassifier> = {
  ExecuteStmt: ({ step }) => deny(step, "dynamic_sql", `Step ${step} executes a prepared statement whose text the policy gate cannot see.`,
    "Write the statement out in full as its own SQL step."),
  CreateFunctionStmt: ({ step }) => deny(step, "function_in_cr", `Step ${step} creates a function or procedure in the change request; its body is opaque to the policy gate.`,
    "Write the statements as SQL steps instead of wrapping them in a function."),
  ClusterStmt: ({ step }) => deny(step, "cluster", `Step ${step} runs CLUSTER, which rewrites the table under ACCESS EXCLUSIVE.`,
    "Escalate if the table needs a rewrite."),
  AlterSystemStmt: ({ body, step }) => deny(step, "alter_system", `Step ${step} runs ALTER SYSTEM in a SQL step, which bypasses the Actor's node ordering and restart handling.`,
    "Use a config step ({ config: { name, value }, node }) instead of ALTER SYSTEM.", { setting: body.setstmt?.name }),
};
