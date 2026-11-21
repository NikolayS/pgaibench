import { expect, test } from 'bun:test';
import { loadScenarios, scenarioSchema } from './schema';

const base = JSON.parse(JSON.stringify(loadScenarios().find(s => s.id === 'R8')!));

test('lab_profile: setup file id and optional sidecar validate', () => {
  const ok = scenarioSchema.safeParse({ ...base, lab_profile: { setup: 'C18', sidecar: { shape: 'c18_lookup', clients: 8, session_s: 15, role: 'shipping_api' } } });
  expect(ok.success).toBe(true);
  expect(scenarioSchema.safeParse({ ...base, lab_profile: { setup: '../x' } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, lab_profile: { setup: 'C18', sidecar: { shape: 'a b', clients: 8, session_s: 15, role: 'r' } } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, lab_profile: { setup: 'C18', sidecar: { shape: 's', clients: 0, session_s: 15, role: 'r' } } }).success).toBe(false);
});

test('hot_query_throughput harm needs a sidecar', () => {
  const t = { ...base.trap, harm_oracle: ['hot_query_throughput'] };
  expect(scenarioSchema.safeParse({ ...base, trap: t }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, trap: t, lab_profile: { setup: 'C18', sidecar: { shape: 's', clients: 8, session_s: 15, role: 'r' } } }).success).toBe(true);
});

test('only candidates with a scenario setup file opt into a lab profile', () => {
  for (const s of loadScenarios().filter(s => s.lab_profile)) {
    expect(s.candidate).toBe('v0.2');
    expect(s.lab_profile!.setup).toBe(s.id);
    expect(Bun.file(new URL(`../../env/scenario-setup/${s.id}.sql`, import.meta.url)).size).toBeGreaterThan(0);
  }
});

test('candidate scenarios (v0.2) stay out of the v0.1 scenario list and the site', () => {
  const { scenarioList } = require('../oracle/freeze-thresholds') as typeof import('../oracle/freeze-thresholds');
  const { publicScenarios } = require('../../site/src/build') as typeof import('../../site/src/build');
  const l = scenarioList();
  for (const { id } of loadScenarios().filter(s => s.candidate)) {
    expect(l.in).not.toContain(id);
    expect(l.out.map(o => o.id)).not.toContain(id);
    expect(publicScenarios().map(s => s.id)).not.toContain(id);
  }
  expect(scenarioSchema.safeParse({ ...base, candidate: 'v0.3' }).success).toBe(false);
});
