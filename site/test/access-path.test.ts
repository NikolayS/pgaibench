// Access-path rows (Gemini 4 Carbon through the Antigravity CLI): label, slug, provisional line in the ranking, note.
import { describe, expect, test } from 'bun:test';
import { baseName, shortName, urlSlug } from '../src/svg';
import { compactTable, headlineTable, provisionalRows, type SafetyRow } from '../src/safety';
import { AGY_NOTE, PLANNED_RUNS } from '../src/statements';

const ID = 'google/gemini-4-carbon@agy';
const row = (id: string, o: Partial<SafetyRow> = {}): SafetyRow => ({ model_id: id, dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0, done: 15, tasks: 19, classes: {}, cells: [],
  heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 }, score: 80, place: 1,
  avg: { runs: 3, lo: 70, hi: 90, placeLo: 1, placeHi: 2, perRun: [], classes: [], unstable: [], held: { tasks: 3, dangerous: 0, done: 3 } }, ...o });
const prow = { id: ID, samples: 1, score: 75, lo: 55.26, hi: 92.1, dangerous: 0, done: 14, split: { rehearsal: 0, production_no_harm: 0, harm_measured: 0 } };

describe('access path', () => {
  test('label: model, effort, path tag; slug keeps the tag', () => {
    expect(baseName(ID)).toBe('gemini-4-carbon');
    expect(shortName(ID)).toBe('gemini-4-carbon · medium (agy)');
    expect(urlSlug(ID)).toBe('carbon-agy');
  });
  test('provisionalRows: access-path arm rows only, with runs of 5', () => {
    const p = { effort: [{ arm: ' (effort high)', rows: [{ ...prow, id: 'openai/x (effort high)', base: 'openai/x' }] }, { arm: '@agy', rows: [{ ...prow, base: 'google/gemini-4-carbon' }] }] };
    const r = provisionalRows(p as never);
    expect(r.map(x => x.id)).toEqual([ID]);
    expect(PLANNED_RUNS).toBe(5);
  });
  test('ranking tables: a line with no place, "1 of 5 runs", the score interval', () => {
    const c = compactTable([row('a/m')], { id: 'q', provisional: [prow] });
    expect(c).toContain('gemini-4-carbon · medium (agy)');
    expect(c).toContain('1 of 5 runs, not ranked');
    expect(c).toContain('75 [55.3 to 92.1]');
    expect(c).not.toMatch(/>2 gemini/);
    const h = headlineTable([row('a/m')], { id: 'q', provisional: [prow] });
    expect(h).toContain('not ranked: 1 of 5 runs');
    expect(h).toContain('14 of 19');
  });
  test('note: Antigravity CLI, subscription, tools blocked, wrapper, title, not identical', () => {
    for (const w of ['(agy)', 'Antigravity CLI', 'subscription', 'not the raw API', 'Tools were blocked', 'wrapper', 'title', 'not identical']) expect(AGY_NOTE).toContain(w);
    expect(AGY_NOTE).not.toMatch(/PostgreSQL|Claude|Opus|agent/);
    expect(AGY_NOTE).toEndWith('This row is the Carbon result we will use for ranking once the five-run table for all models is ready.');
  });
});
