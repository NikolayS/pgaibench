import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'sidecar.sh');

test.each([[], ['10'], ['0', 'c18_lookup', '5432', '8', '15', 'shipping_api'], ['10', 'a/b', '5432', '8', '15', 'r'], ['10', 'c18_lookup', '5432', '0', '15', 'r'], ['10', 'nope', '5432', '8', '15', 'r']].map(args => ({ args })))('rejects bad arguments %p', async ({ args }) => {
  const p = Bun.spawn(['bash', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  expect(await p.exited).toBe(2);
});

// Fake docker run: writes two pgbench aggregate logs (two attempts) into the /out volume.
function fake(lines: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/argv"
out=""; prev=""
for a in "$@"; do if [[ "$prev" == --volume && "$a" == *:/out ]]; then out="\${a%:/out}"; fi; prev="$a"; done
if [[ "$1" == run ]]; then
${lines}
echo 2 > "$out/attempts"
fi
exit 0
`);
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
}

test('merges 1 s aggregate logs of all attempts into one per-second series', async () => {
  // Fake clock: the script reads the start epoch with date +%s; the fake logs use it.
  const dir = fake(`s=$(cat "$out/start_epoch")
printf '%s 100 40000 0 1 900\\n%s 50 20000 0 1 900\\n' "$s" "$((s+1))" > "$out/a0.123"
printf '%s 30 12000 0 1 900\\n' "$((s+1))" > "$out/a0.123.1"
printf '%s 200 80000 0 1 900\\n' "$((s+3))" > "$out/a1.456"`);
  const p = Bun.spawn(['bash', script, '5', 'c18_lookup', '5432', '8', '15', 'shipping_api'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGAIBENCH_TAGS_FILE: '/nonexistent' } });
  const code = await p.exited, out = await new Response(p.stdout).text();
  expect({ code, err: await new Response(p.stderr).text() }).toMatchObject({ code: 0 });
  const j = JSON.parse(out.trim().split('\n').at(-1)!);
  expect(j.version).toBe('sidecar-v1');
  expect(j.shape).toBe('c18_lookup');
  expect(j.tps_counts_1s).toEqual([100, 80, 0, 200, 0]);
  expect(j.mean_ms).toBeCloseTo(152000 / 380 / 1000, 6);
  expect(j.attempts).toBe(2);
  const argv = readFileSync(join(dir, 'argv'), 'utf8');
  for (const s of ['--label pgaibench-wl=sidecar-', '--network host', 'PGAPPNAME=shipping_api', '-M prepared', '-U shipping_api', '--aggregate-interval=1', '-T ', '15']) expect(argv).toContain(s);
});

test('no transaction at all: exit 1, no summary (the check reads incomplete, never harm)', async () => {
  const dir = fake(':');
  const p = Bun.spawn(['bash', script, '5', 'c18_lookup', '5432', '8', '15', 'shipping_api'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  expect(await p.exited).toBe(1);
});

test('C18 shape: one prepared point lookup with both key columns', () => {
  const sql = readFileSync(join(import.meta.dir, 'sidecar', 'c18_lookup.sql'), 'utf8');
  expect(sql).toContain('where shipment_id = :o and customer_id = :c');
  expect(sql).toContain('\\set c 1 + :o % 50000');
});
