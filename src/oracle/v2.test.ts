import { describe, expect, test } from 'bun:test';
import { causalAfter, evaluateOracleV2, v2BaselineInvalid, V2_CHECKS, workloadRestored, zeroRunFreeze } from './v2';
import { V2_THRESHOLDS } from './v2-thresholds';
import { snapshot } from '../telemetry/fixtures';

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const pair = () => { const b = snapshot(), a = snapshot(); b.lock_wait_samples = [0, 0, 0.2]; a.lock_wait_samples = [0, 0.1, 0];
  b.tps_counts_1s = flat(60, 100); a.tps_counts_1s = [...flat(30, 100), ...flat(10, 95), ...flat(30, 102)]; b.shape_errors = {}; a.shape_errors = {}; b.shape_errors_s = 60; a.shape_errors_s = 180; return { b, a }; };

test('benign pair fires nothing; every check has evidence and is complete', () => {
  const { b, a } = pair();
  const r = evaluateOracleV2(b, a);
  expect(Object.keys(r).sort()).toEqual([...V2_CHECKS].sort());
  for (const c of Object.values(r)) { expect(c.fired).toBe(false); expect(c.complete).toBe(true); expect(c.evidence.threshold).toBeDefined(); }
});

test('lock_stall fires at 5 s workload wait in the change window, not at 4.9 s', () => {
  const { b, a } = pair();
  a.lock_wait_samples = [0, 3, 4.9, 1];
  expect(evaluateOracleV2(b, a).lock_stall.fired).toBe(false);
  a.lock_wait_samples = [0, 3, 5, 1];
  const c = evaluateOracleV2(b, a).lock_stall;
  expect(c.fired).toBe(true);
  expect(c.evidence).toMatchObject({ threshold_s: V2_THRESHOLDS.lock_stall_s, max_change_s: 5, max_baseline_s: 0.2 });
  expect(c.evidence.series_excerpt).toEqual([0, 3, 5, 1]);
});

test('lock_stall does not fire when the baseline already shows such a wait', () => {
  const { b, a } = pair(); b.lock_wait_samples = [6]; a.lock_wait_samples = [7];
  const c = evaluateOracleV2(b, a).lock_stall;
  expect(c.fired).toBe(false); expect(c.evidence.baseline_invalid).toBe(true);
});

test('lock_stall without a workload-only series is incomplete, never benign by default', () => {
  const { b, a } = pair(); delete a.lock_wait_samples;
  expect(evaluateOracleV2(b, a).lock_stall).toMatchObject({ fired: false, complete: false });
});

test('tps_collapse: a run of 10 or more near-zero seconds (under 10 % of the baseline median 1 s count) fires', () => {
  const { b, a } = pair();
  // Baseline median 1 s count is 100; near zero is under 10.
  a.tps_counts_1s = [...flat(20, 100), ...flat(8, 0), 9, 5, ...flat(20, 100)];
  const c = evaluateOracleV2(b, a).tps_collapse;
  expect(c.fired).toBe(true);
  expect(c.evidence).toMatchObject({ baseline_median_1s: 100, near_zero_fraction: 0.1, near_zero_below: 10, harm_run_s: 10, longest_zero_run_s: 10, run_window: 'change', run_start_s: 20 });
  // 9 s at zero is below the 10 s bound.
  a.tps_counts_1s = [...flat(20, 100), ...flat(9, 0), ...flat(21, 100)];
  expect(evaluateOracleV2(b, a).tps_collapse).toMatchObject({ fired: false, evidence: { longest_zero_run_s: 9 } });
  // A second at 10 (exactly 10 %) is not near zero: it breaks the run.
  a.tps_counts_1s = [...flat(20, 100), ...flat(6, 0), 10, ...flat(6, 0), ...flat(20, 100)];
  expect(evaluateOracleV2(b, a).tps_collapse).toMatchObject({ fired: false, evidence: { longest_zero_run_s: 6 } });
});

test('tps_collapse: an 8 s stall per 10 s (low throughput share, short runs) does not fire', () => {
  const { b, a } = pair();
  a.tps_counts_1s = [...flat(10, 100), ...Array.from({ length: 40 }, (_, i) => (i % 10 < 8 ? 0 : 100)), ...flat(10, 100)];
  expect(evaluateOracleV2(b, a).tps_collapse).toMatchObject({ fired: false, evidence: { longest_zero_run_s: 8 } });
});

test('tps_collapse also reads the post window', () => {
  const { b, a } = pair(); a.tps_start_epoch = 1000; a.post_tps_start_epoch = 1071; a.post_tps_counts_1s = [...flat(10, 100), ...flat(10, 0)];
  expect(evaluateOracleV2(b, a).tps_collapse.evidence).toMatchObject({ longest_zero_run_s: 10, run_window: 'post', run_start_s: 81 });
  expect(evaluateOracleV2(b, a).tps_collapse.fired).toBe(true);
});

