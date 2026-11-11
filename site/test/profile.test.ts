import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { PROFILE_CLASSES, PROFILE_LABEL } from '../../src/analysis/outcome-map';
import { PER_TASK, PROFILE_CHAR, profileBar, profiles } from '../src/profile';
import { parseResults } from '../src/results';
import { parseCells } from '../src/cells';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const finalSite = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const res = parseResults(require(fx('results/results.json')));
const cells = parseCells(require(fx('results/cells.json')));
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const pre = (doc: string) => unesc(/<figure class="profile" id="profile">[\s\S]*?<pre class="profile-chart" aria-hidden="true">([\s\S]*?)<\/pre>/.exec(doc)![1]!);
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

test('profile: distinct characters, harm is "!", the legend lists every class', () => {
  expect(new Set(Object.values(PROFILE_CHAR)).size).toBe(PROFILE_CLASSES.length);
  expect(PROFILE_CHAR.harmful_lab).toBe('!');
  const chart = pre(finalSite.get('leaderboard/index.html')!);
  for (const k of PROFILE_CLASSES) expect(chart).toContain(`${PROFILE_CHAR[k]} ${PROFILE_LABEL[k]}`);
});

test('profile: the table numbers equal the chart numbers; models alphabetical, not by score', () => {
  const doc = finalSite.get('leaderboard/index.html')!;
  const chart = pre(doc);
  const p = profiles(res, cells, null);
  for (const t of p.tracks) {
    const labels = t.rows.map(r => r.model_id);
    expect(labels).toEqual([...labels].sort());
    for (const r of t.rows) {
      const line = chart.split('\n').find(l => l.startsWith(r.model_id.split('/')[1]!))!;
      const bar = /\|(.*)\|/.exec(line)![1]!;
      for (const k of PROFILE_CLASSES) expect([...bar].filter(ch => ch === PROFILE_CHAR[k]).length / PER_TASK).toBe(r.counts[k]);
      const prof = doc.slice(doc.indexOf('<figure class="profile" id="profile">'));
      const rowHtml = [...prof.slice(0, prof.indexOf('</figure>')).matchAll(new RegExp(`<tr><th scope="row">${r.model_id.split('/')[1]}</th>(.*?)</tr>`, 'g'))].map(m => m[1]).join('');
      const nums = [...rowHtml.matchAll(/data-class="(\w+)">(\d+)</g)].map(m => [m[1], Number(m[2])]);
      expect(Object.fromEntries(nums)).toEqual(r.counts);
    }
  }
  expect(doc.indexOf('id="profile"')).toBeLessThan(doc.indexOf('Track: '));
  expect(finalSite.get('leaderboard/index.txt')).toContain('Outcome profile: what happened to each of the');
  expect(finalSite.get('index.html')).toContain('id="rating-home"');
  expect(doc).toContain('We do not combine these classes into one score: the classes differ in cost, and at this sample size models are not separated.');
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
