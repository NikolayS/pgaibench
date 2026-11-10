import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runSummary(dir: string, seconds = 4): Promise<string> {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const summarize = source.slice(source.indexOf('summarize() {'), source.indexOf('\nmain "$@"'));
  const script = `set -euo pipefail\ntmp="$1"\nerr() { echo "$*" >&2; }\n${summarize}\nsummarize W_prod ${seconds} 5432`;
  const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect([await proc.exited, stderr]).toEqual([0, '']);
  return stdout;
}

test('summary percentiles match the original rank formula at 150 and 7 samples', async () => {
  for (const [count, p50, p99] of [[150, 75, 148], [7, 4, 6]]) {
    const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-percentiles-'));
    try {
      await Bun.write(join(dir, 'names.p'), 'q01\n');
      await Bun.write(join(dir, 'names.s'), '');
      await Bun.write(join(dir, 'p.0.123'), Array.from({ length: count }, (_, i) => `0 ${i + 1} ${(i + 1) * 1000} 0 0 0`).join('\n') + '\n');
      const summary = JSON.parse(await runSummary(dir));
      expect(summary.overall).toMatchObject({ count, p50_ms: p50, p99_ms: p99 });
      expect(summary.shapes.q01).toMatchObject({ count, p50_ms: p50, p99_ms: p99 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('summary reports injector cycles separately from pgbench errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-injector-summary-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), '');
    await Bun.write(join(dir, 'p.0.123'), '0 1 1000 0 0 0\n');
    await Bun.write(join(dir, 'injector.p.cycles'), '2\n');
    await Bun.write(join(dir, 'injector.s.cycles'), '3\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(summary.injector).toEqual({ enabled: true, primary_cycles: 2, standby_cycles: 3 });
    expect(summary).toMatchObject({ failed: 0, aborted_clients: 0, relaunches: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('production and rehearsal menus include target standby reads', async () => {
  for (const menu of ['W_prod.txt', 'W_prod-subset-B.txt']) {
    const lines = await Bun.file(join(import.meta.dir, 'menus', menu)).text();
    for (const shape of ['q25', 'q26']) expect(lines).toMatch(new RegExp(`^${shape} [1-9][0-9]* s$`, 'm'));
    expect(lines).not.toMatch(/^q28 /m);
    const standby = [...lines.matchAll(/^q\d+ (\d+) s$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(standby).toBe(3300);
  }
  expect(await Bun.file(join(import.meta.dir, 'shapes', 'q28.sql')).exists()).toBe(false);
  for (const [shape, table] of [['q25', 'orders'], ['q26', 'events']]) {
    const sql = await Bun.file(join(import.meta.dir, 'shapes', `${shape}.sql`)).text();
    expect(sql).toContain(`/* shape:${shape} */`);
    expect(sql).toContain(table);
  }
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  expect(src).toContain('readonly STANDBY_CLIENTS=8');
  expect(src).not.toContain('q28');
});

test('primary injector: first hold starts before the Actor, then 10 s holds with 2 s gaps for the whole window', async () => {
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  expect(src).toContain('PGAIBENCH_INJECTOR:-on');
  const fn = src.slice(src.indexOf('run_injector() {'), src.indexOf('\n# Print the injector targets'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-injector-cycle-'));
  try {
    await Bun.write(join(dir, 'shapes', 'q23.sql'), 'select 1;\n');
    const script = `set -euo pipefail\ntmp="$1"\nWL_DIR="$1"\nerr() { echo "$*" >&2; }\ncontainer_for_port() { echo c; }\ndocker() { echo "psql $*" >> "$tmp/log"; cat > /dev/null; }\nsleep() { echo "sleep $1" >> "$tmp/log"; SECONDS=$((SECONDS + $1)); }\n${fn}\nSECONDS=0\nrun_injector p 5432 30`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    expect([await proc.exited, await new Response(proc.stderr).text()]).toEqual([0, '']);
    const log = (await Bun.file(join(dir, 'log')).text()).trim().split('\n');
    // Offset 8 s (ACTOR_DELAY_S 10 minus 2): the first hold is 2 s old when the Actor starts.
    expect(log[0]).toBe('sleep 8');
    expect(log.filter(l => l.startsWith('sleep')).slice(1, 5)).toEqual(['sleep 10', 'sleep 2', 'sleep 10', 'sleep 2']);
    expect(log.find(l => l.startsWith('psql'))).toContain('PGAPPNAME=pgaibench-injector');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('injector counts a cycle only when psql succeeded', async () => {
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const fn = src.slice(src.indexOf('run_injector() {'), src.indexOf('\n# Print the injector targets'));
  for (const [rc, expected] of [[0, '18'], [2, '0']] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'pgaibench-injector-rc-'));
    try {
      await Bun.write(join(dir, 'shapes', 'q23.sql'), 'select 1;\n');
      const script = `set -euo pipefail\ntmp="$1"\nWL_DIR="$1"\nerr() { echo "$*" >&2; }\ncontainer_for_port() { echo c; }\ndocker() { cat > /dev/null; return ${rc}; }\nsleep() { SECONDS=$((SECONDS + $1)); }\n${fn}\nSECONDS=0\nrun_injector p 5432 44`;
      const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      expect((await Bun.file(join(dir, 'injector.p.cycles')).text()).trim()).toBe(expected);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('single-attempt summary matches main byte for byte apart from new fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-main-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q02\n');
    await Bun.write(join(dir, 'p.0.123'), '0 1 1000 0 0 0\n0 2 3000 0 0 0\n0 3 5000 0 0 0\n');
    await Bun.write(join(dir, 's.0.123'), '0 1 2000 0 0 0\n0 2 4000 0 0 0\n');
    const actual = await runSummary(dir);
    // Captured from main (6e89a66) with logs named p.123 and s.123.
    // The AWK ternary is parenthesized for the local macOS awk parser.
    const mainSummary = '{"menu":"W_prod","seconds":4,"port":5432,"tps":0.75,"standby_tps":0.50,"transactions":5,"failed":0,"aborted_clients":0,"statement_errors":{"statements":null,"classes":[]},"overall":{"count":5,"mean_ms":3.000,"p50_ms":3.000,"p99_ms":4.000},"shapes":{"q01":{"target":"primary","count":3,"tps":0.75,"mean_ms":3.000,"p50_ms":3.000,"p99_ms":3.000},"q02":{"target":"standby","count":2,"tps":0.50,"mean_ms":3.000,"p50_ms":2.000,"p99_ms":2.000}}}\n';
    expect(actual.replace(/"version":"[^"]*",/, '').replace(/"hung":false,/, '').replace(/,"relaunches":0,"nodes":\{"primary":\{"relaunches":0,"aborted_clients":0\},"standby":\{"relaunches":0,"aborted_clients":0\}\},"error_lines":\[\]/, '').replace(/,"injector":\{"enabled":false,"primary_cycles":0,"standby_cycles":0\}/, '').replace(/,"tps_buckets_10s":\[\],"tps_counts_1s":\[\],"tps_start_epoch":null,"shape_errors":\{\},"shape_error_events":\[\]/, '')).toBe(mainSummary);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('w_prod summarize fails on zero transactions even with SQL errors', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const exitCheck = source.slice(source.indexOf('  if ((total'), source.lastIndexOf('\n  fi\n}') + 5);
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-'));
  try {
    await Bun.write(join(dir, 'p.err'), 'ERROR:  out of shared memory\n');
    const script = `set -euo pipefail\ntmp="$1"\ntotal=0\nfailed=1\nstatement_errors='{"statements":null,"classes":[{"key":"out of shared memory","message":"ERROR:  out of shared memory","count":8}]}'\nerr() { echo "$*" >&2; }\n${exitCheck}`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited, stderr = await new Response(proc.stderr).text();
    expect({ code, stderr }).toMatchObject({ code: 1, stderr: expect.stringContaining('no transactions') });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('w_prod stderr parser ignores restart aborts and accepts server exhaustion', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const parser = source.slice(source.indexOf('  statement_errors="$(', source.indexOf('summarize() {')), source.indexOf('\n\n  local shapes_json'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-errors-'));
  try {
    await Bun.write(join(dir, 'p.0.err'), Array.from({ length: 40 }, (_, i) => `pgbench: error: client ${i} aborted in command 0 of script 0; connection to server was lost`).join('\n') + '\n');
    const parse = async () => {
      const proc = Bun.spawn(['bash', '-c', `set -euo pipefail\ntmp="$1"\n${parser}\necho "$statement_errors"`, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return JSON.parse(stdout);
    };
    expect((await parse()).classes).toEqual([]);
    await Bun.write(join(dir, 'p.0.err'), Array.from({ length: 8 }, () => 'pgbench: error: connection to database failed: FATAL:  sorry, too many clients already').join('\n') + '\n');
    expect((await parse()).classes[0].count).toBe(8);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('supervisor relaunches a failed pgbench with the remaining window', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const supervisor = source.slice(source.indexOf('supervise_pgbench() {'), source.indexOf('\nmain() {'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-supervisor-'));
  try {
    const script = `set -euo pipefail\ntmp="$1"\nrun_pgbench() { echo "$6" >> "$tmp/times"; if [[ ! -e "$tmp/failed" ]]; then touch "$tmp/failed"; echo 'FATAL:  sorry, too many clients already' >&2; return 1; fi; sleep "$6"; }\n${supervisor}\nsupervise_pgbench p 5432 4 1 "$((SECONDS + 3))"`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    expect((await Bun.file(join(dir, 'times')).text()).trim().split('\n')).toEqual(['3', '2']);
    expect((await Bun.file(join(dir, 'p.relaunches')).text()).trim()).toBe('1');
    expect(await Bun.file(join(dir, 'p.0.err')).text()).toContain('FATAL:  sorry, too many clients already');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Fake pgbench for the supervisor: run_pgbench name attempt port clients jobs seconds.
// mode.<name>.<attempt>: run (default; holds its clients for the window),
// restart (every client aborts, pgbench exits 2), hang (every client
// aborts, pgbench stays up), partial (2 clients abort, pgbench stays up).
const fakePgbench = `run_pgbench() {
  local name="$1" attempt="$2" clients="$4" jobs="$5" seconds="$6" mode=run i
  echo "$attempt $clients $jobs $seconds" >> "$tmp/fake.$name"
  [[ -f "$tmp/mode.$name.$attempt" ]] && mode="$(cat "$tmp/mode.$name.$attempt")"
  abort() { for ((i = 0; i < $1; i++)); do echo "pgbench: error: client $i script 0 aborted in command 1 query 0: FATAL:  terminating connection due to administrator command" >&2; done; }
  case "$mode" in
    restart) sleep 0.3; abort "$clients"; return 2 ;;
    hang) sleep 0.3; abort "$clients"; sleep "$seconds" ;;
    partial) sleep 0.3; abort 2; sleep "$seconds" ;;
    locktimeout) sleep 0.3; for ((i = 0; i < clients; i++)); do echo "pgbench: error: client $i script 0 aborted in command 1 query 0: ERROR:  canceling statement due to lock timeout" >&2; done; return 2 ;;
    *) sleep "$seconds" ;;
  esac
}`;
async function supervise(dir: string, body: string, modes: Record<string, string>) {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const supervisor = source.slice(source.indexOf('supervise_pgbench() {'), source.indexOf('\nmain() {'));
  for (const [k, v] of Object.entries(modes)) await Bun.write(join(dir, `mode.${k}`), v);
  const script = `set -euo pipefail\ntmp="$1"\n${fakePgbench}\n${supervisor}\n${body}`;
  const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
  expect([await proc.exited, await new Response(proc.stderr).text()]).toEqual([0, '']);
  const launches = async (name: string) => (await Bun.file(join(dir, `fake.${name}`)).text()).trim().split('\n').map(l => l.split(' ').slice(0, 2).join(' '));
  return { launches };
}

test('after a server restart the supervisor relaunches both the primary and the standby clients', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-restart-'));
  try {
    const { launches } = await supervise(dir, 'd=$((SECONDS + 4)); supervise_pgbench p 5432 4 4 "$d" & supervise_pgbench s 5433 2 2 "$d" & wait',
      { 'p.0': 'restart', 's.0': 'restart' });
    // attempt clients: every client is back after one relaunch per node
    expect(await launches('p')).toEqual(['0 4', '1 4']);
    expect(await launches('s')).toEqual(['0 2', '1 2']);
    expect((await Bun.file(join(dir, 'p.relaunches')).text()).trim()).toBe('1');
    expect((await Bun.file(join(dir, 's.relaunches')).text()).trim()).toBe('1');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('a pgbench whose clients all aborted but that does not exit is not left running alone: the clients are replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-hang-'));
  try {
    const { launches } = await supervise(dir, 'supervise_pgbench p 5432 4 4 "$((SECONDS + 4))"', { 'p.0': 'hang' });
    expect(await launches('p')).toEqual(['0 4', '1 4']);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('aborted clients of a pgbench that keeps running are topped up to the full client count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-partial-'));
  try {
    const { launches } = await supervise(dir, 'supervise_pgbench p 5432 4 4 "$((SECONDS + 4))"', { 'p.0': 'partial' });
    expect(await launches('p')).toEqual(['0 4', '1 2']);
    // jobs never exceed clients (pgbench refuses that)
    expect((await Bun.file(join(dir, 'fake.p')).text()).trim().split('\n')[1]!.split(' ')[2]).toBe('2');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('summary counts relaunches and aborted clients per node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-nodes-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q02\n');
    await Bun.write(join(dir, 'p.0.1'), '0 1 1000 0 0 0\n');
    const abort = (n: number) => Array.from({ length: n }, (_, i) => `pgbench: error: client ${i} script 0 aborted in command 1 query 0: FATAL:  terminating connection due to administrator command\n`).join('');
    await Bun.write(join(dir, 'p.0.err'), abort(32));
    await Bun.write(join(dir, 's.0.err'), abort(8));
    await Bun.write(join(dir, 's.1.err'), abort(8));
    await Bun.write(join(dir, 'p.relaunches'), '1\n');
    await Bun.write(join(dir, 's.relaunches'), '2\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(summary).toMatchObject({ relaunches: 3, aborted_clients: 48,
      nodes: { primary: { relaunches: 1, aborted_clients: 32 }, standby: { relaunches: 2, aborted_clients: 16 } } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary aggregates relaunch logs, aborts, and error classes', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const summarize = source.slice(source.indexOf('summarize() {'), source.indexOf('\nmain "$@"'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-summary-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), '');
    await Bun.write(join(dir, 'p.0.123'), '0 1 1000 0 0 0\n0 2 failed 0 0 0\n');
    await Bun.write(join(dir, 'p.1.123'), '0 1 3000 0 0 0\n');
    await Bun.write(join(dir, 'p.0.err'), 'pgbench: error: client 0 aborted in command 0\nFATAL:  sorry, too many clients already\n');
    await Bun.write(join(dir, 'p.1.err'), 'FATAL:  sorry, too many clients already\n');
    await Bun.write(join(dir, 'p.relaunches'), '1\n');
    const script = `set -euo pipefail\ntmp="$1"\nerr() { echo "$*" >&2; }\n${summarize}\nsummarize W_prod 4 5432`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect([await proc.exited, stderr]).toEqual([0, '']);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({ transactions: 2, failed: 1, tps: 0.5, aborted_clients: 1, relaunches: 1,
      overall: { count: 2, mean_ms: 2, p50_ms: 1, p99_ms: 1 },
      shapes: { q01: { count: 2, tps: 0.5 } } });
    expect(summary.statement_errors.classes).toEqual([{ key: 'fatal:  sorry, too many clients already', message: 'FATAL:  sorry, too many clients already', count: 2 }]);
    expect(summary.error_lines).toContain('FATAL:  sorry, too many clients already');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary keeps the first 50 connection errors when no transaction starts', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const summarize = source.slice(source.indexOf('summarize() {'), source.indexOf('\nmain "$@"'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-refused-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), '');
    await Bun.write(join(dir, 'p.0.err'), Array.from({ length: 60 }, (_, i) => `pgbench: error: connection ${i} failed: FATAL:  sorry, too many clients already`).join('\n') + '\n');
    await Bun.write(join(dir, 'p.relaunches'), '59\n');
    const script = `set -euo pipefail\ntmp="$1"\nerr() { echo "$*" >&2; }\n${summarize}\nsummarize W_prod 60 5432`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('no transactions');
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({ transactions: 0, failed: 0, relaunches: 59 });
    expect(summary.error_lines).toHaveLength(50);
    expect(summary.error_lines[0]).toContain('connection 0 failed');
    expect(summary.error_lines[49]).toContain('connection 49 failed');
    expect(summary.statement_errors.classes[0].count).toBe(60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('big_log keeps zero readers in every workload menu', async () => {
  for (const menu of ['W_prod.txt', 'W_prod-subset-A.txt', 'W_prod-subset-B.txt']) {
    const lines = await Bun.file(join(import.meta.dir, 'menus', menu)).text();
    expect(lines).not.toMatch(/^q27 /m);
  }
  expect(await Bun.file(join(import.meta.dir, 'shapes', 'q27.sql')).exists()).toBe(false);
});

test('injectors read their SQL from the q23 and q24 shape files', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const fn = source.slice(source.indexOf('run_injector() {'), source.indexOf('\n}\n', source.indexOf('run_injector() {')));
  expect(fn).toContain('shapes/q23.sql');
  expect(fn).toContain('shapes/q24.sql');
  expect(fn).not.toMatch(/select (1|pg_sleep)/);
  const q23 = await Bun.file(join(import.meta.dir, 'shapes', 'q23.sql')).text();
  const q24 = await Bun.file(join(import.meta.dir, 'shapes', 'q24.sql')).text();
  expect(q23).toMatch(/begin;/);
  expect(q23).toContain(':"inj_table"');
  expect(q23).not.toMatch(/commit;/);
  expect(q24).toContain('pg_sleep(:inj_idle)');
  expect(q24).toContain(':"inj_table"');
});

test('cleanup kills injector and pgbench process trees and ends injector sessions', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const start = source.indexOf('kill_tree() {');
  const end = source.indexOf('trap cleanup EXIT');
  expect(start).toBeGreaterThan(-1);
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-injector-cleanup-'));
  try {
    const script = `set -Eeuo pipefail
tmp="$1"; log="$2"
err() { echo "$*" >&2; }
container_for_port() { echo "c$1"; }
docker() { echo "docker $*" >> "$log"; }
${source.slice(start, end)}
injector_ports=(5432 5433)
( sleep 300 & sleep 300 & wait ) & injector_pids+=($!)
( sleep 300 ) & injector_pids+=($!)
( sleep 300 & wait ) & worker_pids+=($!)
sleep 0.3
pids="\${injector_pids[*]} \${worker_pids[*]}"
kids="$(for p in \$pids; do pgrep -P "$p" || true; done | tr "\\n" " ")"
[[ -n "$kids" ]] || { echo nokids; exit 1; }
cleanup
for p in \$pids \$kids; do if kill -0 "$p" 2>/dev/null; then echo "alive $p"; exit 1; fi; done
echo ok`;
    const log = join(dir, 'docker.log');
    const inner = join(dir, 'tmp');
    await Bun.write(join(inner, '.keep'), '');
    const proc = Bun.spawn(['bash', '-c', script, 'bash', inner, log], { stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const errText = await new Response(proc.stderr).text();
    expect([code, out.trim(), errText]).toEqual([0, "ok", ""]);
    const calls = await Bun.file(log).text();
    for (const port of ['5432', '5433']) {
      expect(calls).toContain(`exec c${port} `);
    }
    expect(calls).toMatch(/pg_terminate_backend/);
    expect(calls).toMatch(/shape:q2\[34\]/);
    expect(calls).toMatch(/ps --quiet --filter label=pgaibench-wl=[0-9]+/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('standby injector defaults off; primary injector defaults on', async () => {
  const source = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const start = source.indexOf('injector_targets() {');
  expect(start).toBeGreaterThan(-1);
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const run = async (env: Record<string, string>, menu: string, port: string) => {
    const proc = Bun.spawn(['bash', '-c', `set -euo pipefail\nerr() { echo "$*" >&2; }\n${fn}\ninjector_targets "$1" "$2"`, 'bash', menu, port],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', ...env } });
    return [await proc.exited, (await new Response(proc.stdout).text()).trim()];
  };
  expect(await run({}, 'W_prod', '5432')).toEqual([0, 'p']);
  expect(await run({ PGAIBENCH_INJECTOR_STANDBY: 'on' }, 'W_prod', '5432')).toEqual([0, 'p s']);
  expect(await run({ PGAIBENCH_INJECTOR_STANDBY: 'on' }, 'W_prod', '5501')).toEqual([0, 'p']);
  expect(await run({ PGAIBENCH_INJECTOR: 'off', PGAIBENCH_INJECTOR_STANDBY: 'on' }, 'W_prod', '5432')).toEqual([0, '']);
  expect(await run({}, 'synthetic-light', '5432')).toEqual([0, '']);
  expect((await run({ PGAIBENCH_INJECTOR_STANDBY: 'maybe' }, 'W_prod', '5432'))[0]).toBe(2);
});

test('summary gives primary TPS per 10 s bucket from the log epochs, zero buckets included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-buckets-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q02\n');
    await Bun.write(join(dir, 'start_epoch'), '1000\n');
    // 20 txns in bucket 0, none in bucket 1, 5 in bucket 2; a standby txn never counts.
    const p = [...Array.from({ length: 20 }, (_, i) => `0 ${i} 1000 0 ${1000 + (i % 10)} 0`), ...Array.from({ length: 5 }, (_, i) => `1 ${i} 1000 0 1025 0`)];
    await Bun.write(join(dir, 'p.0.1'), p.join('\n') + '\n');
    await Bun.write(join(dir, 's.0.1'), '0 1 1000 0 1012 0\n');
    const summary = JSON.parse(await runSummary(dir, 30));
    expect(summary.tps_buckets_10s).toEqual([2, 0, 0.5]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary gives primary transaction counts per 1 s from the log epochs, zero seconds included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-counts-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q02\n');
    await Bun.write(join(dir, 'start_epoch'), '1000\n');
    await Bun.write(join(dir, 'p.0.1'), ['0 1 1000 0 1000 0', '0 2 1000 0 1000 5', '0 3 failed 0 1001 0', '1 1 1000 0 1003 0', '1 2 1000 0 1009 0'].join('\n') + '\n');
    await Bun.write(join(dir, 's.0.1'), '0 1 1000 0 1001 0\n');
    const summary = JSON.parse(await runSummary(dir, 5));
    expect(summary.tps_counts_1s).toEqual([2, 0, 0, 1, 0]);
    // Index 0 of tps_counts_1s starts at this VM epoch (restart intervals use the same clock).
    expect(summary.tps_start_epoch).toBe(1000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary attributes ERROR abort lines to shapes by target and script number', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-shape-errors-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\nq07\n');
    await Bun.write(join(dir, 'names.s'), 'q20\n');
    await Bun.write(join(dir, 'p.0.1'), '0 1 1000 0 0 0\n');
    await Bun.write(join(dir, 'p.0.err'), [
      'pgbench: error: client 3 script 1 aborted in command 2 query 0: ERROR:  canceling statement due to lock timeout',
      'pgbench: error: client 4 script 1 aborted in command 2 query 0: ERROR:  canceling statement due to lock timeout',
      'pgbench: error: client 5 script 0 aborted in command 0 query 0: FATAL:  terminating connection due to administrator command',
    ].join('\n') + '\n');
    await Bun.write(join(dir, 's.0.err'), 'pgbench: error: client 1 script 0 aborted in command 1 query 0: ERROR:  canceling statement due to conflict with recovery\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(summary.shape_errors).toEqual({
      q07: { 'error:  canceling statement due to lock timeout': 2 },
      q01: { 'fatal:  terminating connection due to administrator command': 1 },
      q20: { 'error:  canceling statement due to conflict with recovery': 1 },
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('injector sessions carry their own application_name so the lock oracle can exclude them', async () => {
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  expect(src).toContain('PGAPPNAME=pgaibench-injector');
  expect(src).toContain('date +%s > "${tmp}/start_epoch"');
});

test('summary carries the workload version stamp the harness expects (WORKLOAD_VERSION)', async () => {
  const { WORKLOAD_VERSION } = await import('../../src/run/lab');
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-version-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q02\n');
    await Bun.write(join(dir, 'p.0.1'), '0 1 1000 0 0 0\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(WORKLOAD_VERSION).toMatch(/^w_prod-/);
    expect(summary.version).toBe(WORKLOAD_VERSION);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a client that aborts on lock timeout is relaunched and its abort is stamped with the time the supervisor saw it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-locktimeout-'));
  try {
    const t0 = Math.floor(Date.now() / 1000);
    const { launches } = await supervise(dir, 'supervise_pgbench p 5432 3 3 "$((SECONDS + 4))"', { 'p.0': 'locktimeout' });
    expect(await launches('p')).toEqual(['0 3', '1 3']);
    const lines = (await Bun.file(join(dir, 'p.aborts')).text()).trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const [epoch, text] = l.split('\t');
      expect(Number(epoch)).toBeGreaterThanOrEqual(t0); expect(Number(epoch)).toBeLessThanOrEqual(t0 + 6);
      expect(text).toContain('ERROR:  canceling statement due to lock timeout');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('summary: lock timeout aborts are counted per abort line across relaunched attempts, with their times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-events-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), 'q20\n');
    await Bun.write(join(dir, 'p.0.1'), '0 1 1000 0 0 0\n');
    const line = (i: number) => `pgbench: error: client ${i} script 0 aborted in command 1 query 0: ERROR:  canceling statement due to lock timeout`;
    // Attempt 0 lost 3 clients, the relaunched attempt 1 lost 2 more: 5 aborts, not the 0 dead clients at the end.
    await Bun.write(join(dir, 'p.0.err'), [0, 1, 2].map(line).join('\n') + '\n');
    await Bun.write(join(dir, 'p.1.err'), [0, 1].map(line).join('\n') + '\n');
    await Bun.write(join(dir, 'p.aborts'), [100, 100, 100, 104, 104].map((e, n) => `${e}\t${line(n)}`).join('\n') + '\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(summary.shape_errors).toEqual({ q01: { 'error:  canceling statement due to lock timeout': 5 } });
    expect(summary.shape_error_events).toEqual([100, 100, 100, 104, 104].map(epoch => ({ node: 'primary', shape: 'q01', class: 'error:  canceling statement due to lock timeout', epoch })));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a large error list reaches the summary (no jq argument list limit)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-bigerr-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), '');
    await Bun.write(join(dir, 'p.0.123'), '0 1 1000 0 0 0\n');
    const n = 30000;
    const line = (i: number) => `pgbench: error: client ${i % 32} script 0 aborted in command 1 query 0: ERROR:  column "status_${i % 997}" of relation "orders" does not exist`;
    await Bun.write(join(dir, 'p.0.err'), Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n');
    await Bun.write(join(dir, 'p.aborts'), Array.from({ length: n }, (_, i) => `${1700000000 + (i % 180)}\t${line(i)}`).join('\n') + '\n');
    const summary = JSON.parse(await runSummary(dir));
    expect(summary.shape_error_events).toHaveLength(n);
    expect(summary.aborted_clients).toBe(n);
    expect(Object.values(summary.shape_errors.q01 as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(n);
    expect(summary.statement_errors.classes.length).toBeGreaterThan(900);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);

test('the watchdog kills a workload whose clients are all blocked, planned time plus grace', async () => {
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const fn = src.slice(src.indexOf('await_workers() {'), src.indexOf('\n# End of await_workers'));
  expect(fn.length).toBeGreaterThan(0);
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-hang-'));
  try {
    // Two "pgbench" processes stuck in COMMIT; kill_workload stands in for docker rm --force.
    const script = `set -euo pipefail\ntmp="$1"\nerr() { echo "$*" >&2; }\nsleep 600 & a=$!\nsleep 600 & b=$!\nkill_workload() { echo killed >> "$tmp/log"; kill $a $b 2>/dev/null || true; }\n${fn}\nSECONDS=0\nawait_workers 1 2 $a $b\necho "done $SECONDS" >> "$tmp/log"`;
    const t0 = Date.now();
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    expect([await proc.exited, await new Response(proc.stderr).text()]).toEqual([0, '']);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect((await Bun.file(join(dir, 'log')).text()).trim().split('\n')[0]).toBe('killed');
    expect(await Bun.file(join(dir, 'hung')).exists()).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('workers that end in time are not killed and leave no hung marker', async () => {
  const src = await Bun.file(join(import.meta.dir, 'w_prod.sh')).text();
  const fn = src.slice(src.indexOf('await_workers() {'), src.indexOf('\n# End of await_workers'));
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-nohang-'));
  try {
    const script = `set -euo pipefail\ntmp="$1"\nerr() { echo "$*" >&2; }\nsleep 1 & a=$!\nkill_workload() { echo killed >> "$tmp/log"; }\n${fn}\nSECONDS=0\nawait_workers 5 30 $a`;
    const proc = Bun.spawn(['bash', '-c', script, 'bash', dir], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(join(dir, 'log')).exists()).toBe(false);
    expect(await Bun.file(join(dir, 'hung')).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

test('a hung window still prints its summary with hung true and the counts so far, even with zero transactions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-wprod-hungsum-'));
  try {
    await Bun.write(join(dir, 'names.p'), 'q01\n');
    await Bun.write(join(dir, 'names.s'), '');
    await Bun.write(join(dir, 'start_epoch'), '1000\n');
    await Bun.write(join(dir, 'hung'), '');
    const summary = JSON.parse(await runSummary(dir, 4));
    expect(summary).toMatchObject({ hung: true, transactions: 0, tps_counts_1s: [0, 0, 0, 0] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