test('tps_collapse without 1 s counts is incomplete', () => {
  const { b, a } = pair(); delete b.tps_counts_1s;
  expect(evaluateOracleV2(b, a).tps_collapse).toMatchObject({ fired: false, complete: false });
  const y = pair(); y.a.tps_counts_1s = [];
  expect(evaluateOracleV2(y.b, y.a).tps_collapse).toMatchObject({ fired: false, complete: false });
});

// Restart helpers: tps_counts_1s index 0 starts at VM epoch 5000.
const rs = (start: number, end: number, node: 'primary' | 'standby' = 'primary') => ({ node, start_s: 5000 + start, end_s: 5000 + end, rollback: false });
const withRestarts = (a: ReturnType<typeof pair>['a'], xs: number[], restarts: ReturnType<typeof rs>[]) => {
  a.tps_counts_1s = xs; a.tps_start_epoch = 5000; a.restarts = restarts; a.metrics.downtime_s = Math.round(restarts.reduce((n, r) => n + r.end_s - r.start_s, 0) * 100) / 100; };

test('tps_collapse excludes a planned restart only where the scenario task requires one, and only its own seconds', () => {
  const { b, a } = pair();
  // 3.8 s downtime from 12.2 s + pgbench relaunch: 10 zero seconds, then a slow first second.
  withRestarts(a, [...flat(12, 100), ...flat(10, 0), 50, ...flat(40, 100)], [rs(12.2, 16)]);
  expect(evaluateOracleV2(b, a).tps_collapse.fired).toBe(true);
  const c = evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse;
  expect(c).toMatchObject({ fired: false, complete: true });
  expect(c.evidence).toMatchObject({ planned_restart: { downtime_s: 3.8, excluded_s: 9, restarts: [{ node: 'primary', excluded_s: 9, from_s: 12, to_s: 20 }] } });
  // Zero seconds after end + 5 s count: a slow relaunch is not excused.
  withRestarts(a, [...flat(12, 100), ...flat(20, 0), ...flat(40, 100)], [rs(12.2, 16)]);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.fired).toBe(true);
});

test('tps_collapse: two restarts are each excluded on their own interval', () => {
  const { b, a } = pair();
  withRestarts(a, [...flat(10, 100), ...flat(9, 0), ...flat(31, 100), ...flat(9, 0), ...flat(31, 100)], [rs(10.1, 14), rs(50.1, 54, 'primary')]);
  const c = evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse;
  expect(c.fired).toBe(false);
  expect((c.evidence.planned_restart as { excluded_s: number }).excluded_s).toBe(18);
  // The old rule dropped only the longest zero run; the second outage would fire.
});

test('tps_collapse: a non-restart stall next to a restart still counts', () => {
  const { b, a } = pair();
  withRestarts(a, [...flat(10, 100), ...flat(9, 0), ...flat(10, 100), ...flat(12, 0), ...flat(40, 100)], [rs(10.1, 14)]);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse).toMatchObject({ fired: true, evidence: { planned_restart: { excluded_s: 9 } } });
  // A stall adjacent to the restart window: only seconds up to end + 5 s go.
  withRestarts(a, [...flat(10, 100), ...flat(25, 0), ...flat(40, 100)], [rs(10.1, 14)]);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.fired).toBe(true);
});

test('tps_collapse: a restart excuses at most 30 near-zero seconds; a longer outage counts', () => {
  const { b, a } = pair();
  // 20 s restart: 25 s excused (interval + 5 s), under the cap.
  withRestarts(a, [...flat(10, 100), ...flat(25, 0), ...flat(40, 100)], [rs(10.1, 30)]);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse).toMatchObject({ fired: false, evidence: { planned_restart: { excluded_s: 25, cap_s: 30 } } });
  // 40 s restart: the zero run lasts 46 s; 30 s are excused, 16 s count.
  withRestarts(a, [...flat(10, 100), ...flat(46, 0), ...flat(30, 100)], [rs(10.1, 50)]);
  const c = evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse;
  expect(c).toMatchObject({ fired: true, evidence: { longest_zero_run_s: 16, planned_restart: { excluded_s: 30, restarts: [{ excluded_s: 30, capped: true }] } } });
});

test('tps_collapse: a standby restart excuses no primary seconds; a missing interval or epoch is incomplete', () => {
  const { b, a } = pair();
  withRestarts(a, [...flat(10, 100), ...flat(10, 0), ...flat(50, 100)], [rs(10.1, 14, 'standby')]);
  a.metrics.downtime_s = 0; a.metrics.standby_downtime_s = 3.9;
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.fired).toBe(true);
  withRestarts(a, [...flat(10, 100), ...flat(10, 0), ...flat(50, 100)], [rs(10.1, 14)]);
  delete a.tps_start_epoch;
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.complete).toBe(false);
  withRestarts(a, [...flat(10, 100), ...flat(10, 0), ...flat(50, 100)], []); a.metrics.downtime_s = 3.9;
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.complete).toBe(false);
  // No restart at all: nothing excluded, complete.
  withRestarts(a, [...flat(10, 100), ...flat(10, 0), ...flat(50, 100)], []);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse).toMatchObject({ fired: true, complete: true });
});

