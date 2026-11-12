// Two-level intervals (tasks and runs), place ranges, whole-number scores and the bound on dangerous changes
// (prereg section 13, 2026-11-12). Rows without the new fields render as before (the frozen record page).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { pooledJson, modelsJson } from './pooled.test';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const results = { ...JSON.parse(readFileSync(fx('results/results.json'), 'utf8')), provisional: true };
const cellsJson = JSON.parse(readFileSync(fx('results/cells.json'), 'utf8'));
const T = ['B5', 'D5', 'L1', 'L2', 'L9', 'R2'];
const cls = () => Object.fromEntries(T.map(t => [t, 'right']));
const provisional = { data_at: '2026-11-11T20:00:00Z', harness_commit: 'abc1234', lab_planned: 12, lab_finished: 12, lab_counted: 12, rerun_pending: 0, not_run: 0, under_review: [], cells: [], not_requested: [], heldout_lab: [],
  safety: ['fixture/model-a', 'fixture/model-b'].map((m, i) => ({ model_id: m, dangerous: i, rehearsal: i, production_no_harm: 0, harm_measured: 0, done: 6 - i, tasks: 6, classes: cls(), cells: [], heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 } })) };
const p = structuredClone(pooledJson) as typeof pooledJson & { rows: Record<string, unknown>[] };
const tl = (lo: number, hi: number, pl: number, ph: number) => ({ method: 'tasks-and-runs', lo, hi, doneLo: 5, doneHi: 6, placeLo: pl, placeHi: ph });
Object.assign(p.rows[0]!, { unread: 0, twoLevel: tl(88.6, 100, 1, 2), taskOnly: { lo: 91.22807017543859, hi: 100, doneLo: 5, doneHi: 6, placeLo: 1, placeHi: 2 }, dangerBound: { count: 0, answers: 18, upper: 0.1307 } });
Object.assign(p.rows[1]!, { unread: 0, twoLevel: tl(47.4, 86.1, 1, 2), taskOnly: { lo: 50, hi: 85.5, doneLo: 5, doneHi: 6, placeLo: 1, placeHi: 2 }, dangerBound: { count: 4, answers: 18, upper: 0.4302 } });
Object.assign(p.rows[2]!, { unread: 0, twoLevel: null, taskOnly: null, dangerBound: null });
const site = buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: results, cellsJson, provisionalJson: provisional, pooledJson: p, modelsJson, release: { ahead: 0 }, frozenPath: fx('frozen.example.json') });
const lb = site.get('leaderboard/index.html')!, home = site.get('index.html')!, method = site.get('method/index.html')!;
const text = (doc: string) => doc.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const tbl = (doc: string, cls: string) => new RegExp(`<table class="${cls}"[\\s\\S]*?</table>`).exec(doc)![0];

test('headline table: whole-number score with the two-level interval, place range, bound on dangerous', () => {
  for (const doc of [lb, home]) {
    const t = text(tbl(doc, 'safety'));
    expect(t).toContain('96 [89 to 100]');
    expect(t).toContain('69 [47 to 86]');
    expect(t).toContain('1 to 2');
    expect(t).toContain('0 (at most 14%)');
    expect(t).toContain('1.33 (at most 44%)');
    expect(t).not.toMatch(/96\.5|91\.2|\(1-2\)/);
  }
});

test('phone table: whole-number score, bound on dangerous, place range', () => {
  const c = text(tbl(home, 'safety compact'));
  expect(c).toContain('96');
  expect(c).not.toContain('96.5');
  expect(c).toContain('at most 14%');
  expect(c).toContain('place 1 to 2');
});

test('rating table: whole numbers, two-level interval, place range', () => {
  const r = text(tbl(lb, 'rating'));
  expect(r).toContain('1 to 2');
  expect(r).toContain('89 to 100');
  expect(r).not.toMatch(/96\.5|91\.2/);
});

test('rows without the new fields get none of it (excluded row)', () => {
  const tr = /<tr class="excluded">[\s\S]*?<\/tr>/.exec(tbl(lb, 'safety'))![0];
  expect(text(tr)).not.toContain('at most');
});

test('no semicolons in the new labels; method page has the plain paragraph', () => {
  const t = tbl(lb, 'safety');
  for (const m of t.matchAll(/title="([^"]*)"/g)) if (/range|at most|tasks and runs/.test(m[1]!)) expect(m[1]).not.toContain(';');
  expect(text(method)).toContain('Since 2026-11-12 the intervals resample tasks and, within each task, runs.');
});

test('ORDER_LINE: the order has no interval, the score has one', async () => {
  const { ORDER_LINE } = await import('../src/safety');
  expect(ORDER_LINE).toContain('The order itself has no interval');
  expect(ORDER_LINE).not.toContain('It has no interval');
  expect(ORDER_LINE).toContain('place by score has a range');
  expect(ORDER_LINE).not.toContain(';');
});
