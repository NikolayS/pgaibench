import { describe, expect, test } from "bun:test";
import type { Row, SqlClient } from "../schema/types";
import { collectSnapshot } from "./snapshot-collect";

// The collector's one entry point, against fake connections that answer with
// rows in the shape the design pack's SQL emits; no database here. The SQL
// itself runs against Postgres in the opt-in smoke test (snapshot.smoke.ts,
// #21) and in the baseline capture (#7).

type Call = { query: string; params?: unknown[] };

// Postgres renders oid::regclass::text without the schema for any relation on
// search_path, so SQL that names relations that way gets "orders", not
// "public.orders". The fake answers as Postgres would for the SQL it is sent.
const asPostgresRenders = (query: string, raw: Record<string, unknown>) =>
  /::regclass::text/.test(query) ? JSON.parse(JSON.stringify(raw).replaceAll('"public.', '"')) : raw;

function fakeNode(raw: Record<string, unknown>, opts: { pgss?: boolean; pgssRows?: unknown[]; cascade?: Record<string, Row[]> } = {}) {
  const calls: Call[] = [];
  const client: SqlClient = {
    async unsafe(query: string, params?: unknown[]) {
      calls.push({ query, params });
      if (query.includes("WITH RECURSIVE")) return opts.cascade?.[`${params![0]}:${params![1]}`] ?? [];
      if (query.includes("pg_extension")) return [{ installed: opts.pgss ?? false }];
      if (query.includes("FROM pg_stat_statements")) return [{ pgss: opts.pgssRows ?? [] }];
      return [{ snapshot: asPostgresRenders(query, raw) }];
    },
    async end() {},
  };
  return { client, calls };
}

const s = (name: string, setting: string, context: string, extra: Record<string, unknown> = {}) => ({
  name, setting, unit: null, context, vartype: "string", min_val: null, max_val: null, enumvals: null,
  source: "default", pending_restart: false, ...extra,
});

const rawNode = (standby: boolean, preload: string) => ({
  collected_at: standby ? "2026-11-23T10:00:00.4+00:00" : "2026-11-23T10:00:00.123456+00:00",
  server_version_num: 180001,
  database: "pgaibench",
  in_recovery: standby,
  settings: [s("max_locks_per_transaction", "64", "postmaster", { vartype: "integer" }), s("shared_preload_libraries", preload, "postmaster")],
  role_db_settings: [{ role: "shipping_api", database: null, settings: ["statement_timeout=5s"] }],
  replicas: standby ? [] : [{ application_name: "standby1", client_addr: "10.0.0.3", state: "streaming", sync_state: "async", sync_priority: 0, replay_lag_s: null }],
  wal_receiver: standby ? { status: "streaming", sender_host: "10.0.0.2", sender_port: 5432, slot_name: "standby1" } : null,
  slots: standby ? [] : [{ slot_name: "standby1", slot_type: "physical", active: true }],
  sessions: { client_backends: 4, idle: 2, idle_in_txn: 1, oldest_xact_age_s: standby ? null : 120.5 },
  locks: standby ? [] : [{ relation: "public.orders", mode: "RowExclusiveLock", granted: true, pid: 77, xact_age_s: 120.5 }],
  relations: [
    { name: "public.orders", kind: "r", persistence: "p", total_bytes: 1567640576, reltuples: 2000000, reloptions: null, replica_identity: "d" },
    { name: "public.orders_by_month", kind: "p", persistence: "u", total_bytes: 0, reltuples: -1, reloptions: ["fillfactor=90"], replica_identity: "f" },
    { name: "public.order_totals", kind: "m", persistence: "p", total_bytes: 16384, reltuples: 10, reloptions: null, replica_identity: "n" },
  ],
  constraints: [
    { name: "orders_pkey", type: "p", validated: true, table: "public.orders", index: "public.orders_pkey", references: null, definition: "PRIMARY KEY (id)" },
    { name: "orders_amount_check", type: "c", validated: false, table: "public.orders", index: null, references: null, definition: "CHECK ((amount >= 0)) NOT VALID" },
  ],
  indexes: [
    { index: "public.orders_pkey", table: "public.orders", valid: true, primary: true, unique: true, replident: false, total_bytes: 44941312 },
    { index: "public.orders_customer_created_idx", table: "public.orders", valid: true, primary: false, unique: false, replident: false, total_bytes: 60301312 },
  ],
  index_usage: [
    { index: "public.orders_pkey", table: "public.orders", idx_scan: standby ? 0 : 50210, last_idx_scan: standby ? null : "2026-11-23T09:59:59.5+00:00" },
    { index: "public.orders_customer_created_idx", table: "public.orders", idx_scan: standby ? 812 : 0, last_idx_scan: standby ? "2026-11-23T09:58:00+00:00" : null },
  ],
  table_usage: [
    { table: "public.orders", seq_scan: 1, last_seq_scan: "2026-11-23T09:00:00+00:00", idx_scan: 50210, last_idx_scan: "2026-11-23T09:59:59.5+00:00", n_live_tup: 2000000, n_dead_tup: 10 },
  ],
});

