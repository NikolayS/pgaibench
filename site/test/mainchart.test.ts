// The main chart of home and results: tasks done (up) against dangerous changes per run (right), both linear from 0.
import { describe, expect, test } from 'bun:test';
import { axisMax, mainChartSvg, mainChartFigure, chartRows, contrast, MC_COLORS, type CRow } from '../src/mainchart';

type B = { x0: number; y0: number; x1: number; y1: number };
const hit = (a: B, b: B) => a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01;
const boxes = (svg: string, kind: string) => [...svg.matchAll(new RegExp(`data-${kind}="([-\\d. ]+)"`, 'g'))].map(m => { const [x0, y0, x1, y1] = m[1]!.split(' ').map(Number); return { x0: x0!, y0: y0!, x1: x1!, y1: y1! }; });

import { TODAY, THIRTY } from './fixtures/mainchart-rows';
const SETS: [string, CRow[]][] = [['today', TODAY], ['thirty rows', THIRTY]];
// the page draws a 1400 wide chart for desktop and a 340 wide one for phones
const WIDTHS = [1400, 340];
const DESK = 1400;

describe('main chart', () => {
  test('the horizontal axis ends at the largest value rounded up to an even number', () => {
    expect(axisMax(TODAY.map(r => r.dangerous))).toBe(8);
    expect(axisMax([0, 0.4, 7])).toBe(8);
    expect(axisMax([0, 8])).toBe(8);
    expect(axisMax([0, 8.2])).toBe(10);
    expect(axisMax([0, 0])).toBe(2);
  });

  for (const [name, rows] of SETS) for (const W of WIDTHS) describe(`${name}, ${W}`, () => {
    const svg = mainChartSvg(rows, { id: 't', width: W, tasks: 19 });
    test('both axes linear from 0', () => {
      expect(svg).toContain('data-xmin="0"');
      expect(svg).toContain('data-ymin="0"');
      for (const ax of ['x', 'y']) {
        const t = [...svg.matchAll(new RegExp(`data-${ax}tick="([\\d.]+) ([\\d.]+)"`, 'g'))].map(m => [Number(m[1]), Number(m[2])] as const);
        expect(t[0]![0]).toBe(0);
        expect(t.length).toBeGreaterThan(2);
        const z = t[t.length - 1]!, k = (z[1] - t[0]![1]) / (z[0] - t[0]![0]);
        for (const [v, px] of t) expect(Math.abs(t[0]![1] + k * (v - t[0]![0]) - px)).toBeLessThan(0.16);
      }
      expect(svg).not.toMatch(/log|break/i);
    });
    test('no rotated text except the vertical axis title, no numbered key', () => {
      const rot = svg.match(/<text[^>]*rotate\(-90[^>]*>[^<]*/g) ?? [];
      expect(rot.length).toBe(W === DESK ? 1 : 0);
      if (rot.length) expect(rot[0]).toMatch(/mc-ytitle[^>]*>tasks done, of 19$/);
      expect((svg.match(/rotate/g) ?? []).length).toBe(rot.length);
      expect(svg).not.toMatch(/writing-mode/);
      expect(svg).not.toContain('q-num');
    });
    test('no label overlaps a label or a mark, all inside the view', () => {
      const lab = boxes(svg, 'lbox'), mk = boxes(svg, 'mbox');
      expect(lab.length).toBeGreaterThan(10);
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
      for (const [i, a] of lab.entries()) {
        for (const b of lab.slice(i + 1)) expect(hit(a, b), JSON.stringify([a, b])).toBe(false);
        for (const m of mk) expect(hit(a, m), JSON.stringify([a, m])).toBe(false);
        expect(a.x0).toBeGreaterThanOrEqual(0);
        expect(a.x1).toBeLessThanOrEqual(Number(vb[1]));
      }
    });
    test('every row has a point with a title and its interval', () => {
      const titles = [...svg.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]!);
      for (const r of rows) expect(titles.some(t => t.startsWith(r.name)), r.id).toBe(true);
      expect(titles.find(t => t.startsWith('claude-opus-5.5, high'))).toMatch(/17 of 19 tasks done \(95% interval 14.5 to 19\), 0 dangerous changes per run/);
      expect((svg.match(/tabindex="0"/g) ?? []).length).toBe(titles.length);
      expect((svg.match(/class="mc-ci"/g) ?? []).length).toBe(rows.length);
    });
    test('equal levels share one half-filled mark with one label', () => {
      expect((svg.match(/gpt-6-luna<\/tspan>/g) ?? []).length).toBe(1);
      expect((svg.match(/gpt-6-astra<\/tspan>/g) ?? []).length).toBe(1);
      expect(svg).toContain('high and medium (same result)');
      expect(svg).toContain('mc-half');
    });
    test('one full horizontal axis to the largest value rounded up to an even number: no inset, no edge arrows', () => {
      expect(svg).toContain(`data-xmax="8"`);
      expect(svg).not.toMatch(/mc-far|mc-inset|mc-arrow|data-inset|mc-band/);
      for (const n of ['kimi-k3.1-pro', 'qwen3.8-27b', 'deepseek-v4-pro']) expect(svg).toMatch(new RegExp(`class="mc-lab[^"]*"[^>]*><tspan class="mc-nm">${n.replace('.', '\\.')}<`));
    });
    test('tick numbers: horizontal ones under the axis only, vertical ones left of the axis only', () => {
      const ax = attr(svg, 'data-axis-x'), y0 = attr(svg, 'data-plot-y0');
      const xt = [...svg.matchAll(/class="mc-tick"[^>]*data-xtick[^>]*data-lbox="([-\d. ]+)"/g)], yt = [...svg.matchAll(/class="mc-tick"[^>]*data-ytick[^>]*data-lbox="([-\d. ]+)"/g)];
      expect((svg.match(/class="mc-tick"/g) ?? []).length).toBe(xt.length + yt.length);
      for (const m of xt) expect(Number(m[1]!.split(' ')[1])).toBeGreaterThan(y0);
      for (const m of yt) expect(Number(m[1]!.split(' ')[2])).toBeLessThan(ax);
      expect(yt.length).toBe(5);
      if (W !== DESK) for (const m of svg.matchAll(/data-xtick="([\d.]+) /g)) expect(Number(m[1]) % 2).toBe(0);
    });
    test('phone marks small enough that pairs do not merge', () => {
      const r = [...svg.matchAll(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)"/g)].map(m => Number(m[1]));
      expect(r.length).toBeGreaterThan(0);
      for (const x of r) expect(x).toBeCloseTo(W === DESK ? 8 : 5.5, 1);
    });
    test('plot tall enough, no italic except the row without a place', () => {
      const h = Number(/data-plot-h="([\d.]+)"/.exec(svg)![1]);
      if (W === DESK) { expect(h).toBeGreaterThanOrEqual(480); expect(h).toBeLessThanOrEqual(520); } else { expect(h).toBeGreaterThanOrEqual(380); expect(h).toBeLessThanOrEqual(420); }
      expect((svg.match(/mc-noplace/g) ?? []).length).toBe(1);
    });
  });

  test('vendor colours keep 3:1 for marks on both page backgrounds', () => {
    for (const [bg, cs] of [['#fbfbf8', MC_COLORS.light], ['#0b0b0c', MC_COLORS.dark]] as const) for (const c of Object.values(cs)) expect(contrast(c, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  test('figure: legend of at most three lines with the two glossary links, no key', () => {
    const f = mainChartFigure(TODAY, { id: 'main', tasks: 19, words: '#words' });
    expect(f).toContain('<a href="#words">tasks done</a> · <a href="#words">dangerous changes</a>.');
    expect((f.match(/<p class="mc-leg/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(f).not.toMatch(/<ol|;/);
    expect(f).toContain('svg class="mc mc-wide"');
    expect(f).toContain('svg class="mc mc-narrow"');
  });
});

void chartRows;

// Earlier and variant A (owner, 2026-11-13): one name per model, effort words only where the fill does not say it,
// phone labels clear of the axis, joins and marks with short leaders, smaller inset, titles apart.
const labelTexts = (svg: string) => [...svg.matchAll(/<text class="mc-(?:lab|mlab|far)[^"]*"[^>]*>(.*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const attr = (svg: string, a: string) => Number(new RegExp(`${a}="([-\\d.]+)"`).exec(svg)![1]);
describe('main chart, earlier', () => {
  for (const W of WIDTHS) describe(`today, ${W}`, () => {
    const svg = mainChartSvg(TODAY, { id: 't', width: W, tasks: 19 }), t = labelTexts(svg);
    test('one margin name per model, effort words top to bottom', () => {
      const margin = [...svg.matchAll(/<text class="mc-mlab[^"]*"[^>]*>(.*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      expect(margin.length).toBe(7);
      if (W === DESK) {
        expect(margin).toContain('claude-fable-5.2 high · medium');
        expect(margin).toContain('gemini-4-carbon CLI medium · high');
        expect(margin).toContain('gpt-6.1-sol medium · high');
        expect(margin).toContain('gpt-6-astra high = medium');
      } else {
        // phone: names only, one line each, the column at most about 150 px
        expect(margin).toContain('claude-fable-5.2');
        expect(margin).toContain('gemini-4-carbon CLI');
        expect(margin).toContain('gemini-3.8-flash');
        expect(svg).not.toMatch(/class="mc-mlab[^>]*>[^]*?<tspan class="mc-eff" x=/);
        expect(attr(svg, 'data-axis-x')).toBeLessThanOrEqual(185);
      }
    });
    test('off-axis: one name per joined pair, effort word only when not high or medium', () => {
      expect(t.filter(s => s.startsWith('claude-sonnet-5.5'))).toEqual(['claude-sonnet-5.5']);
      expect(t.filter(s => s.startsWith('claude-haiku-5.5'))).toEqual(['claude-haiku-5.5']);
      expect(t).toContain('gpt-6-luna');
      expect(t).toContain(W === DESK ? 'gemini-4-argon provider default' : 'gemini-4-argon');
      expect(t).toContain(W === DESK ? 'gemini-4-carbon API provider default' : 'gemini-4-carbon API');
    });
    test('no leader runs through a label', () => {
      const lab = boxes(svg, 'lbox');
      for (const m of svg.matchAll(/class="mc-lead" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)) {
        const [x1, y1, x2, y2] = [1, 2, 3, 4].map(k => Number(m[k])), L = Math.hypot(x2! - x1!, y2! - y1!);
        for (let t = 0; t <= L - 3; t += 1) {
          const x = x1! + ((x2! - x1!) * t) / (L || 1), y = y1! + ((y2! - y1!) * t) / (L || 1);
          for (const b of lab) expect(x > b.x0 + 0.5 && x < b.x1 - 0.5 && y > b.y0 + 0.5 && y < b.y1 - 0.5, JSON.stringify([m[0], b])).toBe(false);
        }
      }
    });
    test('no label crosses the vertical axis or sits on a join line', () => {
      const ax = attr(svg, 'data-axis-x'), top = attr(svg, 'data-plot-top'), y0 = attr(svg, 'data-plot-y0');
      const joins = boxes(svg, 'jbox');
      expect(joins.length).toBeGreaterThan(3);
      for (const b of boxes(svg, 'lbox')) {
        if (b.y1 > top && b.y0 < y0) expect(b.x0 < ax && b.x1 > ax, JSON.stringify(b)).toBe(false);
        for (const j of joins) expect(hit(b, j), JSON.stringify([b, j])).toBe(false);
      }
    });
    test('leaders short, margin names at the height of their marks', () => {
      const leads = [...svg.matchAll(/class="mc-lead" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].map(m => Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])));
      const tw = attr(svg, 'data-axis-x') - Number(/data-lbox="[-\d.]+ [-\d.]+ ([-\d.]+)[^"]*"[^>]*>[^<]*<\/text>/.exec(svg.slice(svg.indexOf('mc-mlab')))?.[1] ?? 0);
      // margin leaders also cross the tick-number column
      if (W === DESK) for (const l of leads) expect(l).toBeLessThanOrEqual(24.5 + Math.max(0, tw) + 4);
      else {
        // phone: name leaders (left of the axis) at most 12 px, leaders of points inside the plot at most 24
        const ax = attr(svg, 'data-axis-x');
        for (const m of svg.matchAll(/class="mc-lead" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)) {
          const l = Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2]));
          expect(l).toBeLessThanOrEqual(Number(m[1]) < ax ? 12 : 24.5);
        }
      }
      const dy = [...svg.matchAll(/data-dy="([-\d.]+)"/g)].map(m => Math.abs(Number(m[1])));
      expect(dy.length).toBe(7);
      for (const d of dy) expect(d).toBeLessThanOrEqual(8);
    });
    test('axis titles in the usual places', () => {
      const y0 = attr(svg, 'data-plot-y0'), ax = attr(svg, 'data-axis-x'), top = attr(svg, 'data-plot-top');
      const ti = [...svg.matchAll(/class="mc-atitle[^"]*"[^>]*data-lbox="([-\d. ]+)"[^>]*>([^<]*)</g)].map(m => ({ b: m[1]!.split(' ').map(Number), t: m[2]! }));
      expect(ti.length).toBe(2);
      const x = ti.find(q => q.t === 'dangerous changes per run')!, y = ti.find(q => q.t !== x.t)!;
      const ticks = [...svg.matchAll(/data-xtick[^>]*data-lbox="([-\d. ]+)"/g)].map(m => Number(m[1]!.split(' ')[3]));
      expect(x.b[1]!).toBeGreaterThan(Math.max(...ticks));
      expect(Math.abs((x.b[0]! + x.b[2]!) / 2 - (ax + (Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1]) - ax) / 2))).toBeLessThan(40);
      if (W === DESK) {
        expect(y.t).toBe('tasks done, of 19');
        expect(y.b[2]!).toBeLessThan(30);
        expect(Math.abs((y.b[1]! + y.b[3]!) / 2 - (top + y0) / 2)).toBeLessThan(1);
      } else { expect(y.t).toBe('tasks done'); expect(y.b[3]!).toBeLessThan(top); }
    });
  });
  test('a model with one row on the zero line and one off it: rows labelled apart', () => {
    const rows: CRow[] = [...TODAY.filter(r => !r.id.startsWith('o/terra')), { ...TODAY.find(r => r.id === 'o/terra:high')! }, { ...TODAY.find(r => r.id === 'o/terra')!, dangerous: 0.6 }];
    for (const W of WIDTHS) {
      const t = labelTexts(mainChartSvg(rows, { id: 't', width: W, tasks: 19 }));
      expect(t).toContain('gpt-6.1-terra high');
      expect(t).toContain('gpt-6.1-terra medium');
    }
  });
  test('titles: singular for one dangerous change', () => {
    const svg = mainChartSvg(TODAY, { id: 't', width: DESK, tasks: 19 });
    expect(svg).toContain('claude-sonnet-5.5, high: 16.2 of 19 tasks done (95% interval 13.7 to 18.2), 1 dangerous change per run');
  });
  test('focused interval on a top layer: plot.js copies it, the figure says so', async () => {
    const js = await Bun.file(new URL('../assets/plot.js', import.meta.url)).text();
    expect(js).toContain('mc-top');
    expect(mainChartSvg(TODAY, { id: 't', width: DESK, tasks: 19 })).toContain('<g class="mc-top"');
  });
  test('legend lines end with a full stop for the text twins', () => {
    const f = mainChartFigure(TODAY, { id: 'm', tasks: 19, words: '#w' });
    expect(f).toContain('high = medium.');
  });
});
