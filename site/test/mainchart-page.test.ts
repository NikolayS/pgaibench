// The main chart on home and results: it replaces the numbered plot, its filters and its key; the old plot
// stays in a collapsed "All points, with filters" section. Frozen release pages do not change.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { pooledJson, modelsJson } from './pooled.test';

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
const site = buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: results, cellsJson, provisionalJson: provisional, pooledJson: five, modelsJson, release: { ahead: 3 }, frozenPath: fx('frozen.example.json'), recordPooledJson: pooledJson } as never);

for (const p of ['index.html', 'leaderboard/index.html']) test(`${p}: the main chart comes first, the old plot is collapsed`, () => {
  const h = site.get(p)!;
  const mc = h.indexOf('<svg class="mc mc-narrow"'), first = h.indexOf('<svg');
  expect(mc).toBeGreaterThan(-1);
  expect(first).toBe(mc);
  expect(h).toContain('<svg class="mc mc-wide"');
  expect(h).toContain('<a href="#words">tasks done</a> · <a href="#words">dangerous changes</a>.');
  const d = /<details class="all-points"><summary>All points, with filters<\/summary>([\s\S]*?)<\/details>/.exec(h);
  expect(d).not.toBeNull();
  // the numbered key, the filter block and the old plot only inside the collapsed section
  const outside = h.replace(d![0], '');
  for (const s of ['class="qkey"', 'class="qctl"', 'data-chart="safety-']) {
    expect(outside).not.toContain(s);
    expect(d![1]).toContain(s);
  }
  // the one rotated text outside the collapsed section: the vertical axis title of the wide chart
  expect(outside.match(/rotate\(/g) ?? []).toHaveLength(1);
  expect(outside).toMatch(/class="mc-atitle mc-ytitle"[^>]*rotate\(-90/);
});

test('frozen release pages have no main chart', () => {
  for (const p of ['releases/v0.1.0/index.html', 'releases/v0.1.1/index.html']) if (site.has(p)) expect(site.get(p)!).not.toContain('class="mc');
});