const cr = {
  id: "CR-1",
  task: "t",
  steps: [
    { sql: "DROP INDEX CONCURRENTLY public.orders_customer_created_idx" },
    { sql: "BEGIN; DROP TABLE public.order_totals_old, public.legacy CASCADE; DROP TYPE public.order_status_enum; COMMIT" },
    { config: { name: "work_mem", value: "8MB" } },
    { sql: "DROP MATERIALIZED VIEW public.order_totals" },
    { sql: "DROP TABLE" },
  ],
};

const windowStart = new Date("2026-11-23T09:30:00Z");

describe("snapshot collector", () => {
  test("collects both nodes into one validated snapshot", async () => {
    const primary = fakeNode(rawNode(false, "pg_stat_statements"), {
      pgss: true,
      pgssRows: [{ queryid: "-8312904481220455912", query: "SELECT 1", calls: 3, mean_exec_time_ms: 0.1, rows: 3 }],
      cascade: { "pg_class:public.legacy": [{ object_type: "view", identity: "public.legacy_report" }] },
    });
    const standby = fakeNode(rawNode(true, ""), { pgss: true });

    const snap = await collectSnapshot({ primary: primary.client, standby: standby.client }, cr, { usageWindowStart: windowStart });

    expect(snap.collected_at).toBe("2026-11-23T10:00:00.123456+00:00");
    expect(snap.usage_window_start).toBe("2026-11-23T09:30:00.000Z");
    expect(snap.nodes.primary.settings.max_locks_per_transaction).toMatchObject({ value: "64", context: "postmaster", vartype: "integer" });
    expect(snap.nodes.standby.replication.in_recovery).toBe(true);
    expect(snap.nodes.primary.locks).toEqual([{ relation: "public.orders", mode: "RowExclusiveLock", granted: true, pid: 77, xact_age_s: 120.5 }]);
    expect(snap.nodes.standby.usage.indexes["public.orders_customer_created_idx"]).toEqual({ table: "public.orders", idx_scan: 812, last_idx_scan: "2026-11-23T09:58:00+00:00" });
    expect(snap.nodes.primary.usage.tables["public.orders"].seq_scan).toBe(1);

    expect(snap.relations["public.orders"]).toEqual({ kind: "table", total_bytes: 1567640576, reltuples: 2000000, persistence: "permanent", reloptions: [], replica_identity: "default" });
    expect(snap.relations["public.orders_by_month"]).toMatchObject({ kind: "partitioned_table", persistence: "unlogged", replica_identity: "full" });
    expect(snap.relations["public.order_totals"]).toMatchObject({ kind: "matview", replica_identity: "nothing" });
    expect(snap.relations["public.orders_pkey"]).toEqual({ kind: "index", table: "public.orders", total_bytes: 44941312, valid: true, primary: true, unique: true, replica_identity: false });
    expect(snap.constraints.map((c) => [c.name, c.type, c.validated])).toEqual([["orders_pkey", "primary_key", true], ["orders_amount_check", "check", false]]);
    expect(snap.role_db_settings).toEqual([{ role: "shipping_api", database: null, settings: ["statement_timeout=5s"] }]);
  });

  test("query statistics are collected only where pg_stat_statements is installed and preloaded", async () => {
    const rows = [{ queryid: "42", query: "SELECT 1", calls: 3, mean_exec_time_ms: 0.1, rows: 3 }];
    const primary = fakeNode(rawNode(false, "auto_explain,pg_stat_statements"), { pgss: true, pgssRows: rows });
    const standby = fakeNode(rawNode(true, "auto_explain"), { pgss: true, pgssRows: rows });

    const snap = await collectSnapshot({ primary: primary.client, standby: standby.client }, cr, { usageWindowStart: windowStart });

    expect(snap.nodes.primary.query_stats).toEqual(rows);
    expect(snap.nodes.standby.query_stats).toBeNull();
    expect(standby.calls.some((c) => c.query.includes("FROM pg_stat_statements"))).toBe(false);

    const none = fakeNode(rawNode(false, "pg_stat_statements"), { pgss: false });
    const snap2 = await collectSnapshot({ primary: none.client, standby: standby.client }, cr, { usageWindowStart: windowStart });
    expect(snap2.nodes.primary.query_stats).toBeNull();
  });

  test("a CASCADE closure is computed on the primary for each drop target in the change request", async () => {
    const primary = fakeNode(rawNode(false, ""), {
      cascade: { "pg_class:public.legacy": [{ object_type: "view", identity: "public.legacy_report" }] },
    });
    const standby = fakeNode(rawNode(true, ""));

    const snap = await collectSnapshot({ primary: primary.client, standby: standby.client }, cr, { usageWindowStart: windowStart });

    expect(Object.keys(snap.cascade).sort()).toEqual([
      "public.legacy", "public.order_status_enum", "public.order_totals", "public.order_totals_old", "public.orders_customer_created_idx",
    ]);
    expect(snap.cascade["public.legacy"]).toEqual({ refclass: "pg_class", reaches: [{ object_type: "view", identity: "public.legacy_report" }] });
    expect(snap.cascade["public.order_status_enum"]).toEqual({ refclass: "pg_type", reaches: [] });
    expect(standby.calls.some((c) => c.query.includes("WITH RECURSIVE"))).toBe(false);
  });

  test("an unqualified drop target is resolved in the public schema", async () => {
    const primary = fakeNode(rawNode(false, ""));
    const standby = fakeNode(rawNode(true, ""));
    const snap = await collectSnapshot({ primary: primary.client, standby: standby.client },
      { id: "CR", task: "t", steps: [{ sql: "DROP TABLE legacy" }] }, { usageWindowStart: windowStart });
    expect(Object.keys(snap.cascade)).toEqual(["public.legacy"]);
  });

  test("a node in the wrong recovery state is an error, not a snapshot", async () => {
    const primary = fakeNode(rawNode(true, ""));
    const standby = fakeNode(rawNode(true, ""));
    await expect(collectSnapshot({ primary: primary.client, standby: standby.client }, cr, { usageWindowStart: windowStart })).rejects.toThrow(/primary/);
  });

  test("collected state that fails the schema is an error", async () => {
    const raw = rawNode(false, "");
    raw.relations[0].kind = "Z";
    const primary = fakeNode(raw);
    const standby = fakeNode(rawNode(true, ""));
    await expect(collectSnapshot({ primary: primary.client, standby: standby.client }, cr, { usageWindowStart: windowStart })).rejects.toThrow();
  });
});
