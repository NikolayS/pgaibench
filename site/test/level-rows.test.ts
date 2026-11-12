// Effort-level rows "<model>:<level>" (pooled level arm ":high"): own label, slug and family; listed like the
// access-path rows ("N of 5 runs, not ranked"), never twice in the plot.
import { expect, test } from 'bun:test';
import { baseName, effortOf, shortName, urlSlug } from '../src/svg';
import { familyOf } from '../src/family';
import { otherLevelRows, provisionalRows } from '../src/safety';

test('a level id names its model and level', () => {
  expect(baseName('openai/gpt-6-astra:high')).toBe('gpt-6-astra');
  expect(effortOf('openai/gpt-6-astra:high')).toBe('high');
  expect(shortName('openai/gpt-6-astra:high')).toBe('gpt-6-astra · high');
  expect(shortName('anthropic/claude-sonnet-5.5:medium')).toBe('claude-sonnet-5.5 · medium');
  expect(urlSlug('openai/gpt-6-astra:high')).toBe('gpt-6-astra-high');
  expect(familyOf('openai/gpt-6-astra:high')).toBe('openai');
  expect(familyOf('anthropic/claude-haiku-5.5:high')).toBe('anthropic');
});

test('level arms are provisional rows, not other-level points', () => {
  const r = (id: string) => ({ id }) as never;
  const p = { effort: [{ arm: ':high', rows: [r('openai/gpt-6-astra:high')] }, { arm: '@or', rows: [r('google/gemini-4-carbon@or')] }, { arm: ' (effort low)', rows: [r('x/y (effort low)')] }] } as never;
  expect(provisionalRows(p).map((x: { id: string }) => x.id)).toEqual(['openai/gpt-6-astra:high', 'google/gemini-4-carbon@or']);
  expect(otherLevelRows(p).map((x: { id: string }) => x.id)).toEqual(['x/y (effort low)']);
});
