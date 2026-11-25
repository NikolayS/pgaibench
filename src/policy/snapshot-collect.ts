import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient } from "../schema/types";
import type { PolicyChangeRequest } from "./classify";
import { loadParser, parseSql } from "./parse";
import { stateSnapshotSchema, type StateSnapshot } from "./snapshot";

// The snapshot collector (issue #6). It runs the design pack's SQL on both
// nodes, plus the CASCADE closure query on the primary for each drop target in
// the change request, and returns one validated state snapshot. Read-only.
// Connections come from the caller, e.g. createClient() in src/telemetry/collect.ts.

const SQL_DIR = join(import.meta.dir, "..", "..", "docs", "policy-gate", "sql");
const sqlFile = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

// cascade_closure.sql is written for psql variables; we bind them as parameters.
const CASCADE_SQL = () => sqlFile("cascade_closure.sql").replaceAll(":'refclass'", "$1::text").replaceAll(":'target'", "$2::text");
const PGSS_INSTALLED_SQL = "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed";

export type NodeConnections = { primary: SqlClient; standby: SqlClient };

export type CollectOptions = {
  /** Start of the usage window W, e.g. when the workload started. */
  usageWindowStart: Date;
};

type Raw = Record<string, any>;
type NodeName = "primary" | "standby";

const RELKIND: Record<string, string> = { r: "table", p: "partitioned_table", m: "matview", v: "view", S: "sequence", f: "foreign_table" };
const PERSISTENCE: Record<string, string> = { p: "permanent", u: "unlogged", t: "temporary" };
const REPLICA_IDENTITY: Record<string, string> = { d: "default", n: "nothing", f: "full", i: "index" };
const CONSTRAINT_TYPE: Record<string, string> = { p: "primary_key", u: "unique", f: "foreign_key", c: "check", n: "not_null", x: "exclusion", t: "trigger" };

// Unknown codes pass through unmapped, so the schema rejects them by name.
const code = (map: Record<string, string>, value: string) => map[value] ?? value;

async function pgssRows(client: SqlClient, settings: Record<string, { value: string }>): Promise<unknown[] | null> {
  // The view errors on a node that does not preload the library.
  const preloaded = (settings.shared_preload_libraries?.value ?? "").split(",").map((l) => l.trim()).includes("pg_stat_statements");
  if (!preloaded) return null;
  const [{ installed }] = await client.unsafe(PGSS_INSTALLED_SQL);
  if (!installed) return null;
  const [{ pgss }] = await client.unsafe(sqlFile("snapshot_pgss.sql"));
  return pgss as unknown[];
}

async function collectNode(client: SqlClient, role: NodeName) {
  const [{ snapshot: raw }] = (await client.unsafe(sqlFile("snapshot.sql"))) as [{ snapshot: Raw }];
  if (raw.in_recovery !== (role === "standby")) {
    throw new Error(`The ${role} connection reaches a node with in_recovery = ${raw.in_recovery}`);
  }
  const settings = Object.fromEntries((raw.settings as Raw[]).map(({ name, setting, ...rest }) => [name, { value: setting, ...rest }]));
  return {
    raw,
    node: {
      collected_at: raw.collected_at,
      server_version_num: raw.server_version_num,
      settings,
      replication: { in_recovery: raw.in_recovery, replicas: raw.replicas, wal_receiver: raw.wal_receiver, slots: raw.slots },
      sessions: raw.sessions,
      locks: raw.locks,
      usage: {
        indexes: Object.fromEntries((raw.index_usage as Raw[]).map(({ index, ...rest }) => [index, rest])),
        tables: Object.fromEntries((raw.table_usage as Raw[]).map(({ table, ...rest }) => [table, rest])),
      },
      query_stats: await pgssRows(client, settings),
    },
  };
}

// Catalog state comes from the primary; a physical standby has the same catalog.
function relations(raw: Raw) {
  const out: Record<string, unknown> = {};
  for (const r of raw.relations as Raw[]) {
    out[r.name] = {
      kind: code(RELKIND, r.kind), total_bytes: r.total_bytes, reltuples: r.reltuples,
      persistence: code(PERSISTENCE, r.persistence), reloptions: r.reloptions ?? [],
      replica_identity: code(REPLICA_IDENTITY, r.replica_identity),
    };
  }
  for (const i of raw.indexes as Raw[]) {
    out[i.index] = {
      kind: "index", table: i.table, total_bytes: i.total_bytes, valid: i.valid,
      primary: i.primary, unique: i.unique, replica_identity: i.replident,
    };
  }
  return out;
}

type DropTarget = { refclass: "pg_class" | "pg_type"; target: string };

const PG_CLASS_DROPS = new Set(["OBJECT_TABLE", "OBJECT_INDEX", "OBJECT_VIEW", "OBJECT_MATVIEW", "OBJECT_SEQUENCE", "OBJECT_FOREIGN_TABLE"]);
const PG_TYPE_DROPS = new Set(["OBJECT_TYPE", "OBJECT_DOMAIN"]);

const qualifiedName = (parts: string[]) => (parts.length === 1 ? `public.${parts[0]}` : parts.join("."));

/** Every object a DROP in the change request names, whether or not it says CASCADE. */
function dropTargets(cr: PolicyChangeRequest): DropTarget[] {
  const out = new Map<string, DropTarget>();
  for (const step of cr.steps) {
    const sql = (step as { sql?: unknown } | null)?.sql;
    if (typeof sql !== "string") continue;
    const parsed = parseSql(sql);
    if (!parsed.ok) continue;
    for (const { stmt } of parsed.stmts) {
      const drop = (stmt as Raw | undefined)?.DropStmt;
      if (!drop) continue;
      const refclass = PG_CLASS_DROPS.has(drop.removeType) ? "pg_class" : PG_TYPE_DROPS.has(drop.removeType) ? "pg_type" : undefined;
      if (!refclass) continue;
      for (const obj of drop.objects as Raw[]) {
        const items: Raw[] = obj.List?.items ?? obj.TypeName?.names ?? [];
        const target = qualifiedName(items.map((i) => i.String?.sval as string));
        out.set(target, { refclass, target });
      }
    }
  }
  return [...out.values()];
}

/**
 * Collect a validated state snapshot from both nodes. The change request names
 * the drop targets whose CASCADE closures the snapshot carries.
 */
export async function collectSnapshot(
  connections: NodeConnections, cr: PolicyChangeRequest, options: CollectOptions,
): Promise<StateSnapshot> {
  await loadParser();
  const [primary, standby] = await Promise.all([
    collectNode(connections.primary, "primary"),
    collectNode(connections.standby, "standby"),
  ]);
  const cascade: Record<string, unknown> = {};
  const cascadeSql = CASCADE_SQL();
  for (const { refclass, target } of dropTargets(cr)) {
    const reaches = await connections.primary.unsafe(cascadeSql, [refclass, target]);
    cascade[target] = { refclass, reaches: reaches.map((r) => ({ object_type: r.object_type, identity: r.identity })) };
  }
  return stateSnapshotSchema.parse({
    collected_at: primary.raw.collected_at,
    usage_window_start: options.usageWindowStart.toISOString(),
    database: primary.raw.database,
    nodes: { primary: primary.node, standby: standby.node },
    relations: relations(primary.raw),
    constraints: (primary.raw.constraints as Raw[]).map((c) => ({ ...c, type: code(CONSTRAINT_TYPE, c.type) })),
    role_db_settings: (primary.raw.role_db_settings as Raw[]).map((r) => ({ ...r, settings: r.settings ?? [] })),
    cascade,
  });
}
