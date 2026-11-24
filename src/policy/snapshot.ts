import { z } from "zod";

// The state snapshot the policy rules read (issue #6). The collector
// (snapshot-collect.ts) runs the design pack's SQL on both nodes and validates
// the result against this schema; tests build small snapshots with
// snapshot-fixture.ts.
//
// Node-local state (settings, replication, sessions, locks, usage counters and
// query statistics) is kept per node, because a standby's settings and reads
// differ from the primary's. Catalog state (relations, constraints, role and
// database settings, CASCADE closures) is read from the primary: a physical
// standby has the same catalog.
//
// Every relation and index name is schema-qualified, e.g. "public.orders".

/** A timestamp with a UTC offset, as Postgres renders timestamptz in JSON. */
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
/** Seconds; null when there is nothing to measure (no open transaction, no lag). */
const seconds = z.number().nonnegative().nullable();
/** A schema-qualified relation name, e.g. "public.orders". Rules look relations up by it. */
const relationName = z.string().regex(/^[^.]+\..+$/, "Relation names must be schema-qualified, e.g. public.orders");

export const settingContexts = ["internal", "postmaster", "sighup", "superuser-backend", "backend", "superuser", "user"] as const;

/** One row of pg_settings on one node. */
const settingSchema = z.object({
  /** pg_settings.setting, in the setting's base unit (e.g. "4096" with unit "kB"). */
  value: z.string(),
  unit: z.string().nullable(),
  context: z.enum(settingContexts),
  vartype: z.enum(["bool", "integer", "real", "string", "enum"]),
  min_val: z.string().nullable(),
  max_val: z.string().nullable(),
  enumvals: z.array(z.string()).nullable(),
  source: z.string(),
  pending_restart: z.boolean(),
}).strict();

const replicationSchema = z.object({
  in_recovery: z.boolean(),
  /** pg_stat_replication: the standbys streaming from this node. */
  replicas: z.array(z.object({
    application_name: z.string(),
    client_addr: z.string().nullable(),
    state: z.string(),
    sync_state: z.string(),
    sync_priority: z.number().int(),
    replay_lag_s: seconds,
  }).strict()),
  /** pg_stat_wal_receiver; null on a node that is not receiving WAL. */
  wal_receiver: z.object({
    status: z.string(),
    sender_host: z.string().nullable(),
    sender_port: z.number().int().nullable(),
    slot_name: z.string().nullable(),
  }).strict().nullable(),
  slots: z.array(z.object({ slot_name: z.string(), slot_type: z.enum(["physical", "logical"]), active: z.boolean() }).strict()),
}).strict();

/** Client backends in pg_stat_activity. */
const sessionsSchema = z.object({
  client_backends: count,
  idle: count,
  idle_in_txn: count,
  oldest_xact_age_s: seconds,
}).strict();

export const lockModes = [
  "AccessShareLock", "RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock",
  "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock",
] as const;

/** A relation lock held or awaited by another backend, with its transaction's age. */
const lockSchema = z.object({
  relation: relationName,
  mode: z.enum(lockModes),
  granted: z.boolean(),
  pid: z.number().int(),
  xact_age_s: seconds,
}).strict();

/** Node-local, cumulative since the last stats reset; use scannedInWindow() for "used recently". */
const usageSchema = z.object({
  /** pg_stat_user_indexes, keyed by index. */
  indexes: z.record(relationName, z.object({
    table: relationName,
    idx_scan: count,
    last_idx_scan: timestamp.nullable(),
  }).strict()),
  /** pg_stat_user_tables, keyed by table. */
  tables: z.record(relationName, z.object({
    seq_scan: count,
    last_seq_scan: timestamp.nullable(),
    idx_scan: count.nullable(),
    last_idx_scan: timestamp.nullable(),
    n_live_tup: count,
    n_dead_tup: count,
  }).strict()),
}).strict();

/** One pg_stat_statements entry for the target database on one node. */
const queryStatSchema = z.object({
  /** Text, because an int8 query ID does not fit a JSON number. */
  queryid: z.string(),
  query: z.string(),
  calls: count,
  mean_exec_time_ms: z.number().nonnegative(),
  rows: count,
}).strict();

const nodeSnapshotSchema = z.object({
  collected_at: timestamp,
  server_version_num: z.number().int(),
  /** pg_settings, keyed by setting name. */
  settings: z.record(z.string(), settingSchema),
  replication: replicationSchema,
  sessions: sessionsSchema,
  locks: z.array(lockSchema),
  usage: usageSchema,
  /** null when pg_stat_statements is not installed and preloaded on this node. */
  query_stats: z.array(queryStatSchema).nullable(),
}).strict();

const indexRelationSchema = z.object({
  kind: z.literal("index"),
  /** The table the index belongs to. */
  table: relationName,
  total_bytes: count,
  valid: z.boolean(),
  primary: z.boolean(),
  unique: z.boolean(),
  /** True when the index is the table's replica identity. */
  replica_identity: z.boolean(),
}).strict();