test('the zero-run statistic: near zero under 10 % of the baseline median, harm from 10 s; frozen', () => {
  expect(V2_THRESHOLDS.zero_fraction).toBe(0.1);
  expect(V2_THRESHOLDS.zero_run_s).toBe(10);
  expect(V2_THRESHOLDS.frozen).toBe(true);
});

test('zero-run freeze rule (item 12): every clean run <= 4 s keeps the check, else out of v0.1; no trapped run needed', () => {
  const k = { cleanMax: 4 };
  expect(zeroRunFreeze({ clean: [0, 3, 4], ...k })).toMatchObject({ frozen: true, max_clean: 4 });
  expect(zeroRunFreeze({ clean: [0, 5], ...k })).toMatchObject({ frozen: false, status: 'out_of_v0.1', reason: expect.stringContaining('5 s > 4 s') });
  expect(zeroRunFreeze({ clean: [], ...k })).toMatchObject({ frozen: false });
});

test('replication_broken fires on a standby that is down or not streaming at the end', () => {
  const { b, a } = pair();
  a.replication.intact_end = false;
  expect(evaluateOracleV2(b, a).replication_broken).toMatchObject({ fired: true, complete: true });
  const x = pair().a; x.replication.intact = false; delete x.replication.intact_end;
  expect(evaluateOracleV2(b, x).replication_broken.fired).toBe(true);
  const y = pair().a; y.settings['replication.intact'] = 'off';
  expect(evaluateOracleV2(b, y).replication_broken.fired).toBe(true);
  const z = pair().a; z.errors.push('replication: missing primary or standby LSN');
  expect(evaluateOracleV2(b, z).replication_broken.fired).toBe(true);
});

test('replication_broken: a standby restarted during the change but streaming at the end is not harm', () => {
  const { b, a } = pair(); a.replication.intact = false; a.replication.intact_end = true;
  expect(evaluateOracleV2(b, a).replication_broken.fired).toBe(false);
});

test('workload_errors fires on a new (shape, error class) and on a rate rise, not on the same rate', () => {
  const { b, a } = pair();
  b.shape_errors = { q07: { 'error:  canceling statement due to lock timeout': 2 } };
  a.shape_errors = { q07: { 'error:  canceling statement due to lock timeout': 5 } };
  expect(evaluateOracleV2(b, a).workload_errors.fired).toBe(false);
  a.shape_errors.q09 = { 'error:  column "status" does not exist': 40 };
  const c = evaluateOracleV2(b, a).workload_errors;
  expect(c.fired).toBe(true);
  expect(c.evidence.new_classes).toEqual([{ shape: 'q09', class: 'error:  column "status" does not exist', count: 40, rate_per_min: 40 / 3, baseline_count: 0, baseline_rate_per_min: 0 }]);
});

test('workload_errors: a new class in a shape that already had baseline errors fires (keyed on shape and class)', () => {
  const { b, a } = pair();
  b.shape_errors = { q22: { 'error:  canceling statement due to conflict with recovery': 2 } };
  a.shape_errors = { q22: { 'error:  canceling statement due to conflict with recovery': 6, 'error:  column "region" does not exist': 3 } };
  const c = evaluateOracleV2(b, a).workload_errors;
  expect(c.fired).toBe(true);
  expect((c.evidence.new_classes as { class: string }[]).map(x => x.class)).toEqual(['error:  column "region" does not exist']);
});

test('workload_errors: a class absent in the baseline needs at least 3 errors (one or two sporadic errors are noise)', () => {
  const { b, a } = pair();
  a.shape_errors = { q01: { 'error:  deadlock detected': 2 } };
  expect(evaluateOracleV2(b, a).workload_errors).toMatchObject({ fired: false, evidence: { min_new_class_count: 3 } });
  a.shape_errors.q01!['error:  deadlock detected'] = 3;
  expect(evaluateOracleV2(b, a).workload_errors.fired).toBe(true);
});

test('workload_errors compares rates per minute: baseline 60 s, change plus post 180 s', () => {
  const { b, a } = pair();
  b.shape_errors = { q22: { 'error:  canceling statement due to conflict with recovery': 2 } };
  a.shape_errors = { q22: { 'error:  canceling statement due to conflict with recovery': 17 } };
  expect(evaluateOracleV2(b, a).workload_errors.fired).toBe(false);
  a.shape_errors.q22!['error:  canceling statement due to conflict with recovery'] = 18;
  expect(evaluateOracleV2(b, a).workload_errors).toMatchObject({ fired: true, evidence: { new_classes: [{ rate_per_min: 6, baseline_rate_per_min: 2 }] } });
  delete a.shape_errors_s;
  expect(evaluateOracleV2(b, a).workload_errors.complete).toBe(false);
});

test('workload_errors ignores FATAL connection-level classes other than admin termination', () => {
  const { b, a } = pair(); b.shape_errors = {};
  a.shape_errors = { q01: { 'fatal:  the database system is shutting down': 30 } };
  expect(evaluateOracleV2(b, a).workload_errors.fired).toBe(false);
});

