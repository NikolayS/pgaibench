import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseResults, assertRealResults, allRows } from '../src/results';

const fixturePath = join(import.meta.dir, 'fixtures', 'results', 'results.json');
const fixture = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const row0 = (f: any) => f.tracks[0].text.rows[0];

describe('results schema', () => {
  test('accepts the synthetic fixture', () => {
    expect(allRows(parseResults(fixture())).length).toBe(3);
  });
  test('rejects NaN and Infinity', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const f = fixture(); row0(f).q.acted.hi = bad;
      expect(() => parseResults(f)).toThrow();
      const g = fixture(); row0(g).cost_usd = bad;
      expect(() => parseResults(g)).toThrow();
    }
  });
  test('rejects an interval that is not the Wilson interval of its count', () => {
    const f = fixture(); row0(f).q.acted.lo = 0;
    expect(() => parseResults(f)).toThrow(/Wilson/);
  });
  test('rejects a count above its denominator', () => {
    const f = fixture(); row0(f).q.acted.k = 9;
    expect(() => parseResults(f)).toThrow();
  });
  test('rejects a row whose tasks differ from the public set', () => {
    const f = fixture(); row0(f).tasks = 5; row0(f).q.acted = null;
    expect(() => parseResults(f)).toThrow(/tasks/);
  });
  test('rejects a model that is both excluded and in a table', () => {
    const f = fixture(); f.excluded.push({ model_id: row0(f).model_id, track: 'router', reason: 'x', cells_generated: 0, cells_expected: 0 });
    expect(() => parseResults(f)).toThrow(/excluded/);
  });
  test('rejects a row without a paired-test group', () => {
    const f = fixture(); delete f.tracks[0].text.groups[row0(f).model_id];
    expect(() => parseResults(f)).toThrow(/group/);
  });
  test('rejects a missing field and unknown fields', () => {
    const f = fixture(); delete f.harness_commit;
    expect(() => parseResults(f)).toThrow();
    const g = fixture(); row0(g).rank = 1;
    expect(() => parseResults(g)).toThrow();
  });
  test('a real build refuses the test fixture', () => {
    expect(() => assertRealResults(fixturePath, parseResults(fixture()))).toThrow(/fixture/);
  });
});

test('provisional results: a row may count fewer tasks than the public set (lab cells not finished, or a cell never requested); final results may not', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { parseResults } = require('../src/results') as typeof import('../src/results');
  const base = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'results', 'results.json'), 'utf8'));
  const lab = structuredClone(base); lab.tracks[0].lab.rows[0].tasks = 4; lab.tracks[0].lab.rows[0].q.acted = null;
  expect(() => parseResults(lab)).toThrow(/tasks, the public set has/);
  expect(() => parseResults({ ...lab, provisional: true })).not.toThrow();
  const text = structuredClone(base); text.provisional = true; text.tracks[0].text.rows[0].tasks = 4; text.tracks[0].text.rows[0].q.acted = null;
  expect(() => parseResults(text)).not.toThrow();
  delete text.provisional;
  expect(() => parseResults(text)).toThrow(/tasks, the public set has/);
});
