import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { ordered, RATING_NOTE, BASELINE_NOTE, ratingBar, RBAR } from '../src/rating';
import { score } from '../../src/analysis/score';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const site = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const lb = site.get('leaderboard/index.html')!;
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (s: string) => unesc(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');

test('rating: on top of the results page, above the outcome profile, with title, note and baselines note', () => {
  expect(lb.indexOf('id="rating"')).toBeGreaterThan(0);
  expect(lb.indexOf('id="rating"')).toBeLessThan(lb.indexOf('id="profile"'));
  expect(text(lb)).toContain('Rating: PG AI Bench score (v0), -100 to 100 (higher is better)');
  expect(text(lb)).toContain(RATING_NOTE);
  expect(text(lb)).toContain(BASELINE_NOTE);
  expect(text(lb)).toContain('The weights are version 0, added after the freeze, not preregistered.');
  expect(site.get('index.html')).toContain('id="rating-home"');
  expect(site.get('leaderboard/index.txt')).toContain('PG AI Bench score (v0)');
});

test('rating: rows ordered by score, highest first; ties and missing scores last; a track tag on every row', () => {
  const rows = [{ model_id: 'x/b', track: 'router', score: 10 }, { model_id: 'x/a', track: 'router', score: 50 }, { model_id: 'x/c', track: 'router', score: null }] as any;
  expect(ordered(rows).map((r: any) => r.model_id)).toEqual(['x/a', 'x/b', 'x/c']);
  const pre = unesc(/<pre class="rating-chart" aria-hidden="true">([\s\S]*?)<\/pre>/.exec(lb)![1]!);
  for (const l of pre.split('\n').filter(l => l.includes('|') && /^\S/.test(l) && !l.startsWith('Baseline'))) expect(l).toMatch(/ \[[ABR]\] \|/);
});

test('rating: bar is from zero to the score, interval shaded, few tasks without fill', () => {
  const s = score({ right: 20, harmful_lab: 2, correct_refusal: 0, over_cautious: 0, ineffective: 0, stopped_at_rehearsal: 0, risky_pattern: 0, invalid_answer: 0, unscorable: 0, pending_review: 0, rerun: 0, under_review: 0, not_run: 0 });
  const bar = ratingBar(s, -100);
  expect([...bar].length).toBe(RBAR);
  expect(bar).toContain('█');
  expect(ratingBar({ ...s, few: true }, -100)).not.toContain('█');
  expect(ratingBar({ ...s, few: true }, -100)).toContain('·');
});

test('rating: the table numbers equal the chart numbers', () => {
  const pre = unesc(/<pre class="rating-chart" aria-hidden="true">([\s\S]*?)<\/pre>/.exec(lb)![1]!);
  const tb = /<table class="rating"[\s\S]*?<\/table>/.exec(lb)![0];
  for (const m of tb.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>[ABR]<\/td><td class="num">(-?\d+)[^<]*<\/td><td class="num">(-?\d+)-(-?\d+)<\/td><td class="num">(\d+)<\/td>/g)) {
    const line = pre.split('\n').find(l => l.startsWith(`${m[1]} `))!;
    expect(line).toMatch(new RegExp(`\\|\\s*${m[2]} ${m[3]}-${m[4]}\\s+${m[5]}/`));
  }
});
