import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrityQueries, loadFrozenSlices } from '../src/telemetry/integrity';

// Run env/checksum.sh against a fake docker that logs each psql --command
// and answers like Postgres would. No database is needed.
async function runScript(tables: string[], missing = '') {
  const dir = mkdtempSync(join(tmpdir(), 'checksum-'));
  const log = join(dir, 'queries.log');
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in --command=*) q="\${a#--command=}" ;; esac; done
printf '%s\\n\\0' "$q" >> "${log}"
case "$q" in
  *to_regclass*'is not null'*) echo t ;;
  *pg_attribute*) echo "$FAKE_PRESENT" ;;
  *) echo '5|123' ;;
esac
`);
  chmodSync(join(dir, 'docker'), 0o755);
  const slices = loadFrozenSlices()!;
  const present = tables.flatMap(t => slices[t]?.columns ?? []).filter(c => c !== missing).join(',');
  const p = Bun.spawn(['bash', join(import.meta.dir, 'checksum.sh'), '5432', ...tables], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_PRESENT: present }, stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = [await new Response(p.stdout).text(), await p.exited];
  const queries = readFileSync(log, 'utf8').split('\n\0').filter(Boolean);
  return { out, code, queries };
}

// Remove spelling-only differences: identifier quotes, schema prefix,
// column aliases, text casts on the result columns, whitespace.
const norm = (sql: string) => sql.replace(/^set time zone 'UTC';\s*/, '').replaceAll('"', '').replaceAll('public.', '')
  .replace('count(*)::text as rowcount', 'count(*)').replace(/::text as checksum/, '').replace(/\s+/g, " ").replace(/ ::/g, "::").replace(/\( /g, '(').trim();

test('frozen-slice checksum SQL matches the collector and pins UTC', async () => {
  const slices = loadFrozenSlices()!;
  for (const table of Object.keys(slices)) {
    const { code, queries } = await runScript([table]);
    expect(code).toBe(0);
    const hash = queries.at(-1)!;
    expect(hash.startsWith("set time zone 'UTC'; ")).toBe(true);
    const ts = integrityQueries(slices, [table])[0]!.sql!;
    expect(norm(hash)).toBe(norm(ts));
  }
});

test('a dropped frozen-slice column is reported like the collector does', async () => {
  const { code, out, queries } = await runScript(['orders'], 'status');
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ orders: { rowcount: null, checksum: null, error: 'column status missing' } });
  expect(queries.some(q => q.includes('hashtextextended'))).toBe(false);
});
