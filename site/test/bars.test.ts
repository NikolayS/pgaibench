import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { barHtml, barsToText, PATTERN } from '../src/bars';
import { buildSite } from '../src/build';
import { ratingAxis, ratingCells } from '../src/rating';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const site = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const NON_ASCII_ART = /[▀-▟·]/;

test('bar html: runs of codes become spans of spaces; text twin gets the codes back', () => {
  const h = barHtml('##==-  |');
  expect(h).toBe('<span class="bx bx-solid">  </span><span class="bx bx-hatch">  </span><span class="bx bx-dots"> </span>  |');
  expect(barsToText(h)).toBe('##==-  |');
  expect(new Set(Object.values(PATTERN)).size).toBe(Object.keys(PATTERN).length);
});

test('no block, shade or middle-dot characters anywhere in the built site', () => {
  for (const [p, s] of site) if (/\.(html|txt)$/.test(p)) expect(NON_ASCII_ART.test(s), p).toBe(false);
});

test('every .txt twin is pure ASCII inside its charts', () => {
  const t = site.get('leaderboard/index.txt')!;
  expect(t).toMatch(/\|[#= ]+\|/);
});

test('rating axis: -50..100 when nothing is below -50, else -100..100; linear', () => {
  expect(ratingAxis([-50, 0, 79])).toMatchObject({ lo: -50, hi: 100 });
  expect(ratingAxis([-60, 10])).toMatchObject({ lo: -100, hi: 100 });
  const a = ratingAxis([-50, 79]);
  expect(a.cells * a.step).toBe(150);
  expect(100 / a.step).toBeGreaterThanOrEqual(40);
});

test('the 0 tick is in the bar origin column and every row has the same number of cells', () => {
  for (const v of [[-50, 10, 79], [-100, 50]]) {
    const a = ratingAxis(v);
    const rows = [ratingCells({ s: 79, lo: 60, hi: 90 }, a), ratingCells({ s: -50, lo: -60, hi: -40 }, a), ratingCells({ s: 0, lo: 0, hi: 0 }, a)];
    for (const r of rows) expect(r.length).toBe(a.cells);
    const pos = ratingCells({ s: 30, lo: 30, hi: 30 }, a), neg = ratingCells({ s: -30, lo: -30, hi: -30 }, a);
    expect(pos.indexOf('#')).toBe(a.zero);
    expect(neg.lastIndexOf('#')).toBe(a.zero - 1);
    expect(a.rule[a.zero]).toBe('+');
    expect(a.labels.slice(a.zero, a.zero + 1)).toBe('0');
  }
});