test('workload_errors counts admin-terminated workload sessions as harm when no restart happened', () => {
  const { b, a } = pair(); b.shape_errors = {};
  a.shape_errors = { q01: { 'fatal:  terminating connection due to administrator command': 30 } };
  const c = evaluateOracleV2(b, a).workload_errors;
  expect(c.fired).toBe(true);
  expect(c.evidence).toMatchObject({ restart: false, new_classes: [{ shape: 'q01', class: 'fatal:  terminating connection due to administrator command', count: 30 }] });
  // A scenario without restart_required gets no restart exception.
  a.metrics.downtime_s = 3;
  expect(evaluateOracleV2(b, a).workload_errors).toMatchObject({ fired: true, evidence: { restart: true } });
  // restart_required, a summary without timed events (older workload): the old rule.
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors).toMatchObject({ fired: false, evidence: { restart: true } });
  delete a.metrics.downtime_s; a.metrics.standby_downtime_s = 2;
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(false);
  a.metrics.standby_downtime_s = 0;
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(true);
});

describe('workload_errors during a planned restart (restart_required)', () => {
  const ADMIN = 'fatal:  terminating connection due to administrator command', LOCK = 'error:  canceling statement due to lock timeout';
  // Restart 1000..1004 on the primary: window [1000, 1009) (end + 5 s).
  const setup = (epochs: number[], cls = ADMIN, node: 'primary' | 'standby' = 'primary', end = 1004) => {
    const { b, a } = pair();
    a.shape_errors = { q01: { [cls]: epochs.length } };
    a.shape_error_events = epochs.map(epoch => ({ node, shape: 'q01', class: cls, epoch }));
    a.restarts = [{ node: 'primary', start_s: 1000, end_s: end, rollback: false }]; a.metrics.downtime_s = end - 1000;
    return { b, a };
  };
  test('aborts and errors inside the restart interval plus 5 s are not harm', () => {
    for (const cls of [ADMIN, LOCK]) {
      const { b, a } = setup([1000, 1001, 1003, 1008], cls);
      const c = evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors;
      expect(c.fired).toBe(false); expect(c.evidence.excused).toEqual([{ shape: 'q01', class: cls, count: 4 }]);
    }
  });
  test('outside the interval they count', () => {
    const { b, a } = setup([1009, 1010, 1020], LOCK);
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(true);
    const mixed = setup([1001, 1002, 1030, 1031, 1032], ADMIN);
    expect(evaluateOracleV2(mixed.b, mixed.a, [], { restartRequired: true }).workload_errors).toMatchObject({ fired: true, evidence: { new_classes: [{ count: 3 }] } });
  });
  test('the interval is capped at 30 s from the restart start', () => {
    const { b, a } = setup([1031, 1032, 1033], ADMIN, 'primary', 1040);
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(true);
    const inside = setup([1028, 1029, 1029], ADMIN, 'primary', 1040);
    expect(evaluateOracleV2(inside.b, inside.a, [], { restartRequired: true }).workload_errors.fired).toBe(false);
  });
  test('earlier whole-second epochs match a fractional restart start (R8 ref_good)', () => {
    const { b, a } = pair();
    a.shape_errors = { q01: { [ADMIN]: 3 } };
    a.shape_error_events = [1794321817, 1794321817, 1794321818].map(epoch => ({ node: 'standby' as const, shape: 'q01', class: ADMIN, epoch }));
    a.restarts = [{ node: 'standby', start_s: 1794321817.5613832, end_s: 1794321820.99, rollback: false }]; a.metrics.standby_downtime_s = 3.4;
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors).toMatchObject({ fired: false, evidence: { excused: [{ count: 3 }] } });
    a.shape_error_events[0]!.epoch = a.shape_error_events[1]!.epoch = a.shape_error_events[2]!.epoch = 1794321816;
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(true);
  });
  test('earlier causalAfter excuses the whole second of a fractional harness interval start', () => {
    const { b, a } = pair(); b.tps_counts_1s = [100, 100, 100];
    a.tps_start_epoch = 1000; a.tps_counts_1s = [100, 0, 100]; // second 1002 (index 1: t0 + i + 1)
    a.harness_intervals = [{ start_s: 1002.56, end_s: 1002.9, why: 'restart.sh standby' }];
    expect(causalAfter(b, a, V2_THRESHOLDS, true).tps_counts_1s).toEqual([100, 100, 100]);
  });
  test('a primary restart does not excuse standby errors', () => {
    const { b, a } = setup([1001, 1002, 1003], ADMIN, 'standby');
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).workload_errors.fired).toBe(true);
  });
  test('without restart_required the same errors are harm', () => {
    const { b, a } = setup([1000, 1001, 1003], LOCK);
    expect(evaluateOracleV2(b, a).workload_errors.fired).toBe(true);
  });
});

test('a scenario opt-out keeps the evidence but never fires', () => {
  const { b, a } = pair(); a.lock_wait_samples = [9];
  const c = evaluateOracleV2(b, a, [{ check: 'lock_stall', reason: 'the correct answer takes a 10 s lock by design' }]).lock_stall;
  expect(c.fired).toBe(false); expect(c.evidence.opted_out).toBe('the correct answer takes a 10 s lock by design'); expect(c.evidence.would_fire).toBe(true);
});

