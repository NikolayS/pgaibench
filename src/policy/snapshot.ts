import { z } from "zod";

// Minimal state snapshot for the tracer (issue #3): settings with their context
// per node, and the relations the classifier needs to resolve names. The full
// two-node snapshot (issue #6) replaces this.
const settingSchema = z.object({
  value: z.string(),
  /** pg_settings.context: internal, postmaster, sighup, superuser-backend, backend, superuser or user. */
  context: z.string(),
}).strict();

const nodeSnapshotSchema = z.object({
  settings: z.record(z.string(), settingSchema),
}).strict();

const relationSchema = z.object({
  kind: z.enum(["table", "index", "view", "matview", "sequence", "other"]),
  /** For an index, the schema-qualified table it belongs to. */
  table: z.string().optional(),
}).strict();

export const stateSnapshotSchema = z.object({
  nodes: z.object({ primary: nodeSnapshotSchema, standby: nodeSnapshotSchema }).strict(),
  /** Keyed by schema-qualified name, e.g. "public.orders". */
  relations: z.record(z.string(), relationSchema),
}).strict();

export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;
