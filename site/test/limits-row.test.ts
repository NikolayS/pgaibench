import { expect, test } from 'bun:test';
import { parsePooled } from '../src/pooled';
import { limitLines } from '../src/limits';
import { pooledJson } from './pooled.test';

const p = parsePooled({ ...pooledJson, reasoning: { rows: {}, repairs: { answers: 10, repaired: 0 }, limits: { 'fixture/model-c': { answers: 27, firstLimit: 12, noAnswer: 13 }, 'fixture/model-a': { answers: 27, firstLimit: 2, noAnswer: 0 } } },
  perRun: { ...pooledJson.perRun, 'fixture/model-c': { classes: [{ B5: 'pending_review', D5: 'right' }, { B5: 'right' }, { B5: 'right' }], dangerous: [] } } });

test('output-limit lines: from the data, one fact per sentence, no semicolons', () => {
  const t = limitLines(p);
  expect(t).toEqual(['model-c · provider default: 12 of 27 answers hit the 32,000-token output limit on the first request. Each was requested once more at 96,000 tokens, as registered. 13 cells have no answer. 1 public cell is pending review. No place: runs 2 and 3 have 4 and 8 of 9 tasks with no answer, limit 1.']);
  for (const l of t) expect(l).not.toContain(';');
});

test('output-limit lines: none without limit data', () => {
  expect(limitLines(parsePooled(pooledJson))).toEqual([]);
});