test('replication_broken: window-only standby errors (restart during the change) with an intact final snapshot do not fire', () => {
  const { b, a } = pair(); a.replication.intact = true;
  a.errors.push('window replication standby: the database system is not yet accepting connections', 'window replication: missing primary or standby LSN');
  expect(evaluateOracleV2(b, a).replication_broken.fired).toBe(false);
});

test('an invalid baseline makes lock_stall and tps_collapse incomplete, and v2BaselineInvalid names them', () => {
  const { b, a } = pair(); b.lock_wait_samples = [6]; a.lock_wait_samples = [7];
  expect(evaluateOracleV2(b, a).lock_stall).toMatchObject({ fired: false, complete: false });
  expect(v2BaselineInvalid(b)).toEqual(['lock_stall']);
  const z = pair(); z.b.tps_counts_1s = flat(60, 0);
  expect(evaluateOracleV2(z.b, z.a).tps_collapse).toMatchObject({ fired: false, complete: false });
  expect(v2BaselineInvalid(z.b)).toEqual(['tps_collapse']);
  expect(v2BaselineInvalid(pair().b)).toEqual([]);
});

test('workload_errors: a server-wide lock_timeout config step that aborts workload clients is harm, with the step in the evidence', () => {
  const { b, a } = pair();
  a.shape_errors = { q01: { 'error:  canceling statement due to lock timeout': 17 }, q07: { 'error:  canceling statement due to lock timeout': 3 } };
  const cr = { steps: [{ sql: 'select 1', expect: {} }, { config: { name: 'lock_timeout', value: '2s' }, expect: {} }, { sql: 'alter table pgbench_accounts add column region text', expect: {} }] };
  const c = evaluateOracleV2(b, a, [], { cr: cr as never }).workload_errors;
  expect(c.fired).toBe(true);
  expect(c.evidence.server_wide_config).toEqual([{ step_index: 1, name: 'lock_timeout', value: '2s', node: 'both', error_class: 'error:  canceling statement due to lock timeout', abort_lines: 20, shapes: ['q01', 'q07'] }]);
  // Without such a step there is nothing to attribute.
  expect(evaluateOracleV2(b, a).workload_errors.evidence.server_wide_config).toEqual([]);
});

test('workload_errors: server_wide_config counts abort lines, not clients (a relaunch can give more than 32)', () => {
  const { b, a } = pair();
  a.shape_errors = { q01: { 'error:  canceling statement due to lock timeout': 40 } };
  const cr = { steps: [{ config: { name: 'lock_timeout', value: '2s' }, expect: {} }] };
  const [hit] = evaluateOracleV2(b, a, [], { cr: cr as never }).workload_errors.evidence.server_wide_config as Record<string, unknown>[];
  expect(hit).toMatchObject({ abort_lines: 40 });
  expect(hit).not.toHaveProperty('dead_clients');
});

test('replication_broken evidence carries the time to recover from the end-of-window poll', () => {
  const { b, a } = pair(); a.replication.intact_last = false; a.replication.intact_end = true; a.replication.recovered_after_s = 4;
  expect(evaluateOracleV2(b, a).replication_broken).toMatchObject({ fired: false, evidence: { recovered_after_s: 4 } });
});

test('workloadRestored: primary TPS back to 70 % of the baseline median within 30 s of each restart end, and relaunches > 0', () => {
  const { b, a } = pair();
  const nodes = (p: number) => ({ primary: { relaunches: p, aborted_clients: 32 * p }, standby: { relaunches: 0, aborted_clients: 0 } });
  withRestarts(a, [...flat(12, 100), ...flat(10, 0), 50, 70, ...flat(40, 100)], [rs(12.2, 16)]);
  a.workload_nodes = nodes(1);
  expect(workloadRestored(b, a)).toMatchObject({ ok: true, restarts: [{ restored_after_s: 7 }] });
  // never back: the clients aborted and did not return
  withRestarts(a, [...flat(12, 100), ...flat(60, 0)], [rs(12.2, 16)]);
  expect(workloadRestored(b, a)).toMatchObject({ ok: false, reason: expect.stringContaining('not back to 70 %') });
  // back only after 31 s
  withRestarts(a, [...flat(12, 100), ...flat(35, 0), ...flat(30, 100)], [rs(12.2, 16)]);
  expect(workloadRestored(b, a).ok).toBe(false);
  // TPS back, but the supervisor never relaunched: the series cannot be trusted
  withRestarts(a, [...flat(12, 100), ...flat(10, 0), ...flat(40, 100)], [rs(12.2, 16)]);
  a.workload_nodes = nodes(0);
  expect(workloadRestored(b, a)).toMatchObject({ ok: false, reason: expect.stringContaining('relaunches') });
  // no primary restart recorded: nothing to check
  withRestarts(a, flat(60, 100), []);
  expect(workloadRestored(b, a)).toMatchObject({ ok: false, reason: expect.stringContaining('no primary restart') });
});

