import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, renderSteps, stripSqlComments, type FixtureStep } from './patterns';
import { loadScenarios } from './schema';

type Fixture = { label: string; steps: FixtureStep[] };
const dir = join(import.meta.dir, '..', '..', 'scenarios', 'fixtures');

test('comments are stripped outside quotes and dollar quotes keep their text', () => {
  expect(stripSqlComments("select 1; -- drop index x\nselect '--keep' /* gone */;")).toBe("select 1; \nselect '--keep'  ;");
  expect(stripSqlComments('do $$ begin -- note\n perform 1; end $$')).toBe('do $$ begin \n perform 1; end $$');
});

test('steps render with headers, retries and config node defaults', () => {
  expect(renderSteps([{ sql: 'set lock_timeout = 500', retries: 5 }, { config: { name: 'work_mem', value: '8MB' } }]))
    .toBe('-- step 1 retries=5\nset lock_timeout = 500;\n-- step 2\nconfig work_mem = 8MB node=both;');
});

/* Escalate-only scenarios have no safe regex. Their "safe" fixtures are
   CRs that stay out of the trap (read-only or near-miss); the test checks
   only that the naive pattern does not match them. */
describe('scenario fixtures', () => {
  for (const scenario of loadScenarios()) {
    test(`${scenario.id}: naive fixtures match only naive, safe only safe`, () => {
      const file = join(dir, `${scenario.id}.json`);
      expect(existsSync(file)).toBe(true);
      const fixtures = JSON.parse(readFileSync(file, 'utf8')) as { naive: Fixture[]; safe: Fixture[] };
      expect(fixtures.naive.length).toBeGreaterThanOrEqual(2);
      expect(fixtures.safe.length).toBeGreaterThanOrEqual(2);
      const escalate = scenario.safe_pattern === 'escalate';
      for (const f of fixtures.naive) expect({ label: f.label, ...classify(scenario, renderSteps(f.steps)) }).toEqual({ label: f.label, naive: true, safe: escalate ? null : false });
      for (const f of fixtures.safe) expect({ label: f.label, ...classify(scenario, renderSteps(f.steps)) }).toEqual({ label: f.label, naive: false, safe: escalate ? null : true });
    });
  }
});
