import { describe, expect, test } from "bun:test";
import { HarnessError, RealLab, VMDirtyError, mergeWindow, checkpointWindow, type LabDeps } from "./lab";
import { snapshot } from "../telemetry/fixtures";
import { goodCR } from "./fixtures/good-cr";
import { rehearsalPassed } from "../scoring/outcome";
import { evaluateOracle } from "../oracle/oracle";
import { fixtureCR, fixtureTask } from "../telemetry/fixtures";
import type { CollectOptions, Connection, Snapshot } from "../schema/types";

const host = { seed: 1, ip: "192.0.2.4", name: "pgaibench-ctl-s1" };
const summary = { tps: 500, overall: { count: 1000, p50_ms: 2, p99_ms: 20 }, shapes: { q07: { count: 100, p50_ms: 3, p99_ms: 30 } } };

function deps(log: string[], over: Partial<LabDeps> = {}): LabDeps {
  return {
    collect: async (conn: Connection, o: CollectOptions = {}) => {
      log.push(`collect port=${conn.port} kind=${o.kind} s=${o.seconds} standby=${o.standbyConn ? o.standbyConn.port : "none"} base=${o.baseline ? "y" : "n"} integrity=${o.integrity !== false} backup=${o.backupVerify !== false}`);
      const s = snapshot();
      s.wait_events = { "LWLock:LockManager": o.seconds ?? 0 };
      s.replication.lag_s = [o.seconds ?? 0];
      return s;
    },
    applyCR: async (_cr, target, o) => { log.push(`apply ${target.kind} port=${target.conn.port} clone=${target.clone ?? "-"} log=${o?.logPath}`); return { steps: [{ ok: true, metrics: {} }], aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath! }; },
    run: async (_ip, cmd) => { log.push(`host ${cmd}`); return { stdout: JSON.stringify({ menu: "x", ...summary }), stderr: "", exitCode: 0 }; },
    tunnel: async (_ip, ports) => { log.push(`tunnel ${ports.join(",")}`); return { ports: Object.fromEntries(ports.map((p) => [p, p + 30000])), close: async () => { log.push(`tunnel-close ${ports.join(",")}`); } }; },
    client: () => ({ unsafe: async (q: string) => { log.push(`sql ${q.slice(0, 30)}`); return [{ a: 1 }]; }, end: async () => {} }),
    sleep: async () => {},
    ...over,
  };
}

describe("mergeWindow", () => {
  test("window samples go into the after snapshot; latency from workload", () => {
    const after = snapshot(), window = snapshot();
    window.wait_events = { "LWLock:LockManager": 99 };
    window.replication.lag_s = [5, 40];
    window.resources.io_samples = [{ at: "2026-11-03T00:00:00Z", util_pct: 95, seconds: 120 }];
    window.metrics.max_lock_wait_s = 7;
    window.lock_wait_samples = [0, 6]; after.lock_wait_samples = [1];
    window.standby_lock_wait_samples = [0, 6]; after.standby_lock_wait_samples = [0];
    window.errors = ["latency quantiles unavailable: supply workload latencySamples", "replication: missing primary or standby LSN"];
    const m = mergeWindow(after, window, summary);
    expect(m.wait_events).toEqual({ "LWLock:LockManager": 99 });
    expect(m.replication.lag_s).toEqual([5, 40, 0]);
    expect(m.resources.io_samples[0]!.util_pct).toBe(95);
    expect(m.metrics.max_lock_wait_s).toBe(7);
    expect(m.lock_wait_samples).toEqual([0, 6, 1]);
    expect(m.standby_lock_wait_samples).toEqual([0, 6, 0]);
    expect(mergeWindow(after, window, { ...summary, injector: { enabled: true, primary_cycles: 12, standby_cycles: 0 } } as any).metrics.injector_primary_cycles).toBe(12);
    expect(m.latency.p99_ms).toBe(20);
    expect(m.metrics.tps).toBe(500);
    expect(m.errors).toEqual(["window replication: missing primary or standby LSN"]);
  });
  test("stall sampler durations of window and after are kept in order", () => {
    const after = snapshot(), window = snapshot();
    window.stall_sample_ms = [3, 4]; after.stall_sample_ms = [5];
    expect(mergeWindow(after, window, summary).stall_sample_ms).toEqual([3, 4, 5]);
  });
  test("no workload summary: latency unavailable, recorded as error", () => {
    const m = mergeWindow(snapshot(), snapshot(), null);
    expect(m.errors.join()).toMatch(/workload summary missing/);
  });
});
test("checkpoint share uses only counters added in the workload window", () => {
  const before = snapshot(), after = snapshot();
  before.stats.pg_stat_checkpointer = [{ num_requested: 18, num_timed: 0 }];
  after.stats.pg_stat_checkpointer = [{ num_requested: 18, num_timed: 1 }];
  checkpointWindow(before, after);
  expect(after.metrics.checkpoints_req_share).toBe(0);
  expect(after.metrics.checkpoints_window_count).toBe(1);
  checkpointWindow(after, after);
  expect(after.metrics.checkpoints_req_share).toBe(0);
  expect(after.metrics.checkpoints_window_count).toBe(0);
  after.stats.pg_stat_checkpointer = [];
  checkpointWindow(before, after);
  expect(after.metrics.checkpoints_req_share).toBeNull();
  expect(after.metrics.checkpoints_window_count).toBeNull();
});
test('RealLab baseline derives checkpoint deltas from its window snapshots', async () => {
  const log: string[] = [];
  const base = deps(log);
  let n = 0;
  const lab = new RealLab(host, { ...base, collect: async (c, o) => {
    const s = await base.collect(c, o);
    s.stats.pg_stat_checkpointer = [{ num_requested: 10 + n++, num_timed: 0 }];
    return s;
  } });
  await lab.open();
  const b = await lab.baseline(60);
  expect(b.metrics.checkpoints_window_count).toBe(2);
  expect(b.metrics.checkpoints_req_share).toBe(1);
});