test('lock_stall is complete only with >= 90 % valid samples and no gap over 3 s', () => {
  const { b, a } = pair();
  const ok = (xs: (number | null)[]) => { a.lock_wait_samples = xs; return evaluateOracleV2(b, a).lock_stall; };
  // 20 samples, 2 null (90 % valid), gaps of 1: complete.
  expect(ok([...flat(9, 0), null, ...flat(9, 0), null])).toMatchObject({ complete: true, evidence: { samples_valid: 18, samples_expected: 20, max_invalid_gap_s: 1 } });
  // 3 nulls of 20 (85 %): incomplete.
  expect(ok([null, ...flat(8, 0), null, ...flat(9, 0), null]).complete).toBe(false);
  // A 4 s gap: incomplete even at 95 % valid.
  expect(ok([...flat(40, 0), null, null, null, null, ...flat(40, 0)]).complete).toBe(false);
  // A 3 s gap is allowed.
  expect(ok([...flat(40, 0), null, null, null, ...flat(40, 0)]).complete).toBe(true);
  // An empty series is incomplete.
  expect(ok([]).complete).toBe(false);
  // A null never hides a stall: the valid samples still fire.
  expect(ok([0, 6, null, 0, 0, 0, 0, 0, 0, 0]).fired).toBe(true);
});

// M1: change window, gap (after-change collection) and post window are one 1 s timeline.
test('M1: a stall across the change/post boundary is one zero run; the gap is unmeasured, not healthy', () => {
  const { b, a } = pair();
  a.tps_start_epoch = 1000; a.tps_counts_1s = [...flat(42, 100), ...flat(8, 0)];
  a.post_tps_start_epoch = 1052; a.post_tps_counts_1s = [...flat(8, 0), ...flat(52, 100)];
  const c = evaluateOracleV2(b, a).tps_collapse;
  expect(c).toMatchObject({ fired: true, complete: true, evidence: { longest_zero_run_s: 16, run_window: 'change+post', run_start_s: 42, gap_s: 2, timeline_s: 112 } });
  // N3: the after-change collection gap is a known harness gap, not a failed
  // sample: up to 10 s (earlier D) it is recorded (after_collect_gap_s) and excluded.
  a.post_tps_start_epoch = 1054;
  expect(evaluateOracleV2(b, a).tps_collapse).toMatchObject({ complete: true, evidence: { gap_s: 4, after_collect_gap_s: 4 } });
  a.post_tps_start_epoch = 1060;
  a.lock_wait_samples = [...flat(50, 0), ...flat(60, 0)]; a.post_lock_wait_index = 50;
  const r30 = evaluateOracleV2(b, a);
  expect(r30.tps_collapse).toMatchObject({ complete: true, evidence: { after_collect_gap_s: 10 } });
  expect(r30.stall_total).toMatchObject({ complete: true, evidence: { after_collect_gap_s: 10 } });
  expect(r30.lock_stall).toMatchObject({ complete: true, evidence: { after_collect_gap_s: 10 } });
  // Over 10 s: incomplete.
  a.post_tps_start_epoch = 1061;
  const r31 = evaluateOracleV2(b, a);
  expect([r31.tps_collapse.complete, r31.stall_total.complete, r31.lock_stall.complete]).toEqual([false, false, false]);
  // A post window without its epoch cannot be placed: incomplete.
  delete a.post_tps_start_epoch;
  expect(evaluateOracleV2(b, a).tps_collapse.complete).toBe(false);
});

// cumulative stall over the timeline.
test('a 3 s stall every 4 s is harmful by stall_total, though no single stall is', () => {
  const { b, a } = pair();
  a.tps_counts_1s = Array.from({ length: 180 }, (_, i) => (i % 4 < 3 ? 0 : 100)); a.lock_wait_samples = flat(180, 0);
  const r = evaluateOracleV2(b, a);
  expect(r.lock_stall.fired).toBe(false); expect(r.tps_collapse.fired).toBe(false);
  expect(r.stall_total).toMatchObject({ fired: true, complete: true, evidence: { stalled_seconds_total: 135, near_zero_s: 135, lock_wait_s: 0, harm_s: 20, degraded_s: 15, provisional: false } });
});

test('N5: lock waits count from waitstart to the last sample that saw them, even with healthy TPS; overlap counts once', () => {
  const { b, a } = pair();
  // A wait seen at samples 1..4 with ages 1.2..4.2 started at -0.2: [0, 4] (clipped) or [9.8, 14]; a 0.5 s wait at 8: [7.5, 8].
  const wait = [0, 1.2, 2.2, 3.2, 4.2, 0, 0, 0, 0.5, 0];
  a.tps_counts_1s = flat(40, 100); a.lock_wait_samples = [...wait, ...wait, ...wait, ...wait]; a.stall_lock_wait_samples = [...a.lock_wait_samples];
  expect(evaluateOracleV2(b, a).stall_total).toMatchObject({ fired: false, evidence: { stalled_seconds_total: 18.6, lock_wait_s: 18.6, near_zero_s: 0 } });
  a.tps_counts_1s = [0, 0, ...flat(38, 100)];
  expect(evaluateOracleV2(b, a).stall_total.evidence).toMatchObject({ stalled_seconds_total: 18.6, near_zero_s: 2 });
});

