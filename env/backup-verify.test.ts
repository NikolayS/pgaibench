import { expect, test } from 'bun:test';
import { join } from 'node:path';

const lib = join(import.meta.dir, 'lib.sh');

async function run(command: string) {
  const proc = Bun.spawn(['bash', '-c', `set -Eeuo pipefail
IFS=$'\\n\\t'
source '${lib}'
${command}`], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test('recovery settings use the maximum of primary, backup auto.conf, and control data', async () => {
  const r = await run(`pg_val() { printf '%s\\n' max_connections=200 max_locks_per_transaction=256 max_prepared_transactions=32 max_wal_senders=20 max_worker_processes=16; }
backup_recovery_settings() { printf '%s\\n' max_connections=300 max_locks_per_transaction=128 max_prepared_transactions=64 max_wal_senders=10 max_worker_processes=24; }
recovery_settings_args
printf '%s\\n' "\${RECOVERY_ARGS[@]}"`);
  expect(r.code).toBe(0);
  expect(r.stdout.trim().split('\n')).toEqual([
    '-c', 'max_locks_per_transaction=256', '-c', 'max_connections=300',
    '-c', 'max_prepared_transactions=64', '-c', 'max_worker_processes=24',
    '-c', 'max_wal_senders=20',
  ]);
});

test('backup settings read auto.conf and pg_controldata', async () => {
  const r = await run(`dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
printf 'max_connections = 300\\nmax_locks_per_transaction = 512\\n' > "$dir/postgresql.auto.conf"
docker() { cat <<'CONTROL'
max_connections setting: 250
max_prepared_xacts setting: 16
max_locks_per_xact setting: 128
max_wal_senders setting: 10
max_worker_processes setting: 20
CONTROL
}
backup_recovery_settings "$dir" 18.4`);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('max_connections=300');
  expect(r.stdout).toContain('max_connections=250');
  expect(r.stdout).toContain('max_prepared_transactions=16');
  expect(r.stdout).toContain('max_locks_per_transaction=128');
});

test('recovery settings retry doubles each setting', async () => {
  const r = await run(`RECOVERY_ARGS=(-c max_connections=200 -c max_locks_per_transaction=256)
double_recovery_settings_args
printf '%s\\n' "\${RECOVERY_ARGS[@]}"`);
  expect(r.code).toBe(0);
  expect(r.stdout.trim().split('\n')).toEqual(['-c', 'max_connections=400', '-c', 'max_locks_per_transaction=512']);
});

test('recovery settings omit overrides when primary is unavailable', async () => {
  const r = await run(`pg_val() { return 1; }
recovery_settings_args
printf '%s' "\${RECOVERY_ARGS[*]-}"`);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain('using pgaibench.conf without recovery -c overrides');
  expect(r.stdout).toBe('');
});

test('partial primary values warn for each unavailable setting', async () => {
  const r = await run(`pg_val() { printf '%s\\n' max_connections=oops max_locks_per_transaction=256; }
backup_recovery_settings() { :; }
recovery_settings_args
printf '%s\\n' "\${RECOVERY_ARGS[@]}"`);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain('primary max_connections has invalid value');
  expect(r.stderr).toContain('max_connections unavailable from primary and backup');
  expect(r.stderr).toContain('max_wal_senders unavailable from primary and backup');
  expect(r.stdout).toContain('max_locks_per_transaction=256');
  expect(r.stdout).not.toContain('max_connections=');
});

test('backup verify script passes recovery args and retries on parameter stall', async () => {
  const script = await Bun.file(join(import.meta.dir, 'backup-verify.sh')).text();
  expect(script).toContain('recovery_settings_args "${DATA}/backup/base" "${PRIMARY_TAG}"');
  expect(script).toContain('"${RECOVERY_ARGS[@]}"');
  expect(script).toContain('double_recovery_settings_args');
  expect(script).toContain('hot standby is not possible because of insufficient parameter settings');
  expect(script).toContain('recovery paused');
});
