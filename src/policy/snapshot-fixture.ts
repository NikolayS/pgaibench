import {
  stateSnapshotSchema, type Constraint, type IndexRelation, type NodeSnapshot, type QueryStat, type Relation,
  type Setting, type StateSnapshot, type TableRelation,
} from "./snapshot";

// Small, valid state snapshots for policy review tests. Start from a healthy
// two-node cluster with no load, then add only the state a test is about:
//
//   snapshotFixture({
//     settings: { shared_buffers: setting("128MB", "postmaster") },   // both nodes
//     relations: { "public.orders": table({ total_bytes: 2 * GiB }), "public.orders_idx": index("public.orders") },
//     standby: { usage: { indexes: { "public.orders_idx": indexUsage("public.orders", FIXTURE_TIME) } } },
//   })
//
// The result is validated, so a fixture that is not a valid snapshot throws.

/** The default snapshot time; the default usage window is the 30 minutes before it. */
export const FIXTURE_TIME = "2026-11-23T10:00:00.000+00:00";
export const FIXTURE_WINDOW_START = "2026-11-23T09:30:00.000+00:00";
export const GiB = 1024 ** 3;

export const setting = (value: string, context: Setting["context"], extra: Partial<Setting> = {}): Setting => ({
  value, unit: null, context, vartype: "string", min_val: null, max_val: null, enumvals: null,
  source: "default", pending_restart: false, ...extra,
});

export const table = (extra: Partial<TableRelation> = {}): TableRelation => ({
  kind: "table", total_bytes: 8192, reltuples: 0, persistence: "permanent", reloptions: [], replica_identity: "default", ...extra,
});

export const index = (tableName: string, extra: Partial<Omit<IndexRelation, "kind" | "table">> = {}): IndexRelation => ({
  kind: "index", table: tableName, total_bytes: 8192, valid: true, primary: false, unique: false, replica_identity: false, ...extra,
});

export const constraint = (name: string, tableName: string, type: Constraint["type"], extra: Partial<Constraint> = {}): Constraint => ({
  name, type, validated: true, table: tableName, index: null, definition: "", ...extra,
});

/** pg_stat_user_indexes for one index on one node; lastScan null means never scanned. */
export const indexUsage = (tableName: string, lastScan: string | null, idxScan = lastScan === null ? 0 : 1) => ({
  table: tableName, idx_scan: idxScan, last_idx_scan: lastScan,
});

export const queryStat = (query: string, extra: Partial<QueryStat> = {}): QueryStat => ({
  queryid: "1", query, calls: 1, mean_exec_time_ms: 1, rows: 1, ...extra,
});

type NodeOverrides = {
  settings?: Record<string, Setting>;
  replication?: Partial<NodeSnapshot["replication"]>;
  sessions?: Partial<NodeSnapshot["sessions"]>;
  locks?: NodeSnapshot["locks"];
  usage?: Partial<NodeSnapshot["usage"]>;
  query_stats?: NodeSnapshot["query_stats"];
  server_version_num?: number;
};

export type SnapshotFixture = {
  collected_at?: string;
  usage_window_start?: string;
  /** Settings on both nodes. */
  settings?: Record<string, Setting>;
  primary?: NodeOverrides;
  standby?: NodeOverrides;
  relations?: Record<string, Relation>;
  constraints?: Constraint[];
  role_db_settings?: StateSnapshot["role_db_settings"];
  cascade?: StateSnapshot["cascade"];
};

function node(role: "primary" | "standby", collectedAt: string, shared: Record<string, Setting>, o: NodeOverrides = {}): NodeSnapshot {
  const standby = role === "standby";
  return {
    collected_at: collectedAt,
    server_version_num: o.server_version_num ?? 180001,
    settings: { ...shared, ...o.settings },
    replication: {
      in_recovery: standby,
      replicas: standby ? [] : [{ application_name: "standby", client_addr: "10.0.0.3", state: "streaming", sync_state: "async", sync_priority: 0, replay_lag_s: 0 }],
      wal_receiver: standby ? { status: "streaming", sender_host: "10.0.0.2", sender_port: 5432, slot_name: "standby" } : null,
      slots: standby ? [] : [{ slot_name: "standby", slot_type: "physical", active: true }],
      ...o.replication,
    },
    sessions: { client_backends: 0, idle: 0, idle_in_txn: 0, oldest_xact_age_s: null, ...o.sessions },
    locks: o.locks ?? [],
    usage: { indexes: {}, tables: {}, ...o.usage },
    query_stats: o.query_stats === undefined ? [] : o.query_stats,
  };
}

export function snapshotFixture(f: SnapshotFixture = {}): StateSnapshot {
  const collectedAt = f.collected_at ?? FIXTURE_TIME;
  const shared = f.settings ?? {};
  return stateSnapshotSchema.parse({
    collected_at: collectedAt,
    usage_window_start: f.usage_window_start ?? FIXTURE_WINDOW_START,
    database: "pgaibench",
    nodes: { primary: node("primary", collectedAt, shared, f.primary), standby: node("standby", collectedAt, shared, f.standby) },
    relations: f.relations ?? {},
    constraints: f.constraints ?? [],
    role_db_settings: f.role_db_settings ?? [],
    cascade: f.cascade ?? {},
  });
}