describe("RealLab", () => {
  test("open tunnels primary+standby; baseline runs W_prod on 5432 with a window sampler", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const b: Snapshot = await lab.baseline(60);
    expect(log[0]).toBe("tunnel 5432,5433");
    expect(log).toContain("host /opt/pgaibench/env/workload/w_prod.sh 60 W_prod 5432");
    expect(log).toContain("collect port=35432 kind=production s=60 standby=35433 base=y integrity=false backup=false");
    expect(log.at(-1)).toBe("collect port=35432 kind=production s=1 standby=35433 base=y integrity=true backup=false");
    expect(b.latency.p99_ms).toBe(20);
    await lab.close();
    expect(log.at(-1)).toBe("tunnel-close 5432,5433");
  });

  test("rehearse: clone tunnel, chosen menu on the clone port, actor on clone, thresholds vs production baseline latency", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const base = snapshot(); base.latency.p99_ms = 20;
    const cr = { ...structuredClone(goodCR), rehearsal: { ...goodCR.rehearsal, workload: "synthetic-light" as const, thresholds: { p99_rel: "<1.2x" } } };
    const r = await lab.rehearse(cr, { kind: "clone", port: 5501, n: 1, name: "x" }, base, 120, "/tmp/actor.jsonl");
    expect(log).toContain("tunnel 5501");
    expect(log).toContain("host /opt/pgaibench/env/workload/w_prod.sh 120 synthetic-light 5501");
    expect(log).toContain("apply clone port=35501 clone=1 log=/tmp/actor.jsonl");
    expect(log.filter((l) => l.startsWith("collect port=35501")).at(-1)).toContain("integrity=true backup=false");
    expect(log.filter((l) => l.startsWith("collect port=35501")).every((l) => l.includes("standby=none"))).toBe(true);
    expect(r.target).toBe("clone");
    expect(r.workload).toBe("synthetic-light");
    // after p99 20 (workload) vs reference 20 -> 1.0x < 1.2x
    expect(r.diff.thresholds).toEqual([expect.objectContaining({ metric: "p99_rel", pass: true })]);
    expect(r.notes.join(" ")).toMatch(/production W_prod baseline/);
    expect(log).toContain("tunnel-close 5501");
  });

  test("rehearse: a threshold on a metric the clone cannot measure is not judged (stored C7 CR shape)", async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, collect: async (c, o = {}) => { const s = await base.collect(c, o); if (o.kind === "clone") s.backup_verify = "skipped"; return s; } });
    await lab.open();
    const thresholds = { io_util_pct: "<=90", oom_kills: "==0", recovery_test: "==1", backup_verify: "==1" };
    const cr = { ...structuredClone(goodCR), rehearsal: { ...goodCR.rehearsal, workload: "W_prod" as const, thresholds } };
    const r = await lab.rehearse(cr, { kind: "clone", port: 5501, n: 1, name: "x" }, snapshot(), 120, "/tmp/actor.jsonl");
    const by = Object.fromEntries(r.diff.thresholds.map((t) => [t.metric, t]));
    expect(by.recovery_test!.not_judged).toBe("not_measurable_here");
    expect(by.backup_verify!.not_judged).toBe("not_measurable_here");
    expect(by.oom_kills!.not_judged).toBeUndefined();
    expect(rehearsalPassed(r)).toBe(true);
    const p = await lab.production(cr, snapshot(), 180, "/tmp/a.jsonl");
    expect(p.diff.thresholds.every((t) => t.not_judged === undefined)).toBe(true);
  });

  test("rehearse: a relative threshold compares with the production baseline window for every window metric (stored L1 CR shape and a checkpoint share bound)", async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, collect: async (c, o = {}) => { const s = await base.collect(c, o); s.latency.shapes.q18 = { calls: 50, mean_ms: 2.1, p50_ms: 2, p99_ms: 4 }; return s; } });
    await lab.open();
    const baseline = snapshot();
    baseline.latency.shapes.q18 = { calls: 500, mean_ms: 2, p50_ms: 2, p99_ms: 4 };
    baseline.metrics.checkpoints_req_share = 0.5; baseline.metrics.max_lock_wait_s = 0.2;
    const thresholds = { "shape_mean_ms:q18": "<1.2x", checkpoints_req_share: "<1.2x", max_lock_wait_s: "<=2x", "rowcount:orders": "<=1.5x" };
    const cr = { ...structuredClone(goodCR), rehearsal: { ...goodCR.rehearsal, workload: "W_prod" as const, thresholds } };
    const r = await lab.rehearse(cr, { kind: "clone", port: 5501, n: 1, name: "x" }, baseline, 120, "/tmp/actor.jsonl");
    const by = Object.fromEntries(r.diff.thresholds.map((t) => [t.metric, t]));
    expect(by["shape_mean_ms:q18"]).toMatchObject({ baseline: 2, actual: 2.1, pass: true });
    expect(by.checkpoints_req_share).toMatchObject({ baseline: 0.5, pass: true });
    expect(by.max_lock_wait_s!.baseline).toBe(0.2);
    // A state metric keeps the clone's own before value (the clone holds the same data).
    expect(by["rowcount:orders"]!.baseline).toBe(r.before.integrity.orders!.rowcount);
    baseline.metrics.checkpoints_req_share = 0;
    const z = await lab.rehearse(cr, { kind: "clone", port: 5501, n: 1, name: "x" }, baseline, 120, "/tmp/actor.jsonl");
    expect(z.diff.thresholds.find((t) => t.metric === "checkpoints_req_share")).toMatchObject({ pass: true, not_judged: "no_baseline_here" });
    expect(rehearsalPassed(z)).toBe(true);
  });

  test("production: a deferred step expectation on backup_verify is judged on the end-of-window collection", async () => {
    for (const [status, pass] of [["pass", true], ["fail", false]] as const) {
      const log: string[] = [];
      const base = deps(log, { applyCR: async (_cr, _t, o) => ({ steps: [{ ok: true, metrics: {}, not_judged: [{ metric: "backup_verify", reason: "not_measurable_here" }] }, { ok: false, metrics: {}, error: "x", not_judged: [{ metric: "recovery_test", reason: "not_measurable_here" }] }], aborted: true, rolledBack: true, rollbackErrors: [], logPath: o!.logPath! }) });
      const lab = new RealLab(host, { ...base, collect: async (c, o = {}) => { const s = await base.collect(c, o); s.backup_verify = o.backupVerify === false ? "skipped" : status; return s; } });
      await lab.open();
      const cr = structuredClone(goodCR);
      cr.steps = [{ sql: "select 1", expect: { backup_verify: "==1" } }, { sql: "select 2", expect: { recovery_test: "==1" } }] as never;
      const p = await lab.production(cr, snapshot(), 180, "/tmp/a.jsonl");
      // Only the completed step's expectation is judged; the failed step never reached its state.
      expect(p.deferred_expectations).toEqual([expect.objectContaining({ step: 0, metric: "backup_verify", actual: status, pass })]);
    }
  });

  test("production: W_prod on 5432, actor on production, after snapshot runs backup verify (kind production)", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, "/tmp/a.jsonl");
    expect(log).toContain("host /opt/pgaibench/env/workload/w_prod.sh 180 W_prod 5432");
    expect(log).toContain("apply production port=35432 clone=- log=/tmp/a.jsonl");
    expect(log.filter((l) => l.startsWith("collect")).at(-1)).toBe("collect port=35432 kind=production s=1 standby=35433 base=y integrity=true backup=true");
    expect(log.filter((l) => l.startsWith("collect")).slice(0, -1).every((l) => l.includes("integrity=false backup=false"))).toBe(true);
    expect(r.target).toBe("primary+standby");
    expect(r.aborted).toBe(false);
  });
  test("production forwards the standby tunnel to the Actor", async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, applyCR: async (_cr, _target, options) => {
      expect(options?.telemetry?.standbyConn?.port).toBe(35433);
      return base.applyCR(_cr, _target, options);
    } });
    await lab.open();
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
  });
  test("M7: the step timeout reaches the Actor for production and rehearsal", async () => {
    const log: string[] = [];
    const base = deps(log);
    const seen: (number | undefined)[] = [];
    const lab = new RealLab(host, { ...base, applyCR: async (c, t, o) => { seen.push(o?.stepTimeoutMs); return base.applyCR(c, t, o); } });
    await lab.open();
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', undefined, { stepTimeoutS: 42 });
    await lab.rehearse(structuredClone(goodCR), { n: 1, port: 5441 } as never, snapshot(), 120, '/tmp/r.jsonl', { stepTimeoutS: 43 });
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
    expect(seen).toEqual([42000, 43000, undefined]);
  });
  test("T10 records a 300-second post-change W_prod TPS window", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'T10';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(log).toContain('host /opt/pgaibench/env/workload/w_prod.sh 300 W_prod 5432');
    expect(log).toContain('collect port=35432 kind=production s=300 standby=35433 base=y integrity=false backup=false');
    expect(r.after.metrics.tps_post).toBe(500);
  });
  test('scenario success on shape_post_p50_ms runs a 60-second post window for that shape', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, run: async (_ip, cmd) => { log.push(`host ${cmd}`); return { stdout: JSON.stringify({ menu: 'x', ...summary, shapes: { q03: { count: 9, p50_ms: 4, p99_ms: 9 } } }), stderr: '', exitCode: 0 }; } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'D21';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['shape_post_p50_ms:q03', 'p99_ms']);
    expect(log).toContain('host /opt/pgaibench/env/workload/w_prod.sh 60 W_prod 5432');
    expect(r.after.metrics['shape_post_p50_ms:q03']).toBe(4);
    expect(r.notes.join(' ')).toMatch(/post window 60 s/);
  });
  test('oracle v2: post window TPS buckets, shape errors and end-of-window replication state reach the after snapshot', async () => {
    const log: string[] = [];
    const base = deps(log);
    let calls = 0;
    const lab = new RealLab(host, { ...base,
      run: async (_ip, cmd) => { log.push(`host ${cmd}`); calls++; return { stdout: JSON.stringify({ menu: 'x', ...summary, seconds: calls === 1 ? 180 : 60, shapes: { q03: { count: 9, p50_ms: 4, p99_ms: 9 } }, tps_buckets_10s: calls === 1 ? [50, 50] : [50, 0], tps_counts_1s: calls === 1 ? [5, 5] : [5, 0], tps_start_epoch: calls === 1 ? 1000 : 1185, shape_errors: calls === 1 ? { q07: { 'error:  a': 1 } } : { q07: { 'error:  a': 2 }, q09: { 'error:  b': 3 } }, shape_error_events: [{ node: 'primary', shape: 'q07', class: 'error:  a', epoch: calls === 1 ? 100 : 300 }] }), stderr: '', exitCode: 0 }; },
      collect: async (c, o) => { const s = await base.collect(c, o); if (o?.seconds === 60) { s.replication.intact_last = false; s.lock_wait_samples = [0, 8]; s.standby_lock_wait_samples = [0, 1]; } return s; } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'D21';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['shape_post_p50_ms:q03']);
    expect(r.after.tps_buckets_10s).toEqual([50, 50]);
    expect(r.after.post_tps_buckets_10s).toEqual([50, 0]);
    expect(r.after.tps_counts_1s).toEqual([5, 5]);
    expect(r.after.post_tps_counts_1s).toEqual([5, 0]);
    expect(r.after.shape_errors).toEqual({ q07: { 'error:  a': 3 }, q09: { 'error:  b': 3 } });
    expect(r.after.shape_errors_s).toBe(240);
    expect(r.after.shape_error_events?.map(e => e.epoch)).toEqual([100, 300]);
    // lock_stall reads the post window too.
    expect(r.after.lock_wait_samples?.slice(-2)).toEqual([0, 8]);
    expect(r.after.standby_lock_wait_samples?.slice(-2)).toEqual([0, 1]);
    // M1: one timeline: the post window's epoch and where its lock samples start.
    expect(r.after.post_tps_start_epoch).toBe(1185);
    expect(r.after.post_lock_wait_index).toBe(r.after.lock_wait_samples!.length - 2);
    expect(r.after.replication.intact_end).toBe(false);
  });
  test('E1 scenario: the Actor starts only after a granted pgaibench-injector lock on the table is seen', async () => {
    const log: string[] = [];
    const base = deps(log);
    let polls = 0;
    const lab = new RealLab(host, { ...base,
      client: () => ({ unsafe: async (q: string) => { if (q.includes('pgaibench-injector')) { polls++; log.push(`poll ${polls}`); expect(q).toContain("to_regclass('public.pgbench_accounts')"); expect(q).toContain('l.granted'); return [{ held: polls >= 3 }]; } return []; }, end: async () => {} }) });
    await lab.open();
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['p99_ms'], { injectorTable: 'pgbench_accounts' });
    const apply = log.findIndex(l => l.startsWith('apply production'));
    expect(log.indexOf('poll 3')).toBeGreaterThan(-1);
    expect(log.indexOf('poll 3')).toBeLessThan(apply);
    expect(log).not.toContain('poll 4');
  });

  test('E1 scenario: no injector hold within 15 s fails with harness:injector_not_holding and never applies the CR', async () => {
    const log: string[] = [];
    const base = deps(log);
    let polls = 0, sleptMs = 0;
    const lab = new RealLab(host, { ...base, sleep: async (ms) => { sleptMs += ms; },
      client: () => ({ unsafe: async (q: string) => { if (q.includes('pgaibench-injector')) { polls++; return [{ held: false }]; } return []; }, end: async () => {} }) });
    await lab.open();
    const err = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['p99_ms'], { injectorTable: 'pgbench_accounts' }).catch(e => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('harness:injector_not_holding');
    expect(log.some(l => l.startsWith('apply'))).toBe(false);
    // ACTOR_DELAY_S, then at most 15 s of polling.
    expect(sleptMs).toBe(10000 + 15000);
    expect(polls).toBe(61);
  });

  test('without injectorTable the Actor does not wait for the injector', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
    expect(log.some(l => l.includes('pgaibench-injector'))).toBe(false);
  });

  test('replication not intact at the end: poll up to 15 s, record the time to recover', async () => {
    for (const [okAt, intact, after] of [[3, true, 3], [99, false, null]] as const) {
      const log: string[] = [];
      const base = deps(log);
      let polls = 0, slept = 0;
      const lab = new RealLab(host, { ...base, sleep: async (ms) => { slept += ms; },
        collect: async (c, o) => { const s = await base.collect(c, o); s.replication.intact_last = false; return s; },
        client: (c) => ({ unsafe: async (q: string) => {
          if (q.includes('pg_stat_replication')) { polls++; return [{ streaming: polls >= okAt }]; }
          if (q.includes('pg_is_in_recovery')) return [{ in_recovery: c.port === 35433 }];
          return [];
        }, end: async () => {} }) });
      await lab.open();
      const cr = structuredClone(goodCR); cr.task = 'R8';
      const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['p99_ms']);
      expect(r.after.replication.intact_end).toBe(intact);
      expect(r.after.replication.recovered_after_s).toBe(after);
      expect(polls).toBe(intact ? okAt : 15);
    }
  });
  test('earlier a standby down at the end skips backup verify (recorded why); a streaming standby keeps it', async () => {
    for (const [down, success] of [[true, ['p99_ms']], [true, ['shape_post_p50_ms:q03']], [false, ['p99_ms']], [false, ['shape_post_p50_ms:q03']]] as const) {
      const log: string[] = [];
      const base = deps(log);
      const lab = new RealLab(host, { ...base,
        collect: async (c, o) => { const s = await base.collect(c, o); s.replication.intact_last = !down; return s; },
        client: () => ({ unsafe: async () => [], end: async () => {} }) });
      await lab.open();
      const cr = structuredClone(goodCR); cr.task = 'R8';
      const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', [...success]);
      const verified = log.some(l => /^collect port=\d+ kind=production .*backup=true$/.test(l));
      expect(verified).toBe(!down);
      if (down) expect(r.after.backup_verify_skipped).toMatch(/standby not streaming/);
      else expect(r.after.backup_verify_skipped).toBeUndefined();
    }
  });
  test('the clone before-snapshot counts the rows a relative rowcount expectation needs, so its baseline is not null', async () => {
    const log: string[] = [];
    const seen: (readonly string[] | undefined)[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, collect: async (c, o) => { const s = await base.collect(c, o); if (!o?.baseline) { seen.push(o?.rowcounts); if (o?.rowcounts?.includes('events')) s.metrics['rowcount:events'] = 1080000; } else s.metrics['rowcount:events'] = 136513; return s; } });
    await lab.open();
    const cr = structuredClone(goodCR);
    cr.rehearsal.thresholds = { 'rowcount:events': '<=0.25x' };
    cr.steps = [{ sql: 'select 1', expect: { 'rowcount:public.events': '<=0.25x', max_lock_wait_s: '<5' } } as never];
    const r = await lab.rehearse(cr, { n: 1, port: 5441 } as never, snapshot(), 120, '/tmp/r.jsonl');
    expect(seen[0]).toEqual(['events']);
    expect(r.diff.thresholds.find(t => t.metric === 'rowcount:events')).toMatchObject({ baseline: 1080000, actual: 136513, pass: true });
  });
  test('the harness outer timeout (planned time + 90 s) fails the step loudly with harness:workload_timeout', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, workloadTimeoutMs: (sec) => { expect(sec).toBe(180); return 20; }, run: async (_ip, cmd) => (cmd.includes('w_prod.sh ') ? new Promise(() => {}) : cmd.includes('pgrep') ? { stdout: '0 0', stderr: '', exitCode: 0 } : base.run(_ip, cmd)) });
    await lab.open();
    const e = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl').catch(x => x);
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.reason).toBe('harness:workload_timeout');
  });
  test('a hung workload window gets a note and stops the rehearsal go/no-go', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, run: async (_ip, cmd) => { log.push(`host ${cmd}`); return { stdout: JSON.stringify({ menu: 'x', ...summary, hung: true }), stderr: '', exitCode: 0 }; } });
    await lab.open();
    const r = await lab.rehearse(structuredClone(goodCR), { n: 1, port: 5441 } as never, snapshot(), 120, '/tmp/r.jsonl');
    expect(r.notes.join(' ')).toMatch(/workload hung/);
    expect(rehearsalPassed(r)).toBe(false);
  });
  test('with a post window the after-change collection is quick; integrity and backup verify run after the post window', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, collect: async (c, o) => { const s = await base.collect(c, o); if (o?.integrity !== false && o?.seconds === 1 && o?.baseline) { s.integrity = { orders: { rowcount: 7, checksum: 'abc' } }; s.backup_verify = 'pass'; } return s; } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'D21';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['shape_post_p50_ms:q03']);
    const collects = log.filter(l => l.startsWith('collect ') && l.includes('base=y'));
    const post = collects.findIndex(l => l.includes('s=60'));
    expect(collects.slice(0, post).filter(l => l.includes('s=1 ')).every(l => l.includes('integrity=false backup=false'))).toBe(true);
    expect(collects.slice(post + 1).some(l => l.includes('s=1 ') && l.includes('integrity=true backup=true'))).toBe(true);
    expect(r.after.integrity).toEqual({ orders: { rowcount: 7, checksum: 'abc' } });
    expect(r.after.backup_verify).toBe('pass');
  });
  test('the post-window workload starts at the change window end, before the change summary and the after-change collect', async () => {
    const log: string[] = [];
    const base = deps(log);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const lab = new RealLab(host, { ...base,
      run: async (ip, cmd) => {
        if (cmd.includes('w_prod.sh 180 ')) { log.push('change workload start'); await gate; log.push('change workload end'); }
        if (cmd.includes('w_prod.sh 60 ')) { log.push('post workload start'); release(); }
        return base.run(ip, cmd);
      },
      sleep: async (ms) => { log.push(`sleep ${ms > 100_000 ? 'long' : 'short'}`); },
    });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'D21';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['shape_post_p50_ms:q03']);
    const post = log.indexOf('post workload start');
    expect(post).toBeGreaterThan(log.findIndex(l => l.startsWith('apply ')));
    expect(post).toBeLessThan(log.indexOf('change workload end'));
    const after0 = log.findIndex(l => l.startsWith('collect ') && l.includes('s=1 ') && l.includes('base=y') && l.includes('integrity=false'));
    expect(post).toBeLessThan(after0);
    // The harness waited for the change window end (TS clock) before starting it.
    expect(log.slice(0, post).some(l => l === 'sleep long')).toBe(true);
    expect(r.after.metrics['shape_post_p50_ms:q03']).toBeDefined();
  });
  test('a success key that timed out after the CR is read once more after the CR session closed', async () => {
    const log: string[] = [];
    const base = deps(log);
    const queries: string[] = [];
    const lab = new RealLab(host, { ...base,
      collect: async (c, o) => { const s = await base.collect(c, o); if (o?.baseline) s.errors.push('scenario key orders.archived.type: canceling statement due to lock timeout', 'scenario key orders.amount.type: expected before migration: missing relation or column: x'); return s; },
      client: () => ({ unsafe: async (q: string) => { queries.push(q); return q.includes('retry') ? [{ value: 'boolean' }] : []; }, end: async () => {} }),
    });
    lab.scope(['orders.archived.type', 'orders.amount.type']);
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['setting:orders.archived.type']);
    expect(r.after.settings['orders.archived.type']).toBe('boolean');
    // Only the timed-out key is retried, once.
    expect(queries.filter(q => q.includes('retry'))).toHaveLength(1);
    expect(r.after.errors.some(e => e.startsWith('scenario key orders.archived.type:'))).toBe(false);
    expect(r.notes.join(' ')).toMatch(/orders.archived.type read again after a timeout/);
  });
  test('a key read error that is not a missing object is read once more after 5 s; a connection error that stays is marked', async () => {
    for (const [err, retryOk, expectErr] of [
      ['terminating connection due to administrator command', true, null],
      ['the database system is starting up', false, /^scenario key orders.archived.type: after retry: connection: /],
      ['expected before migration: missing relation or column: relation "orders" does not exist', true, /expected before migration/],
    ] as const) {
      const log: string[] = [];
      const base = deps(log);
      const queries: string[] = [];
      const sleeps: number[] = [];
      const lab = new RealLab(host, { ...base, sleep: async (ms) => { sleeps.push(ms); },
        collect: async (c, o) => { const s = await base.collect(c, o); if (o?.baseline) s.errors.push(`scenario key orders.archived.type: ${err}`); return s; },
        client: () => ({ unsafe: async (q: string) => { queries.push(q); if (!q.includes('retry')) return []; if (retryOk) return [{ value: 'boolean' }]; throw new Error('the database system is starting up'); }, end: async () => {} }),
      });
      lab.scope(['orders.archived.type']);
      await lab.open();
      const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['setting:orders.archived.type']);
      const retried = !err.startsWith('expected before migration');
      expect(queries.filter(q => q.includes('retry'))).toHaveLength(retried ? 1 : 0);
      if (retried) expect(sleeps).toContain(5000);
      const e = r.after.errors.find(x => x.startsWith('scenario key orders.archived.type:'));
      if (expectErr) expect(e).toMatch(expectErr); else { expect(e).toBeUndefined(); expect(r.after.settings['orders.archived.type']).toBe('boolean'); }
    }
  });
  test('cr_start_epoch and harness intervals come from the Actor (VM clock)', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, applyCR: async (c, t, o) => ({ ...(await base.applyCR(c, t, o)), cr_start_epoch: 1234.5, harness_intervals: [{ start_s: 1240, end_s: 1300, why: 'restart.sh primary' }] }) });
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['p99_ms']);
    expect(r.after.cr_start_epoch).toBe(1234.5);
    expect(r.after.harness_intervals).toEqual([{ start_s: 1240, end_s: 1300, why: 'restart.sh primary' }]);
  });
  test('on the outer timeout the harness aborts the Actor, kills the remote workload and injector, and verifies the VM is clean', async () => {
    for (const dirty of [false, true]) {
      const log: string[] = [];
      const base = deps(log);
      let signal: AbortSignal | undefined;
      const lab = new RealLab(host, { ...base, workloadTimeoutMs: () => 5,
        applyCR: async (c, t, o) => { signal = o?.signal; await new Promise(r => setTimeout(r, 30)); return base.applyCR(c, t, o); },
        run: async (ip, cmd) => {
          if (cmd.includes('w_prod.sh')&& !cmd.includes('pkill') && !cmd.includes('pgrep')) return new Promise<never>(() => {});
          log.push(`host ${cmd}`);
          if (cmd.includes('pgrep')) return { stdout: dirty ? '1 0\n' : '0 0\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        client: () => ({ unsafe: async (q: string) => { log.push(`sql ${q}`); return q.includes('count(*)') ? [{ n: 0 }] : []; }, end: async () => {} }),
      });
      await lab.open();
      const p = lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['p99_ms']);
      if (dirty) await expect(p).rejects.toBeInstanceOf(VMDirtyError);
      else await expect(p).rejects.toMatchObject({ reason: 'harness:workload_timeout' });
      expect(signal?.aborted).toBe(true);
      expect(log.some(l => l.startsWith('host ') && l.includes('pkill -f') && l.includes('docker rm -f') && l.includes('label=pgaibench-wl'))).toBe(true);
      expect(log.some(l => l.startsWith('sql ') && l.includes('pg_terminate_backend') && l.includes('pgaibench-injector'))).toBe(true);
      expect(log.some(l => l.startsWith('host ') && l.includes('pgrep'))).toBe(true);
    }
  });
  test('without a post window integrity and backup verify stay in the after-change collection', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl', ['p99_ms']);
    expect(log.filter(l => l.startsWith('collect ') && l.includes('s=1 ') && l.includes('base=y')).some(l => l.includes('integrity=true backup=true'))).toBe(true);
  });
  test('scenario success on tps_post and a shape shares one 300-second post window', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'C13';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['tps_post', 'shape_post_p50_ms:q07']);
    expect(log.filter(l => l.startsWith('host ')).map(l => l.split(' ')[2])).toEqual(['180', '300']);
    expect(r.after.metrics.tps_post).toBe(500);
    expect(r.after.metrics['shape_post_p50_ms:q07']).toBe(3);
    expect(r.notes.join(' ')).toMatch(/post window 300 s/);
  });
  test('scenario without post metrics runs no post window', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'L9';
    await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl', ['p99_ms']);
    expect(log.filter(l => l.startsWith('host '))).toHaveLength(1);
  });
  test('T6 measures checkpoints in a 360-second window after the Actor', async () => {
    const log: string[] = [];
    const base = deps(log);
    let count = 0;
    const lab = new RealLab(host, { ...base, collect: async (c, o) => {
      const s = await base.collect(c, o);
      s.stats.pg_stat_checkpointer = [{ num_requested: count++, num_timed: 0 }];
      return s;
    } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'T6';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(log).toContain('host /opt/pgaibench/env/workload/w_prod.sh 360 W_prod 5432');
    expect(log.findIndex(x => x.startsWith('apply production'))).toBeLessThan(log.findIndex(x => x.includes('w_prod.sh 360')));
    expect(r.after.metrics.checkpoints_window_count).toBeGreaterThanOrEqual(1);
  });
  test.each(['T6', 'T9'])('%s retains first-window harm for the oracle', async task => {
    const log: string[] = [];
    const base = deps(log);
    let n = 0;
    let workloads = 0;
    const lab = new RealLab(host, { ...base, run: async (ip, cmd) => {
      const result = await base.run(ip, cmd);
      if (++workloads === 1) result.stdout = JSON.stringify({ ...summary, overall: { ...summary.overall, p99_ms: 40 } });
      return result;
    }, collect: async (c, o) => {
      const s = await base.collect(c, o);
      s.replication.lag_s = [0];
      if (++n === 2) {
        s.replication.lag_s = [45];
        s.resources.io_samples = [{ at: '2026-11-03T00:00:00Z', util_pct: 95, seconds: 60 }];
        s.metrics.max_lock_wait_s = 9;
        s.errors = ['first-window error'];
      }
      if (n === 3) { s.metrics.downtime_s = 3; s.replication.cancellations = 2; }
      return s;
    } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = task;
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(evaluateOracle(snapshot(), r.after, fixtureTask, fixtureCR()).replication.fired).toBe(true);
    expect(r.after.replication.lag_s).toContain(45);
    expect(r.after.resources.io_samples).toContainEqual(expect.objectContaining({ util_pct: 95 }));
    expect(r.after.metrics.max_lock_wait_s).toBe(9);
    expect(r.after.replication.cancellations).toBe(2);
    expect(r.after.errors).toContain('window first-window error');
    expect(r.after.metrics.downtime_s).toBe(3);
    expect(r.after.metrics.actor_window_p99_ms).toBe(40);
    expect(r.after.latency.p99_ms).toBe(40);
  });
  test.each(['T6', 'T9'])('%s keeps OOM kills unavailable when both windows are unavailable', async task => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, collect: async (c, o) => {
      const s = await base.collect(c, o);
      s.resources.oom_kills = null;
      return s;
    } });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = task;
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(r.after.resources.oom_kills).toBeNull();
  });
  test('T6 post workload failure leaves scored checkpoint metrics unavailable', async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, run: async (ip, cmd) => cmd.includes('w_prod.sh 360')
      ? { stdout: '', stderr: 'failed', exitCode: 1 } : base.run(ip, cmd) });
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'T6';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(r.after.metrics.checkpoints_window_count).toBeNull();
    expect(r.after.errors.join(' ')).toContain('post window workload failed');
  });
  test('T9 uses only post-Actor wait samples', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'T9';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(log.filter(x => x.includes('w_prod.sh 180'))).toHaveLength(2);
    expect(log.findIndex(x => x.startsWith('apply production'))).toBeLessThan(log.findLastIndex(x => x.includes('w_prod.sh 180')));
    expect(r.after.metrics.post_wait_samples).toBe(180);
  });
  test('T2 runs a sampled 60-second post-change window', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const cr = structuredClone(goodCR); cr.task = 'T2';
    const r = await lab.production(cr, snapshot(), 180, '/tmp/a.jsonl');
    expect(log).toContain('host /opt/pgaibench/env/workload/w_prod.sh 60 W_prod 5432');
    expect(log).toContain('collect port=35432 kind=production s=60 standby=35433 base=y integrity=false backup=false');
    expect(r.after.metrics['shape_post_p50_ms:q07']).toBe(3);
  });
  test('warmup runs W_prod for 30 seconds', async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    await lab.warmup(30);
    expect(log).toContain('host /opt/pgaibench/env/workload/w_prod.sh 30 W_prod 5432');
  });

  test("final snapshots carry the Actor's accumulated downtime_s", async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base,
      collect: async (c, o = {}) => { const s = await base.collect(c, o); if (o.downtime_s !== undefined) s.metrics.downtime_s = o.downtime_s; return s; },
      applyCR: async (_cr, _t, o) => ({ steps: [{ ok: true, metrics: {} }], aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath!, downtime_s: 2.78 }),
    });
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, "/tmp/a.jsonl");
    expect(r.after.metrics.downtime_s).toBe(2.78);
    const c = await lab.rehearse(structuredClone(goodCR), { kind: "clone", port: 5501, n: 1, name: "x" }, snapshot(), 60, "/tmp/r.jsonl");
    expect(c.after.metrics.downtime_s).toBe(2.78);
  });
  test("production carries the Actor's restart intervals for tps_collapse", async () => {
    const log: string[] = [];
    const base = deps(log);
    const restarts = [{ node: "primary" as const, start_s: 1012.5, end_s: 1015.9, rollback: false }];
    const lab = new RealLab(host, { ...base,
      applyCR: async (_cr, _t, o) => ({ steps: [{ ok: true, metrics: {} }], aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath!, downtime_s: 3.4, restarts }),
    });
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, "/tmp/a.jsonl");
    expect(r.after.restarts).toEqual(restarts);
  });
  test("production carries standby downtime and per-node settings", async () => {
    const log: string[] = [];
    const base = deps(log);
    const lab = new RealLab(host, { ...base, applyCR: async (_cr, _target, o) => ({
      steps: [{ ok: true, metrics: {}, setting_primary: '128', setting_standby: '128' }],
      aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath!, standby_downtime_s: 1.25,
    }) });
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
    expect(r.after.metrics.standby_downtime_s).toBe(1.25);
    expect(r.actor?.steps[0]).toEqual(expect.objectContaining({ setting_primary: '128', setting_standby: '128' }));
  });
  test("rehearsal record carries rows affected, command tag, expected_rows and skips", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, { ...deps(log), applyCR: async (_cr, _target, o) => ({
      steps: [{ ok: true, metrics: {}, rows_affected: 7, command: 'UPDATE', expected_rows: 5 }, { ok: true, metrics: {}, skipped: 'node=standby has no clone counterpart' }],
      aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath!,
    }) });
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
    expect(r.actor?.steps[0]).toEqual({ ok: true, rows_affected: 7, command: 'UPDATE', expected_rows: 5 });
    expect(r.actor?.steps[1]).toEqual({ ok: true, skipped: 'node=standby has no clone counterpart' });
  });

  test("workload failure is recorded, not fatal", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log, { run: async () => ({ stdout: "", stderr: "pgbench died", exitCode: 1 }) }));
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, "/tmp/a.jsonl");
    expect(r.workload_summary).toBeNull();
    expect(r.notes.join(" ")).toMatch(/pgbench died/);
  });

  test("retains a failed workload's JSON summary and connection errors", async () => {
    const log: string[] = [];
    const failed = { tps: 0, overall: { count: 0 }, shapes: {}, transactions: 0,
      relaunches: 5, aborted_clients: 0, error_lines: ['FATAL:  sorry, too many clients already'],
      statement_errors: { statements: null, classes: [{ key: 'fatal:  sorry, too many clients already', message: 'FATAL:  sorry, too many clients already', count: 6 }] } };
    const lab = new RealLab(host, deps(log, { run: async () => ({ stdout: JSON.stringify(failed), stderr: 'no transactions', exitCode: 1 }) }));
    await lab.open();
    const r = await lab.production(structuredClone(goodCR), snapshot(), 180, '/tmp/a.jsonl');
    expect(r.workload_summary).toMatchObject({ relaunches: 5, error_lines: failed.error_lines });
    expect(r.after.workload_errors?.classes[0]?.count).toBe(6);
    expect(r.notes.join(' ')).toContain('workload failed (exit 1)');
  });

  test("facts: primary over the 5432 tunnel; clone over its own tunnel, closed after", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log, { client: (conn) => ({ unsafe: async (q: string) => { log.push(`sql ${conn.port} ${q.split("\n")[0]}`); return q.startsWith("-- pgaibench-facts views") ? [{ name: "v_orders" }] : []; }, end: async () => { log.push(`end ${conn.port}`); } }) }));
    await lab.open();
    const cr = structuredClone(goodCR);
    expect((await lab.facts(cr)).views).toEqual(["v_orders"]);
    expect(log).toContain("sql 35432 begin transaction read only");
    log.length = 0;
    await lab.facts(cr, { kind: "clone", port: 5501, n: 1, name: "c" });
    expect(log[0]).toBe("tunnel 5501");
    expect(log).toContain("sql 35501 -- pgaibench-facts views");
    expect(log.slice(-2)).toEqual(["end 35501", "tunnel-close 5501"]);
  });
  test("inspect runs context_sql read-only and returns a catalog summary", async () => {
    const log: string[] = [];
    const lab = new RealLab(host, deps(log));
    await lab.open();
    const r = await lab.inspect({ id: "T1", goal: "g", context_sql: ["select 1"], success: [], allowed_changed_tables: [] });
    expect(r.contextResults).toEqual([{ sql: "select 1", result: '{"a":1}' }]);
    expect(log).toContain("sql begin transaction read only");
    expect(r.catalogSummary.length).toBeGreaterThan(0);
  });
});