const tableRelationSchema = z.object({
  kind: z.enum(["table", "partitioned_table", "matview", "view", "sequence", "foreign_table", "other"]),
  /** pg_total_relation_size: heap, TOAST and indexes. 0 for a partitioned parent. */
  total_bytes: count,
  /** Planner estimate; -1 when the table was never analyzed. */
  reltuples: z.number(),
  persistence: z.enum(["permanent", "unlogged", "temporary"]),
  /** e.g. ["fillfactor=90", "autovacuum_enabled=off"]. */
  reloptions: z.array(z.string()),
  replica_identity: z.enum(["default", "nothing", "full", "index"]),
}).strict();

const relationSchema = z.discriminatedUnion("kind", [indexRelationSchema, tableRelationSchema]);

export const constraintTypes = ["primary_key", "unique", "foreign_key", "check", "not_null", "exclusion", "trigger"] as const;

const constraintSchema = z.object({
  name: z.string(),
  type: z.enum(constraintTypes),
  /** False for a NOT VALID constraint not yet validated. */
  validated: z.boolean(),
  table: relationName,
  /** The index that backs the constraint, if any. */
  index: relationName.nullable(),
  /** A foreign key's referenced table; null for every other constraint type. */
  references: relationName.nullable(),
  definition: z.string(),
}).strict();

/** What DROP ... CASCADE of one target reaches (an over-approximation; see cascade_closure.sql). */
const cascadeClosureSchema = z.object({
  refclass: z.enum(["pg_class", "pg_type"]),
  /** pg_identify_object type and identity, e.g. { object_type: "view", identity: "public.v" }. */
  reaches: z.array(z.object({ object_type: z.string(), identity: z.string() }).strict()),
}).strict();

export const stateSnapshotSchema = z.object({
  /** The snapshot time: when collection started on the primary. */
  collected_at: timestamp,
  /** Start of the usage window W; a scan at or after it counts as use within W. */
  usage_window_start: timestamp,
  database: z.string(),
  nodes: z.object({ primary: nodeSnapshotSchema, standby: nodeSnapshotSchema }).strict(),
  /** Tables, indexes and other relations, keyed by name; read from the primary. */
  relations: z.record(relationName, relationSchema),
  constraints: z.array(constraintSchema),
  /** pg_db_role_setting: per-role and per-database settings, as "name=value". */
  role_db_settings: z.array(z.object({
    role: z.string().nullable(),
    database: z.string().nullable(),
    settings: z.array(z.string()),
  }).strict()),
  /** CASCADE closures, keyed by each drop target the change request names. */
  cascade: z.record(z.string(), cascadeClosureSchema),
}).strict().superRefine((s, ctx) => {
  // Rules follow these references, so a dangling one is a collection error.
  for (const [name, rel] of Object.entries(s.relations)) {
    if (rel.kind === "index" && (s.relations[rel.table] === undefined || s.relations[rel.table].kind === "index")) {
      ctx.addIssue({ code: "custom", path: ["relations", name, "table"], message: `Index ${name} belongs to ${rel.table}, which is not a listed table` });
    }
  }
  s.constraints.forEach((c, i) => {
    if (c.index !== null && s.relations[c.index]?.kind !== "index") {
      ctx.addIssue({ code: "custom", path: ["constraints", i, "index"], message: `Constraint ${c.name} is backed by ${c.index}, which is not a listed index` });
    }
    if ((c.type === "foreign_key") !== (c.references !== null)) {
      ctx.addIssue({ code: "custom", path: ["constraints", i, "references"], message: `Constraint ${c.name}: only a foreign key, and every foreign key, names a referenced table` });
    }
  });
  if (Date.parse(s.usage_window_start) > Date.parse(s.collected_at)) {
    ctx.addIssue({ code: "custom", path: ["usage_window_start"], message: "The usage window starts after the snapshot time" });
  }
});

export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;
export type NodeSnapshot = z.infer<typeof nodeSnapshotSchema>;
export type Setting = z.infer<typeof settingSchema>;
export type Relation = z.infer<typeof relationSchema>;
export type IndexRelation = z.infer<typeof indexRelationSchema>;
export type TableRelation = z.infer<typeof tableRelationSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type Lock = z.infer<typeof lockSchema>;
export type QueryStat = z.infer<typeof queryStatSchema>;
export type CascadeClosure = z.infer<typeof cascadeClosureSchema>;

/**
 * Whether a last-scan time (last_idx_scan or last_seq_scan, from any node)
 * falls inside the usage window W: at or after usage_window_start. Counters are
 * cumulative since a stats reset, so a nonzero idx_scan alone does not say.
 */
export function scannedInWindow(snapshot: Pick<StateSnapshot, "usage_window_start">, lastScan: string | null): boolean {
  return lastScan !== null && Date.parse(lastScan) >= Date.parse(snapshot.usage_window_start);
}
