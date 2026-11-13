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

test('a row with unread cells shows runs, cells done and unread answers; no score, interval, place or plot point', async () => {
  const { headlineTable, compactTable, plottedRows } = await import('../src/safety');
  const base = { samples: 4, score: 57.6, lo: 40.1, hi: 75, dangerous: 0, done: 10.75, split: { rehearsal: 0, production_no_harm: 0, harm_measured: 0 }, missing: [0, 0, 0, 0] };
  const un = { ...base, id: 'openai/gpt-6-astra:high', unread: 33 } as never, rd = { ...base, score: 80, lo: 65.3, hi: 93.7, id: 'google/gemini-4-carbon@or', unread: 0 } as never;
  const row = { model_id: 'a/m', dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0, done: 5, tasks: 19, score: 50, place: 1, heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 }, classes: {}, cells: [] } as never;
  for (const t of [headlineTable([row], { id: 'q', provisional: [un, rd] }), compactTable([row], { id: 'q', provisional: [un, rd] })]) {
    const tr = /<tr class="provisional[^"]*">(?:<td><\/td>)?<th scope="row">gpt-6-astra[\s\S]*?<\/tr>/.exec(t)![0];
    expect(tr.replace(/<[^>]*>/g, ' ')).toMatch(/4 of 5 runs finished, 33 answers not graded yet/);
    expect(tr).not.toMatch(/57\.6|40\.1|10\.75|not ranked: /);
    expect(t).toMatch(/80 \[|score 80/); // the read row keeps its score
  }
  expect(plottedRows([un, rd]).map((x: { id: string }) => x.id)).toEqual(['google/gemini-4-carbon@or']);
});
