import { z } from "zod";

// The closed action vocabulary (docs/policy-gate/spec/02-action-vocabulary.md).
// Every statement classifies into exactly one of these or is denied by default.
// node.restart is never written as a step: it is implied by a config step on a
// postmaster-context setting, once per node the step targets (ADR 0003).
export const ACTION_KINDS = [
  "cfg.set_reload", "cfg.set_restart", "cfg.set_role", "cfg.set_session",
  "node.reload", "node.restart",
  "ddl.add_column", "ddl.add_check_not_valid", "ddl.validate_constraint",
  "ddl.add_constraint_validating", "ddl.set_not_null", "ddl.alter_column_type",
  "ddl.drop_column", "ddl.set_reloption",
  "idx.create_concurrent", "idx.create_blocking",
  "idx.drop_concurrent", "idx.drop_blocking",
  "obj.create", "obj.drop", "obj.truncate",
  "ext.create", "maint.vacuum_analyze", "dml.bounded",
  "query.read",
] as const;

export const actionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof actionKindSchema>;

export type NodeName = "primary" | "standby";
