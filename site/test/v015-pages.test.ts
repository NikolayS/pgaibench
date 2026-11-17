// 0.1.5 blocks on the built pages, from the v0.1.4 table (the table the stop causes were counted from).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { text } from './five-runs.test';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const results = JSON.parse(readFileSync(fx('results/results.json'), 'utf8')); results.provisional = true;
const cellsJson = JSON.parse(readFileSync(fx('results/cells.json'), 'utf8'));
const record = JSON.parse(readFileSync(join(import.meta.dir, '..', 'content', 'record-v0.1.4-pooled.json'), 'utf8'));
const modelsJson = JSON.parse(readFileSync(fx('models-table.json'), 'utf8'));
const z = { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 };
const provisional = { data_at: '2026-11-15T16:24:45Z', harness_commit: 'abc1234', lab_planned: 12, lab_finished: 12, lab_counted: 12, rerun_pending: 0, not_run: 0, under_review: [], cells: [], not_requested: [], heldout_lab: [],
  safety: record.rows.map((r: { id: string }) => ({ model_id: r.id, ...z, done: 0, tasks: 19, classes: {}, cells: [], heldout: z })) };
const site = buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: results, cellsJson, provisionalJson: provisional, pooledJson: record, modelsJson, release: { ahead: 0 }, frozenPath: fx('frozen.example.json') } as never);

const t = (p: string) => text(site.get(p)!).replace(/ \./g, '.');

test('home and results open with the zero-row line, then the two-row line', () => {
  for (const p of ['index.html', 'leaderboard/index.html']) {
    const s = t(p);
    const z = s.indexOf('13 of 23 configurations wrote no dangerous change on the 19 public tasks.');
    expect(s).not.toContain('8 of these 13 wrote one');
    expect(z).toBeGreaterThan(0);
    expect(s.indexOf('No dangerous change in any run.')).toBeGreaterThan(z);
  }
});

test('home: What we learned has the stop-cause and harm topics, linked to the data file and the addendum', () => {
  const h = site.get('index.html')!;
  expect(t('index.html')).toContain('64 of the 74 rehearsal stops came from a check in the answer itself.');
  expect(t('index.html')).toContain('5 of the 11 measured harms passed a test that the answer chose.');
  expect(t('index.html')).toContain('Rerun under a gate the harness owns: 7 of 10 harmful cells stopped.');
  expect(h).toContain('href="data/rehearsal-stops-v0.1.3.json"');
  expect(h).toContain('href="addendum/v0.1.3-gate-rerun/');
  expect(site.get('data/rehearsal-stops-v0.1.3.json')).toBe(readFileSync(join(import.meta.dir, '..', 'data', 'rehearsal-stops-v0.1.3.json'), 'utf8'));
});

test('results: Robustness block and the L2 lab-fault known issue', () => {
  const s = t('leaderboard/index.html');
  expect(site.get('leaderboard/index.html')).toContain('<h2 id="robustness">Robustness</h2>');
  expect(s).toContain('Without task D21: 99 dangerous changes, 71 stopped at rehearsal, 11 with harm measured.');
  expect(s).toContain('was a lab fault: a second batch process reset the lab server during the measurement. The cell was rerun on 2026-11-16: no harm, a correct change.');
});

test('method: counts with place terms, how to cite, data file link', () => {
  const m = site.get('method/index.html')!;
  expect(m).toContain('<dd>14 (25 rows: 23 with a place, 2 with no place)</dd>');
  expect(m).toContain('<h2 id="cite">How to cite</h2>');
  expect(m).toContain('https://github.com/NikolayS/pgaibench/issues');
  expect(m).toContain('href="../data/rehearsal-stops-v0.1.3.json"');
  expect(site.get('llms.txt')).toContain('14 models, 23 rows with a place and 2 with no place.');
});
