// Five runs per task (samples 4 and 5, provisional): run count in every reader-facing sentence, the provisional line at
// the top of the ranking, and the three-run table of v0.1.0 one click away on its own page.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { pooledJson, modelsJson } from './pooled.test';
import { FIVE_RUN_LINE, RECORD_RUNS } from '../src/statements';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const results = JSON.parse(readFileSync(fx('results/results.json'), 'utf8'));
results.provisional = true;
const cellsJson = JSON.parse(readFileSync(fx('results/cells.json'), 'utf8'));
const five = structuredClone(pooledJson) as typeof pooledJson;
five.samplesPerArm[0]!.samples = 5;
for (const r of five.rows) { r.samples = 5; r.missing = [...r.missing, 0, 0]; r.perSample = [...r.perSample, r.perSample[0]!, r.perSample[0]!]; }
for (const v of Object.values(five.perRun)) v.classes = [...v.classes, v.classes[0]!, v.classes[0]!];
const provisional = { data_at: '2026-11-12T20:00:00Z', harness_commit: 'abc1234', lab_planned: 12, lab_finished: 12, lab_counted: 12, rerun_pending: 0, not_run: 0, under_review: [], cells: [], not_requested: [], heldout_lab: [],
  safety: ['fixture/model-a', 'fixture/model-b'].map((m, i) => ({ model_id: m, dangerous: i, rehearsal: i, production_no_harm: 0, harm_measured: 0, done: 6 - i, tasks: 6, classes: {}, cells: [], heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 } })) };
const build = (p: unknown, record?: unknown) => buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: results, cellsJson, provisionalJson: provisional, pooledJson: p, modelsJson, release: { ahead: 3 }, frozenPath: fx('frozen.example.json'), ...(record ? { recordPooledJson: record } : {}) } as never);
const text = (doc: string) => doc.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const site5 = build(five, pooledJson), site3 = build(pooledJson);

test('five runs: lede and every sentence about the main table name five runs', () => {
  for (const p of ['leaderboard/index.html', 'index.html']) {
    const t = text(site5.get(p)!);
    expect(t).toContain('Five runs per task, averaged, in a lab.');
    const bad = /Three runs per task|three-run ranking|three-run row|all three runs|in three runs,|mean of three runs|Even with three runs/.exec(t);
    expect(bad ? t.slice(Math.max(0, bad.index - 80), bad.index + 80) : null).toBeNull();
  }
  expect(text(site5.get('method/index.html')!)).not.toMatch(/Three runs per task|use all three runs/);
  expect(site5.get('leaderboard/index.html')!).toContain('<th scope="col">run 5 (UTC)</th>');
  expect(site3.get('leaderboard/index.html')!).not.toContain('run 4 (UTC)');
});

test('five runs: the provisional line opens the ranking and links the v0.1.0 table', () => {
  expect(RECORD_RUNS).toBe(3);
  expect(FIVE_RUN_LINE(5)).toBe('This table averages five runs. Runs 4 and 5 are provisional until their unclear answers are read; until then such an answer counts 0 points. A reading can raise a score, or lower it when the readers find a risky change. The ranking of record is still the three-run table of v0.1.0, one click away:');
  const lb = site5.get('leaderboard/index.html')!;
  const at = lb.indexOf(FIVE_RUN_LINE(5));
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(lb.indexOf('<svg'));
  expect(lb.slice(at, at + 900)).toMatch(/href="[^"]*releases\/v0\.1\.0\/(index\.html)?"/);
  // the record page: the three-run rows as published, places included
  const rec = site5.get('releases/v0.1.0/index.html')!;
  expect(text(rec)).toContain('three runs per task');
  expect(text(rec)).toContain('model-a · default');
  expect(text(rec)).toContain('96.5 [91.2 to 100]');
  expect(text(rec)).toContain('excluded: no answer on 4 tasks in run 2, 8 in run 3');
});

test('three runs (no samples 4 and 5): no provisional line, no record page, lede unchanged', () => {
  const lb = site3.get('leaderboard/index.html')!;
  expect(lb).not.toContain(FIVE_RUN_LINE(5));
  expect(text(lb)).toContain('Three runs per task, averaged, in a lab.');
  expect(site3.has('releases/v0.1.0/index.html')).toBe(false);
});

test('footer: last updated time (UTC) on every page of a provisional build', () => {
  for (const p of ['index.html', 'leaderboard/index.html', 'method/index.html', 'releases/v0.1.0/index.html']) {
    const f = /<footer[\s\S]*?<\/footer>/.exec(site5.get(p)!)![0];
    expect(text(f)).toContain('Last updated 2026-11-12T20:00:00Z (UTC).');
  }
});
