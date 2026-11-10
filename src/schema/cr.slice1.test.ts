import { expect, test } from 'bun:test';
import { crSchema } from './cr';
import { goodCR } from '../run/fixtures/good-cr';

test('SQL expected_rows and config node are optional and validated', () => {
  expect(crSchema.safeParse(goodCR).success).toBe(true);
  const steps = [{ sql: 'delete from orders where id = 1', expected_rows: 1, expect: {} }, { config: { name: 'work_mem', value: '64MB' }, node: 'standby', expect: {} }];
  expect(crSchema.safeParse({ ...goodCR, steps }).success).toBe(true);
  expect(crSchema.safeParse({ ...goodCR, steps: [{ ...steps[0], expected_rows: -1 }] }).success).toBe(false);
  expect(crSchema.safeParse({ ...goodCR, steps: [{ ...steps[1], node: 'replica' }] }).success).toBe(false);
});

test('SQL retries is an optional integer from 1 to 10; existing CRs stay valid', () => {
  const step = { sql: 'alter table orders add column c int', expect: {} };
  expect(crSchema.safeParse({ ...goodCR, steps: [step] }).success).toBe(true);
  for (const retries of [1, 10]) expect(crSchema.safeParse({ ...goodCR, steps: [{ ...step, retries }] }).success).toBe(true);
  for (const retries of [0, 11, 2.5, '3']) expect(crSchema.safeParse({ ...goodCR, steps: [{ ...step, retries }] }).success).toBe(false);
  expect(crSchema.safeParse({ ...goodCR, steps: [{ config: { name: 'work_mem', value: '64MB' }, retries: 2, expect: {} }] }).success).toBe(false);
});
