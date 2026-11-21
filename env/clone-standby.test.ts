import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string, data: string;
const log = () => readFile(join(dir, 'docker.log'), 'utf8');
async function run(script: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(['bash', join(dir, script), ...args], { env: { ...process.env, PATH: dir + ':' + process.env.PATH,
    TEST_DATA: data, LOG: join(dir, 'docker.log'), PGAIBENCH_CLONE_STANDBY: '0', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [exit, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exit, out, err };
}
async function mock(name: string, body: string) {
  await Bun.write(join(dir, name), '#!/usr/bin/env bash\n' + body);
  await chmod(join(dir, name), 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clone-standby-'));
  data = join(dir, 'data');
  for (const script of ['clone.sh', 'restart.sh']) await cp(join(import.meta.dir, script), join(dir, script));
  const lib = await Bun.file(join(import.meta.dir, 'lib.sh')).text();
  await Bun.write(join(dir, 'lib.sh'), lib.replace('readonly DATA=/data', 'readonly DATA="$TEST_DATA"'));
  await mkdir(join(data, 'snap/pg/primary'), { recursive: true });
  await Bun.write(join(data, 'snap/pg/tags.env'), 'PRIMARY_TAG=18.6\n');
  await mock('chown', 'exit 0');
  await mock('install', 'mkdir -p "${@: -1}"');
  // The VM uses GNU cp, while macOS accepts -a.
  await mock('cp', 'if [[ "$1" == --archive ]]; then shift; exec /bin/cp -a "$@"; fi\nexec /bin/cp "$@"');
  await mock('docker', `echo "$*" >> "$LOG"
case "$*" in
  *pg_basebackup*) exit "\${BACKUP_EXIT:-0}" ;;
  *State.Running*) echo "\${RUNNING:-false}" ;;
  *pg_current_wal_lsn*) echo 0/100 ;;
  *pg_stat_replication*) echo 1 ;;
  *pg_last_wal_replay_lsn*) echo t ;;
  *pg_is_wal_replay_paused*) echo f ;;
esac`);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('container_for_port distinguishes both clone ranges and the reserved ports', async () => {
  await Bun.write(join(dir, 'ports.sh'), 'source "$(dirname "$0")/lib.sh"\nfor port; do container_for_port "$port"; done');
  const r = await run('ports.sh', ['5432', '5433', '5501', '5598', '5599', '5601', '5610', '5698']);
  expect(r.out.trim().split('\n')).toEqual(['pgaibench-primary', 'pgaibench-standby', 'pgaibench-clone-1', 'pgaibench-clone-98',
    'pgaibench-verify', 'pgaibench-clone-1-standby', 'pgaibench-clone-10-standby', 'pgaibench-clone-98-standby']);
});

test('snapshot standby is repointed before start, streams from its clone, and stops with it', async () => {
  const snap = join(data, 'snap/pg/standby'), copy = join(data, 'clone/2-standby');
  await mkdir(snap);
  await Bun.write(join(snap, 'PG_VERSION'), '18');
  const config = "primary_conninfo = 'host=127.0.0.1 port=5432 user=postgres'\nwork_mem = '8MB'\n";
  await Bun.write(join(snap, 'postgresql.auto.conf'), config);
  const r = await run('clone.sh', ['start', '2', '--with-standby']);
  expect([r.exit, r.err]).toEqual([0, '']);
  expect(r.out).toMatch(/^clone 2 started port=5502 standby_port=5602 [\d.]+\n$/);
  const auto = await readFile(join(copy, 'postgresql.auto.conf'), 'utf8');
  expect(auto).toContain('port=5502');
  expect(auto).not.toContain('port=5432');
  expect(auto).toContain("work_mem = '8MB'");
  expect(await readFile(join(snap, 'postgresql.auto.conf'), 'utf8')).toBe(config);
  expect((await stat(join(copy, 'standby.signal'))).isFile()).toBe(true);
  const commands = await log();
  const start = commands.split('\n').find(s => s.includes('run --detach --name pgaibench-clone-2-standby'))!;
  for (const arg of ['--network host', '--shm-size 1g', '--label pgaibench.tag=18.6',
    copy + ':/var/lib/postgresql/data', join(data, 'clone/2.archive') + ':/archive:ro',
    join(dir, 'pg/pgaibench.conf') + ':/etc/pgaibench/pgaibench.conf:ro']) expect(start).toContain(arg);
  expect(start).toEndWith('pgaibench-pg:18.6 postgres -c port=5602');
  expect(commands).not.toContain('pg_basebackup');
  expect(commands).toContain('exec pgaibench-clone-2-standby pg_isready --host=127.0.0.1 --port=5602');
  expect(commands).toMatch(/exec pgaibench-clone-2 [^\n]*--port=5502 [^\n]*pg_stat_replication/);
  await Bun.write(join(dir, 'docker.log'), '');
  expect((await run('clone.sh', ['stop', '2'])).out).toBe('clone 2 stopped\n');
  expect((await log()).trim().split('\n')).toEqual(['rm --force pgaibench-clone-2-standby', 'rm --force pgaibench-clone-2']);
  for (const name of ['2', '2.archive', '2-standby']) expect(await stat(join(data, 'clone', name)).catch(() => null)).toBeNull();
});

test('environment opt-in uses a streaming base backup when the snapshot has no standby', async () => {
  const r = await run('clone.sh', ['start', '7'], { PGAIBENCH_CLONE_STANDBY: '1' });
  expect([r.exit, r.err]).toEqual([0, '']);
  expect(r.out).toContain('port=5507 standby_port=5607');
  expect(await log()).toMatch(/pgaibench-pg:18.6 pg_basebackup --host=127.0.0.1 --port=5507 .*--wal-method=stream --checkpoint=fast --write-recovery-conf/);
});

test('a failed base backup cleans both instances and their data', async () => {
  expect((await run('clone.sh', ['start', '7', '--with-standby'], { BACKUP_EXIT: '7' })).exit).toBe(7);
  expect(await stat(join(data, 'clone/7')).catch(() => null)).toBeNull();
  expect(await stat(join(data, 'clone/7-standby')).catch(() => null)).toBeNull();
  expect(await log()).not.toContain('run --detach --name pgaibench-clone-7-standby');
});

test('default start preserves the single-node output and starts only the primary', async () => {
  const r = await run('clone.sh', ['start', '2']);
  expect(r.exit).toBe(0);
  expect(r.out).toMatch(/^clone 2 started port=5502 [\d.]+\n$/);
  expect(await log()).not.toContain('run --detach --name pgaibench-clone-2-standby');
});

test.each(['clone', 'clone-standby'])('restart %s reports readiness then verifies replay on the two clone ports', async target => {
  const r = await run('restart.sh', [target, '2'], { RUNNING: 'true' });
  expect([r.exit, r.err]).toEqual([0, '']);
  const [up, ok] = r.out.trim().split('\n');
  expect(up).toStartWith('restart ' + target + ' up downtime_s=');
  expect(ok).toBe(up!.replace(' up ', ' ok '));
  const commands = await log();
  const container = target === 'clone' ? 'pgaibench-clone-2' : 'pgaibench-clone-2-standby';
  expect(commands).toContain('restart --time 120 ' + container + '\n');
  expect(commands).toContain('exec ' + container + ' pg_isready');
  expect(commands.includes('--command=checkpoint')).toBe(target === 'clone');
  expect(commands).toMatch(/exec pgaibench-clone-2 [^\n]*--port=5502 .*pg_current_wal_lsn/);
  expect(commands).toMatch(/exec pgaibench-clone-2-standby [^\n]*--port=5602 .*pg_last_wal_replay_lsn/);
  expect(commands).not.toMatch(/--port=543[23]/);
});