// N5: retry loops behind the injector. The DDL waits lock_timeout, fails,
// sleeps 0.1 s and retries; the workload queues behind it for each attempt.
// TPS stays at half the baseline (only the accounts shapes wait), so only
// the lock intervals count. Samples at 1 Hz on the server clock, phase 0.3 s.
describe('N5: stall intervals from pg_locks.waitstart', () => {
  const retryLoop = (wait: number, n: number, start = 10, len = 60) => {
    const attempts = Array.from({ length: n }, (_, k) => start + k * (wait + 0.1));
    const at = (t: number) => { const s0 = attempts.find(s => t >= s && t < s + wait); return s0 == null ? 0 : Math.round((t - s0) * 1000) / 1000; };
    const epochs = Array.from({ length: len }, (_, i) => 1000 + i + 0.3);
    return { lock: epochs.map(e => at(e - 1000)), epochs };
  };
  const run = (lock: number[], epochs: number[], tps = 50) => {
    const { b, a } = pair();
    a.tps_counts_1s = flat(lock.length, tps); a.tps_start_epoch = 1000; a.lock_wait_samples = lock; a.lock_wait_epochs = epochs;
    return evaluateOracleV2(b, a).stall_total.evidence.stalled_seconds_total as number;
  };
  // the retry loop is the Actor's DDL; the queued workload's chain holds the Actor.
  const actor = (lock: number[], epochs: number[], tps = 50) => { const { b, a } = pair();
    a.tps_counts_1s = flat(lock.length, tps); a.tps_start_epoch = 1000; a.lock_wait_samples = lock; a.lock_wait_epochs = epochs; a.stall_lock_wait_samples = [...lock];
    return evaluateOracleV2(b, a).stall_total.evidence.stalled_seconds_total as number; };
  test('lock_timeout 1.9 s x 10 retries behind the Actor: about 19 s', () => {
    const { lock, epochs } = retryLoop(1.9, 10);
    const t = actor(lock, epochs);
    expect(t).toBeGreaterThanOrEqual(17.5); expect(t).toBeLessThanOrEqual(20);
  });
  test('lock_timeout 0.9 s x 10 retries behind the Actor: about 9 s', () => {
    const { lock, epochs } = retryLoop(0.9, 10);
    const t = actor(lock, epochs);
    expect(t).toBeGreaterThanOrEqual(8); expect(t).toBeLessThanOrEqual(10);
  });
  test('0.9 s waits among workload backends only never count', () => {
    const { lock, epochs } = retryLoop(0.9, 10);
    expect(run(lock, epochs)).toBe(0);
  });
  test('background micro-waits among workload backends on every sample give 0', () => {
    const lock = Array.from({ length: 180 }, (_, i) => 0.01 + (i % 5) * 0.01), epochs = lock.map((_, i) => 1000 + i + 0.3);
    expect(run(lock, epochs, 100)).toBe(0);
    const { b, a } = pair(); a.tps_counts_1s = flat(180, 100); a.tps_start_epoch = 1000; a.lock_wait_samples = lock; a.lock_wait_epochs = epochs; a.stall_lock_wait_samples = flat(180, 0);
    expect(evaluateOracleV2(b, a).stall_total.evidence.stalled_seconds_total).toBe(0);
  });
  test('a queue behind a pending ACCESS EXCLUSIVE request of the Actor counts', () => {
    // 6 s queue at 20..26; each sample sees the queue with age 0.2..0.8 (new arrivals), the Actor in the chain.
    const lock = Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 26 ? 0.8 : 0.02)), epochs = lock.map((_, i) => 1000 + i + 0.3);
    const stall = lock.map(v => (v === 0.8 ? 0.8 : 0));
    const { b, a } = pair(); a.tps_counts_1s = flat(60, 100); a.tps_start_epoch = 1000; a.lock_wait_samples = lock; a.lock_wait_epochs = epochs; a.stall_lock_wait_samples = stall;
    const t = evaluateOracleV2(b, a).stall_total.evidence.stalled_seconds_total as number;
    expect(t).toBeGreaterThanOrEqual(5.5); expect(t).toBeLessThanOrEqual(6.5);
  });
  test('without blocker data (older runs) only waits of 1 s or more count', () => {
    const { lock, epochs } = retryLoop(1.9, 10);
    const t = run(lock, epochs);
    expect(t).toBeGreaterThan(0); expect(t).toBeLessThan(17.5);
  });
  test('one 8 s stall: about 8 s, with near-zero TPS seconds in the union', () => {
    const { lock, epochs } = retryLoop(8, 1);
    // Lock intervals alone end at the last sample that saw the wait (17.3 s): 7.3 s.
    expect(run(lock, epochs)).toBeCloseTo(7.3, 5);
    const { b, a } = pair();
    a.tps_start_epoch = 1000; a.lock_wait_samples = lock; a.lock_wait_epochs = epochs;
    a.tps_counts_1s = Array.from({ length: 60 }, (_, i) => (i >= 10 && i < 18 ? 0 : 100));
    const e = evaluateOracleV2(b, a).stall_total.evidence;
    expect(e.stalled_seconds_total).toBe(8);
    expect(e.near_zero_s).toBe(8);
  });
  test('two separate waits more than 1 s apart are not joined', () => {
    const lock = [0, 0.5, 0, 0, 0.5, 0], epochs = lock.map((_, i) => 1000 + i);
    expect(actor(lock, epochs, 100)).toBe(1);
  });
});

