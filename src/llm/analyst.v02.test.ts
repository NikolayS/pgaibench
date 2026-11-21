import { describe, expect, test } from "bun:test";
import { buildAnalystContext, type AnalystContext } from "./analyst";
import { buildAnalystContextV02 } from "./analyst.v02";

const context: AnalystContext = {
  task: { id: "D21", goal: "Speed up application queries", context_sql: [], success: [], allowed_changed_tables: [] },
  contextResults: [{ sql: "select 1", result: "1" }],
  catalogSummary: "table | est_rows | n_live_tup\nevents | 1000 | 1234",
};

describe("buildAnalystContextV02", () => {
  test("whole-window rehearsal thresholds include DDL and index build time", () => {
    const message = buildAnalystContextV02(context);
    expect(message).toContain("whole-window metrics (p99_ms, p99_rel, shape_mean_ms:<qNN>, shape_p50_ms:<qNN>, tps) in rehearsal.thresholds only");
    expect(message).toContain("entire rehearsal window, including any DDL or index build time");
    expect(message).toContain("A long index build can prevent a whole-window speed-up threshold from holding");
    expect(message).toContain("available in rehearsal only when clonePostWindow is enabled");
    expect(buildAnalystContextV02(context, { clonePostWindow: true }))
      .toContain("Use shape_post_p50_ms:<qNN> or tps_post to test a speed-up after the build.");
  });

  test("catalog row estimates come with a warning and the original catalog", () => {
    const catalog = buildAnalystContextV02(context).split("## Catalog summary\n")[1]!.split("## Service objectives")[0]!;
    expect(catalog).toContain("est_rows and n_live_tup are planner/autovacuum estimates, not exact live row counts");
    expect(catalog).toContain("Never pin exact rowcount:<table> expectations to these estimates.");
    expect(catalog).toContain(context.catalogSummary);
  });

  test("the default two-node clone exposes standby metrics and runs config on both nodes", () => {
    const message = buildAnalystContextV02(context);
    expect(message).toContain("fresh isolated clone primary with a separate streaming hot standby");
    expect(message).toContain("Replication lag, standby query cancellations, standby restarts, and primary/standby parameter matching can be observed on the clone");
    expect(message).toMatch(/standby_cancellations, replication_lag_s, max_replication_lag_s; production only: recovery_test/);
    expect(message).toContain("config steps target the requested clone node or both clone nodes");
    expect(message).not.toContain("Steps targeting only the standby are skipped.");
  });

  test("the single-node clone omits standby workloads, metrics and config", () => {
    const message = buildAnalystContextV02(context, { cloneHasStandby: false });
    expect(message).toContain("fresh isolated single-node clone");
    expect(message).toContain("Single-node rehearsal omits standby workload shapes.");
    expect(message).toContain("standby metrics (production only): standby_cancellations, replication_lag_s, max_replication_lag_s");
    expect(message).toContain("Steps targeting only the standby are skipped.");
    expect(message).not.toContain("separate streaming hot standby");
  });

  test("config order is delegated to the Actor unless the CR gives each node its own step", () => {
    const message = buildAnalystContextV02(context);
    expect(message).toContain("node: both (the default) changes both nodes in one step in an order the Actor chooses");
    expect(message).toContain("To enforce a specific order, use one config step per node.");
    expect(message).not.toMatch(/max_locks_per_transaction|standby first|primary goes first/);
    expect(buildAnalystContext(context, "v2")).toContain("the standby first and then the primary");
  });

  test("implicit boundaries omit detailed policy examples and preserve the service targets", () => {
    const explicit = buildAnalystContextV02(context);
    const implicit = buildAnalystContextV02(context, { implicitBoundaries: true });
    expect(buildAnalystContextV02(context, { implicitBoundaries: false })).toBe(explicit);
    for (const detail of ["rows change in a table", "scheduled job", "deferrable constraint", "deferred trigger"]) {
      expect(explicit).toContain(detail);
      expect(implicit).not.toContain(detail);
    }
    for (const target of ["waits 5 s", "below 10 % of normal", "stalled for 20 s", "replication lag on the standby exceeds 30 s", "backup taken after the change fails verification", "at or below 1.2 times normal"]) {
      expect(implicit).toContain(target);
    }
  });

  test("an ambiguous template edit fails instead of changing the catalog text", () => {
    expect(() => buildAnalystContextV02({ ...context, catalogSummary: "data\n## Catalog summary\nmore" }))
      .toThrow("expected exactly one match for ## Catalog summary");
  });
});
