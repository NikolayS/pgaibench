import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const script = join(import.meta.dir, 'restart.sh');

test.each([[], ['primary', 'extra'], ['standby', 'extra'], ['clone'], ['clone', '0'], ['clone', '99'], ['clone', 'x']].map(args => ({ args })))('restart rejects invalid arguments %p', async ({ args }) => {
  const proc = Bun.spawn(['bash', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain('usage: restart.sh primary|standby|clone <n>');
});

test('replay wait rejects a paused standby with a clear message', async () => {
  const command = `source '${join(import.meta.dir, 'lib.sh')}'
pg_val() { if [[ "$2" == *pg_current_wal_lsn* ]]; then echo '0/100'; elif [[ "$2" == *pg_is_wal_replay_paused* ]]; then echo t; elif [[ "$1" == 5433 ]]; then echo t; else echo 1; fi; }
wait_standby_replay 0`;
  const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('standby did not replay through primary LSN 0/100 within 0s');
});

test('replay wait rejects streaming before replay reaches the target LSN', async () => {
  const command = `source '${join(import.meta.dir, 'lib.sh')}'
pg_val() { if [[ "$2" == *pg_current_wal_lsn* ]]; then echo '0/100'; elif [[ "$2" == *pg_is_wal_replay_paused* ]]; then echo f; elif [[ "$1" == 5433 ]]; then echo f; else echo 1; fi; }
wait_standby_replay 0`;
  const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('streaming/caught_up=1/f');
});

test('replay wait retries an unavailable primary LSN and checks standby replay', async () => {
  const command = `source '${join(import.meta.dir, 'lib.sh')}'
counter=$(mktemp)
trap 'rm -f "$counter"' EXIT
pg_val() {
  if [[ "$2" == *pg_current_wal_lsn* ]]; then
    if [[ ! -s "$counter" ]]; then echo 1 > "$counter"; return 1; fi
    echo '0/100';
  elif [[ "$2" == *pg_is_wal_replay_paused* ]]; then echo f;
  elif [[ "$1" == 5433 && "$2" == *pg_last_wal_replay_lsn* ]]; then echo t;
  else echo 1; fi
}
wait_standby_replay 2`;
  const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(0);
});

test('replay wait reports a primary that stays unavailable', async () => {
  const command = `source '${join(import.meta.dir, 'lib.sh')}'
pg_val() { if [[ "$2" == *pg_current_wal_lsn* ]]; then return 1; fi; echo 0; }
wait_standby_replay 0`;
  const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('primary LSN unavailable');
});

test.each(['primary', 'standby', 'clone 08'])('restart %s propagates docker failure', async target => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-restart-'));
  try {
    const docker = join(dir, 'docker');
    await Bun.write(docker, '#!/usr/bin/env bash\nif [[ "$1" == restart ]]; then exit 7; fi\nexit 0\n');
    await chmod(docker, 0o755);
    const proc = Bun.spawn(['bash', script, ...target.split(' ')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(await proc.exited).toBe(7);
    expect(await new Response(proc.stdout).text()).not.toContain('restart ');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary restart exits nonzero when standby replay never catches up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-restart-'));
  try {
    const docker = join(dir, 'docker');
    await Bun.write(docker, `#!/usr/bin/env bash
case "$*" in
  *pg_current_wal_lsn*) echo 0/100 ;;
  *pg_stat_replication*) echo 1 ;;
  *pg_wal_lsn_diff*) echo f ;;
  *pg_is_wal_replay_paused*) echo f ;;
  *'select 1'*) echo 1 ;;
esac
exit 0
`);
    await chmod(docker, 0o755);
    const command = `sleep() { SECONDS=1000; }; export -f sleep; exec bash '${script}' primary`;
    const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('standby did not replay through primary LSN 0/100');
    expect(await new Response(proc.stdout).text()).not.toContain('restart primary ok');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart prints its start and ready times (VM clock) next to downtime_s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-restart-'));
  try {
    const docker = join(dir, 'docker');
    await Bun.write(docker, '#!/usr/bin/env bash\ncase "$*" in *"select 1"*) echo 1 ;; ps*) echo pgaibench-clone-08 ;; esac\nexit 0\n');
    await chmod(docker, 0o755);
    const proc = Bun.spawn(['bash', script, 'clone', '08'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const out = await new Response(proc.stdout).text();
    expect([await proc.exited, await new Response(proc.stderr).text()]).toEqual([0, '']);
    expect(out).toMatch(/^restart clone ok downtime_s=\S+ start_s=\S+ end_s=\S+\n$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('wait_ready fails within seconds when the container has exited (startup failure)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-restart-'));
  try {
    const docker = join(dir, 'docker');
    await Bun.write(docker, `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then echo exited; exit 0; fi
exit 1
`);
    await chmod(docker, 0o755);
    const t0 = Date.now();
    const proc = Bun.spawn(['bash', '-c', `source '${join(import.meta.dir, 'lib.sh')}'; wait_ready 5501 300`], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(await proc.exited).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await new Response(proc.stderr).text()).toContain('container pgaibench-clone-1 is exited');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

test('wait_ready keeps waiting while the container runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-restart-'));
  try {
    const docker = join(dir, 'docker');
    await Bun.write(docker, `#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then echo running; exit 0; fi
exit 1
`);
    await chmod(docker, 0o755);
    const proc = Bun.spawn(['bash', '-c', `source '${join(import.meta.dir, 'lib.sh')}'; wait_ready 5501 1`], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('not ready after 1s');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);
