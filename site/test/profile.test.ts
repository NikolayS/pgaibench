import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { PROFILE_CLASSES, PROFILE_LABEL } from '../../src/analysis/outcome-map';
import { barsToText } from '../src/bars';
import { PER_TASK, PROFILE_CHAR, profileBar, profiles } from '../src/profile';
import { parseResults } from '../src/results';
import { parseCells } from '../src/cells';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const finalSite = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const res = parseResults(require(fx('results/results.json')));
const cells = parseCells(require(fx('results/cells.json')));
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const svg = (doc: string) => unesc(/<svg class="chart-wide"[^>]*data-chart="profile"[\s\S]*?<\/svg>/.exec(doc)![0]);
const segs = (sv: string, label: string) => { const g = new RegExp(`<g class="pf-row" data-model="${label}">([\\s\\S]*?)</g>`).exec(sv)![1]!; return [...g.matchAll(/data-class="(\w+)" data-n="(\d+)"/g)].map(m => [m[1]!, Number(m[2])] as const); };
const N = res.public_tasks + res.heldout_tasks;

test('profile: every bar is all tasks long, segments are count times the per-task width, in the fixed order', () => {
  const p = profiles(res, cells, null);
  expect(p.tasks).toBe(N);
  for (const t of p.tracks) for (const r of t.rows) {
    const bar = profileBar(r.counts);
    expect([...bar].length).toBe(N * PER_TASK);
    let i = 0;
    for (const k of PROFILE_CLASSES) { expect([...bar].slice(i, i + r.counts[k] * PER_TASK).every(ch => ch === PROFILE_CHAR[k])).toBe(true); i += r.counts[k] * PER_TASK; }
  }
});

test('profile: the legend under the plot lists every class with its swatch; harm has its own fill', () => {
  const doc = finalSite.get('leaderboard/index.html')!;
  const lg = /<ul class="pf-legend">([\s\S]*?)<\/ul>/.exec(doc)![1]!;
  for (const k of PROFILE_CLASSES.filter(k => k !== 'provider_error')) expect(lg).toContain(`<span class="sw pf-${k}" aria-hidden="true"></span>${PROFILE_LABEL[k].replace(/&/g, '&amp;')}`);
  expect(svg(doc)).toMatch(/class="pf pf-harmful_lab"/);
});

test('profile: the table numbers equal the chart numbers; models alphabetical, not by score', () => {
  const doc = finalSite.get('leaderboard/index.html')!;
  const chart = svg(doc);
  const p = profiles(res, cells, null);
  for (const t of p.tracks) {
    const labels = t.rows.map(r => r.model_id);
    expect(labels).toEqual([...labels].sort());
    for (const r of t.rows) {
      const sg = segs(chart, r.model_id.split('/')[1]!);
      expect(sg.map(x => x[0])).toEqual(PROFILE_CLASSES.filter(k => r.counts[k]));
      for (const [k, n] of sg) expect(n).toBe(r.counts[k as keyof typeof r.counts]);
      const prof = doc.slice(doc.indexOf('<section class="profile" id="profile">'));
      const rowHtml = [...prof.slice(0, prof.indexOf('</section>')).matchAll(new RegExp(`<tr><th scope="row">${r.model_id.split('/')[1]} · default</th>(.*?)</tr>`, 'g'))].map(m => m[1]).join('');
      const nums = [...rowHtml.matchAll(/data-class="(\w+)">(\d+)</g)].map(m => [m[1], Number(m[2])]);
      expect(Object.fromEntries(nums)).toEqual(Object.fromEntries(Object.entries(r.counts).filter(([k, v]) => k !== 'provider_error' || v)));
    }
  }
  expect(doc.indexOf('id="profile"')).toBeLessThan(doc.indexOf('Track: '));
  expect(finalSite.get('leaderboard/index.txt')).toContain('Outcome profile: what happened to each of the');
  expect(finalSite.get('index.html')).toContain('id="rating-home"');
  expect(doc).toContain('This chart keeps the classes apart, because they differ in cost. The rating combines them with fixed weights, and at this sample size most models are not separated.');
});

test('profile: held-out tasks are not run yet until the held-out set is finished, and never named', () => {
  const r2 = structuredClone(res);
  const row = r2.tracks[0]!.lab!.rows[0]!;
  row.heldout = { tasks: 1, counts: {}, profile: {} };
  const p = profiles(r2, cells, null);
  expect(p.tracks[0]!.rows[0]!.counts.not_run).toBeGreaterThanOrEqual(res.heldout_tasks);
  row.heldout = { tasks: res.heldout_tasks, counts: { right: res.heldout_tasks }, profile: { right: res.heldout_tasks } };
  const q = profiles(r2, cells, null).tracks[0]!.rows[0]!.counts;
  expect(Object.values(q).reduce((a, b) => a + b, 0)).toBe(N);
});

test('profile: the provider-error class shows only where a cell has it (legend, tables, chart)', () => {
  const doc = finalSite.get('leaderboard/index.html')!;
  expect(doc).not.toContain('provider error');
  expect(doc).not.toContain('pf-provider_error');
  expect(doc).not.toContain('perr');
});