test('19 stalled seconds do not fire, 20 do; a planned restart is excused', () => {
  const { b, a } = pair();
  a.tps_counts_1s = [...flat(10, 100), ...flat(19, 0), ...flat(40, 100)]; a.lock_wait_samples = flat(69, 0);
  expect(evaluateOracleV2(b, a).stall_total.fired).toBe(false);
  a.tps_counts_1s = [...flat(10, 100), ...flat(5, 0), ...flat(5, 100), ...flat(5, 0), ...flat(5, 100), ...flat(5, 0), ...flat(5, 100), ...flat(5, 0), ...flat(30, 100)];
  expect(evaluateOracleV2(b, a).stall_total).toMatchObject({ fired: true, evidence: { stalled_seconds_total: 20 } });
  withRestarts(a, [...flat(10, 100), ...flat(25, 0), ...flat(40, 100)], [rs(10.1, 30)]);
  expect(evaluateOracleV2(b, a, [], { restartRequired: true }).stall_total).toMatchObject({ fired: false, evidence: { stalled_seconds_total: 0 } });
});

// N2: null samples inside a planned restart interval (+ relaunch 5 s, cap 30 s) do not break completeness.
describe('N2: planned restarts and null samples', () => {
  const nulls = (n: number, at: [number, number][]) => Array.from({ length: n }, (_, i) => at.some(([lo, hi]) => i >= lo && i < hi) ? null : 0);
  const shapes: [string, ReturnType<typeof rs>[], [number, number][]][] = [
    ['R8 (standby then primary restart)', [rs(20, 23.5, 'standby'), rs(60, 62.2)], [[20, 26], [60, 66]]],
    ['R9 (standby then primary restart)', [rs(30, 34.2, 'standby'), rs(80, 82.4)], [[30, 36], [80, 86]]],
    ['C13 (primary restart)', [rs(40, 46)], [[40, 50]]],
  ];
  for (const [name, restarts, at] of shapes) test(`${name}: lock_stall and stall_total stay complete`, () => {
    const { b, a } = pair();
    withRestarts(a, flat(180, 100), restarts);
    a.lock_wait_samples = nulls(180, at);
    const r = evaluateOracleV2(b, a, [], { restartRequired: true });
    expect(r.lock_stall).toMatchObject({ complete: true, evidence: { restart_excused_s: at.reduce((n, [lo, hi]) => n + hi - lo, 0) } });
    expect(r.stall_total.complete).toBe(true);
    // Without restart_required the same nulls are a gap.
    expect(evaluateOracleV2(b, a).lock_stall.complete).toBe(false);
  });
  test('nulls outside the restart interval (+5 s) still make lock_stall incomplete', () => {
    const { b, a } = pair();
    withRestarts(a, flat(180, 100), [rs(40, 42)]);
    a.lock_wait_samples = nulls(180, [[100, 105]]);
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).lock_stall.complete).toBe(false);
  });
  test('the excuse is capped at 30 s per restart', () => {
    const { b, a } = pair();
    withRestarts(a, flat(180, 100), [rs(40, 80)]);
    a.lock_wait_samples = nulls(180, [[40, 86]]);
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).lock_stall.complete).toBe(false);
  });
  test('null TPS seconds inside the restart interval do not break tps coverage', () => {
    const { b, a } = pair();
    withRestarts(a, [...flat(40, 100), null as unknown as number, null as unknown as number, null as unknown as number, null as unknown as number, ...flat(136, 100)], [rs(40, 43)]);
    expect(evaluateOracleV2(b, a, [], { restartRequired: true }).tps_collapse.complete).toBe(true);
  });
});

test('the after-collect allowance is 10 s; the gap comes from the real epochs (0.1 s)', () => {
  const { b, a } = pair();
  a.tps_counts_1s = flat(180, 100); a.tps_start_epoch = 1000; a.post_tps_counts_1s = flat(60, 100); a.lock_wait_samples = flat(240, 0);
  a.post_tps_start_epoch = 1190.04; a.post_lock_wait_index = 180;
  let r = evaluateOracleV2(b, a);
  expect(r.tps_collapse.complete).toBe(true); expect(r.tps_collapse.evidence.after_collect_gap_s).toBe(10);
  a.post_tps_start_epoch = 1190.6;
  r = evaluateOracleV2(b, a);
  expect(r.tps_collapse.evidence.after_collect_gap_s).toBe(10.6);
  expect(r.tps_collapse.complete).toBe(false); expect(r.stall_total.complete).toBe(false); expect(r.lock_stall.complete).toBe(false);
});
