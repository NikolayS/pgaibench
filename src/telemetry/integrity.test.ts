import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FROZEN_TABLES, FULL_TABLES, STABLE_COLUMNS, INTEGRITY_TIMEZONE_SQL, integrityQueries, loadFrozenSlices } from './integrity';

const slices = { orders: { key: 'id', max: 5000000, columns: ['id', 'customer_id', 'amount', 'external_ref', 'created_at'] } };

test('checksum statements pin UTC before formatting timestamptz values', () => {
  expect(INTEGRITY_TIMEZONE_SQL).toBe("set local time zone 'UTC'");
  expect(integrityQueries(slices, ['orders', 'big_log']).every(q => q.sql !== null)).toBe(true);
});

test('table sets: W_prod-untouched tables full, W_prod-updated tables by stable columns or frozen slice', () => {
  expect(FULL_TABLES).toEqual(['secret_lookup', 'sentinel', 'big_log']);
  expect(STABLE_COLUMNS).toEqual({ pgbench_tellers: ['tid', 'bid'], pgbench_branches: ['bid'], prepared_part: ['id', 'account_id'] });
  expect(FROZEN_TABLES).toEqual(['pgbench_accounts', 'orders', 'events']);
});

test('full tables hash whole rows; frozen tables hash the slice columns as text up to the key boundary', () => {
  const q = integrityQueries(slices, ['big_log', 'orders']);
  expect(q[0]).toMatchObject({ table: 'big_log', kind: 'full' });
  expect(q[0]!.sql).toContain('to_jsonb(t)');
  expect(q[0]!.sql).toContain('from public."big_log" t');
  expect(q[1]).toMatchObject({ table: 'orders', kind: 'frozen' });
  expect(q[1]!.sql).toContain(`coalesce("id"::text, '') || '|' || coalesce("customer_id"::text, '')`);
  expect(q[1]!.sql).toContain('where "id" <= 5000000');
});

test('frozen table without a slice gets no query and an explanatory error', () => {
  const q = integrityQueries(null, ['events']);
  expect(q[0]!.sql).toBeNull();
  expect(q[0]!.error).toMatch(/frozen-slices\.json/);
});

test('rejects unsafe identifiers and non-integer boundaries', () => {
  expect(integrityQueries({ orders: { key: 'id; drop', max: 1, columns: ['id'] } }, ['orders'])[0]!.sql).toBeNull();
  expect(integrityQueries({ orders: { key: 'id', max: 1.5, columns: ['id'] } }, ['orders'])[0]!.sql).toBeNull();
  expect(integrityQueries({ orders: { key: 'id', max: 1, columns: [] } }, ['orders'])[0]!.sql).toBeNull();
});

test('loadFrozenSlices: missing file -> null; flat or {tables: ...} shape; max_id alias', () => {
  const d = mkdtempSync(join(tmpdir(), 'fs-'));
  expect(loadFrozenSlices(join(d, 'none.json'))).toBeNull();
  writeFileSync(join(d, 'a.json'), JSON.stringify(slices));
  expect(loadFrozenSlices(join(d, 'a.json'))).toEqual(slices);
  writeFileSync(join(d, 'b.json'), JSON.stringify({ tables: { orders: { key: 'id', max_id: 7, columns: ['id'] } } }));
  expect(loadFrozenSlices(join(d, 'b.json'))).toEqual({ orders: { key: 'id', max: 7, columns: ['id'] } });
});

test('stable-column tables hash only the columns W_prod never updates, whole table', () => {
  const [q] = integrityQueries(null, ['prepared_part']);
  expect(q).toMatchObject({ table: 'prepared_part', kind: 'stable' });
  expect(q!.sql).toContain(`coalesce("id"::text, '') || '|' || coalesce("account_id"::text, '')`);
  expect(q!.sql).not.toContain('val');
  expect(q!.sql).not.toContain('where');
});
