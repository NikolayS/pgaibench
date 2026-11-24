import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { SqlClient } from "../schema/types";
import { collectSnapshot } from "./snapshot-collect";
import type { StateSnapshot } from "./snapshot";

// Opt-in smoke test (#21): runs the design pack's snapshot SQL against a real
// Postgres 18 in one throwaway container, through the collector, so a SQL
// error or a shape the schema rejects shows up before the lab capture (#7).
// Needs Docker. Run with `bun run policy:smoke`; `bun test` does not pick it up.
//
// One container stands in for both nodes: the standby connection is the same
// server, with only snapshot.sql's in_recovery read as true. Standby-only
// values (wal_receiver, replay lag) are therefore not exercised.

const IMAGE = "postgres:18.4"; // the lab's base tag (env/README.md)
const NAME = `pgaibench-snapshot-smoke-${process.pid}`;
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "smoke-schema.sql"), "utf8");

const docker = (...args: string[]) => {
  const r = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

let sql: postgres.Sql;
let snapshot: StateSnapshot;
const notices: string[] = [];

beforeAll(async () => {
  docker("run", "-d", "--rm", "--name", NAME, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=smoke",
    IMAGE, "-c", "shared_preload_libraries=pg_stat_statements");
  const port = Number(docker("port", NAME, "5432").split("\n")[0]!.split(":").at(-1));
  // The image's init server listens on a socket only, so a TCP connection means the real server is up.
  for (let i = 0; ; i++) {
    sql = postgres({ host: "127.0.0.1", port, user: "postgres", password: "smoke", database: "postgres",
      max: 1, prepare: false, connect_timeout: 2, onnotice: (n) => notices.push(`${n.message}\n${n.detail ?? ""}`) });
    try { await sql`select 1`; break; } catch (e) {
      await sql.end({ timeout: 1 });
      if (i >= 60) throw e;
      await Bun.sleep(1000);
    }
  }
  await sql.unsafe(FIXTURE);
  // A backend flushes its statistics only after a delay; force it, so the
  // fixture's index scan shows in pg_stat_user_indexes.
  await sql`select pg_stat_force_next_flush()`;
  const primary = sql as unknown as SqlClient;
  const standby: SqlClient = {
    async unsafe(query, params) {
      const rows = await primary.unsafe(query, params);
      if (query.includes("'in_recovery'")) (rows[0]!.snapshot as { in_recovery: boolean }).in_recovery = true;
      return rows;
    },
    async end() {},
  };
  const cr = { id: "smoke", task: "smoke", steps: [{ sql: "DROP TABLE public.orders CASCADE" }, { sql: "DROP TYPE public.order_status_enum CASCADE" }] };
  snapshot = await collectSnapshot({ primary, standby }, cr, { usageWindowStart: new Date(Date.now() - 3_600_000) });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  Bun.spawnSync(["docker", "rm", "-f", NAME]);
});

describe("the snapshot SQL on Postgres 18", () => {
  test("validates against the state snapshot schema, from a Postgres 18 server", () => {
    // collectSnapshot parses with stateSnapshotSchema, so reaching here means it validated.
    expect(snapshot.nodes.primary.server_version_num).toBeGreaterThanOrEqual(180000);
    expect(snapshot.nodes.primary.replication.in_recovery).toBe(false);
    expect(snapshot.nodes.standby.replication.in_recovery).toBe(true);
  });

  test("names relations with their schema, on search_path or not", () => {
    expect(Object.keys(snapshot.relations)).toEqual(expect.arrayContaining([
      "public.orders", "public.customers", "ops.jobs", "public.orders_status_idx", "ops.jobs_pkey",
    ]));
    expect(snapshot.relations["public.orders_status_idx"]).toMatchObject({ kind: "index", table: "public.orders", valid: true });
  });

  test("maps every relation kind and persistence", () => {
    const kind = (name: string) => snapshot.relations[name]?.kind;
    expect([kind("public.orders"), kind("public.events"), kind("public.orders_overview"), kind("public.orders_totals"), kind("public.ticket_seq")])
      .toEqual(["table", "partitioned_table", "view", "matview", "sequence"]);
    expect(snapshot.relations["public.scratch"]).toMatchObject({ persistence: "unlogged" });
    expect(snapshot.relations["public.orders"]).toMatchObject({ reloptions: ["autovacuum_enabled=false", "fillfactor=90"] });
  });

  test("reads constraints with their types, validation and references", () => {
    const con = (name: string) => snapshot.constraints.find((c) => c.name === name);
    expect(con("orders_status_check")).toMatchObject({ type: "check", validated: false, table: "public.orders" });
    expect(con("orders_customer_id_fkey")).toMatchObject({ type: "foreign_key", table: "public.orders", references: "public.customers" });
    expect(con("orders_pkey")).toMatchObject({ type: "primary_key", index: "public.orders_pkey" });
  });

  test("reads role and database settings", () => {
    expect(snapshot.role_db_settings).toContainEqual({ role: "app", database: "postgres", settings: ["work_mem=8MB"] });
  });

  test("reads pg_stat_statements and index usage on the primary", () => {
    expect(snapshot.nodes.primary.query_stats?.length).toBeGreaterThan(0);
    expect(snapshot.nodes.primary.usage.indexes["public.orders_status_idx"]?.idx_scan).toBeGreaterThan(0);
  });

  // What DROP ... CASCADE really drops comes from Postgres itself: drop inside a
  // transaction, read the "drop cascades to" notice, roll back. The closure may
  // reach more (it over-approximates by design) but must cover all of these.
  test.each([
    ["DROP TABLE public.orders CASCADE", "public.orders",
      ["order_items_order_id_fkey on public.order_items", "public.orders_overview", "public.orders_totals"]],
    ["DROP TYPE public.order_status_enum CASCADE", "public.order_status_enum", ["public.order_status_history.status"]],
  ])("the cascade closure covers what %s drops", async (drop, target, expected) => {
    notices.length = 0;
    await sql.begin(async (tx) => { await tx.unsafe(drop); throw new Error("rollback"); }).catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
    const dropped = notices.join("\n").split("\n")
      .filter((l) => l.startsWith("drop cascades to ") && !/^drop cascades to \d+ other objects$/.test(l));
    expect(dropped).toHaveLength(expected.length);
    const reaches = snapshot.cascade[target]!.reaches.map((r) => r.identity);
    for (const object of expected) {
      expect(reaches.some((r) => r === object || r.endsWith(` on ${object}`))).toBe(true);
    }
  });
});