test("RealLab.scope: every collect call carries the scenario's own keys", async () => {
  const log: string[] = [], seen: (readonly string[] | undefined)[] = [];
  const base = deps(log);
  const lab = new RealLab(host, { ...base, collect: async (c, o) => { seen.push(o?.scenarioKeys); return base.collect(c, o); } });
  lab.scope(["orders.archived.type"]);
  await lab.open();
  await lab.baseline(60);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((k) => k?.join() === "orders.archived.type")).toBe(true);
});

test("N5: mergeWindow keeps lock_wait_epochs aligned with lock_wait_samples", () => {
  const after = snapshot(), window = snapshot();
  window.lock_wait_samples = [0, 2]; window.lock_wait_epochs = [10.3, 11.3];
  after.lock_wait_samples = [0]; after.lock_wait_epochs = [null];
  const m = mergeWindow(after, window, null);
  expect(m.lock_wait_epochs).toEqual([10.3, 11.3, null]);
  const w2 = snapshot(); w2.lock_wait_samples = [1];
  expect(mergeWindow(after, w2, null).lock_wait_epochs).toEqual([null, null]);
});

test("mergeWindow keeps stall_lock_wait_samples aligned; a part without it keeps waits >= 1 s", () => {
  const after = snapshot(), window = snapshot();
  window.lock_wait_samples = [0.4, 2]; window.stall_lock_wait_samples = [0.4, 2];
  after.lock_wait_samples = [0.5, 1.5];
  expect(mergeWindow(after, window, null).stall_lock_wait_samples).toEqual([0.4, 2, 0, 1.5]);
});

test("N7: the Actor gets the change window end (holdOpenUntilMs) for an open transaction at the end", async () => {
  const log: string[] = [];
  let hold: number | undefined;
  const base = deps(log);
  const lab = new RealLab(host, { ...base, applyCR: async (cr, target, o) => { hold = o?.holdOpenUntilMs; return base.applyCR(cr, target, o); } });
  await lab.open();
  const t0 = Date.now();
  await lab.production(goodCR, snapshot(), 180, "/tmp/x.jsonl");
  expect(hold).toBeGreaterThanOrEqual(t0 + 180_000);
  expect(hold).toBeLessThanOrEqual(Date.now() + 180_000);
});

test('earlier mergeWindow keeps stall_sample_server_ms of window and after in order', () => {
  const after = snapshot(), window = snapshot();
  window.stall_sample_server_ms = [1, null]; after.stall_sample_server_ms = [2];
  expect(mergeWindow(after, window, summary).stall_sample_server_ms).toEqual([1, null, 2]);
});
