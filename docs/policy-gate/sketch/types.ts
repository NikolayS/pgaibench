// SKETCH ONLY — not wired to the harness. Session 1 must map these onto the
// harness's real change-request and telemetry types in src/ and adapt or discard.

export type NodeRole = "primary" | "standby";

export type ActionKind =
  | "cfg.set_reload" | "cfg.set_restart" | "cfg.set_role" | "cfg.set_session"
  | "node.reload" | "node.restart"
  | "ddl.add_column" | "ddl.add_check_not_valid" | "ddl.validate_constraint"
  | "ddl.add_constraint_validating" | "ddl.set_not_null" | "ddl.alter_column_type"
  | "ddl.drop_column" | "ddl.set_reloption"
  | "idx.create_concurrent" | "idx.create_blocking"
  | "idx.drop_concurrent" | "idx.drop_blocking"
  | "obj.create" | "obj.drop" | "obj.truncate"
  | "ext.create" | "maint.vacuum_analyze" | "dml.bounded";

export type LockMode =
  | "AccessShare" | "RowShare" | "RowExclusive" | "ShareUpdateExclusive"
  | "Share" | "ShareRowExclusive" | "Exclusive" | "AccessExclusive";

export interface ClassifiedStep {
  index: number;               // position in the CR
  node: string;                // target node label
  txn: number | null;          // transaction group id; null = autocommit / outside txn
  sql?: string;                // absent for config steps and implied node.restart
  action: ActionKind;
  objects: string[];           // qualified names touched or created
  lock?: { relation: string; mode: LockMode; scans: boolean; rewrites: boolean };
  setting?: { name: string; value: string; scope: "cluster" | "role" | "database" | "session" };
  cascade?: boolean;
  expectedRows?: number;       // dml.bounded, declared by the Analyst
}

export interface Denied { index: number; sql: string; reason: "unknown_statement" | "do_block" | "dynamic_sql" | "function_in_cr" | "denylisted"; }

export interface TicketScope {
  allowedObjects: string[];
  allowedRoles?: string[];
  forbiddenActions: ActionKind[];
  maxRows?: number;
  clusterScope: boolean;
  downtimeAllowed: string[];   // node labels
}

export interface NodeSnapshot {
  label: string;
  role: NodeRole;
  snapshot: unknown;           // shape = sql/snapshot.sql output
  pgss: unknown[];             // shape = sql/snapshot_pgss.sql output
}

export interface GateInput {
  steps: ClassifiedStep[];
  denied: Denied[];
  scope: TicketScope;
  nodes: NodeSnapshot[];
  usageWindow: { before: NodeSnapshot[]; after: NodeSnapshot[] } | null;
  thresholds: Record<string, string | number>;
}

export type Verdict = "pass" | "reject" | "defer" | "escalate";

export interface RuleResult {
  rule: string;                // e.g. "L-4"
  verdict: Exclude<Verdict, "pass">;
  stepIndex?: number;
  reason: string;
  fixHint?: string;
}

export interface GateResult {
  verdict: Verdict;            // worst of results: escalate > reject > defer > pass (decide ordering)
  results: RuleResult[];
}
