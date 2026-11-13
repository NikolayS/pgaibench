// The home bar chart: one row per configuration, tasks done per run as a bar (0 to the task count, linear),
// dangerous changes per run in a right column. Fewest dangerous changes first, then most tasks done.
import { describe, expect, test } from 'bun:test';
import { barChartSvg, barChartFigure, barOrder, BAR_CAPTION, WARN_COLORS } from '../src/barchart';
import { contrast } from '../src/mainchart';
import { TODAY, THIRTY } from './fixtures/mainchart-rows';

const SETS = [['today', TODAY], ['thirty rows', THIRTY]] as const;
const WIDTHS = [1400, 340];
const boxes = (svg: string) => [...svg.matchAll(/data-lbox="([-\d. ]+)"/g)].map(m => m[1]!.split(' ').map(Number) as [number, number, number, number]);
const rowsOf = (svg: string) => [...svg.matchAll(/<g class="bc-row[^"]*" data-id="([^"]+)" data-done="([\d.]+)" data-dangerous="([\d.]+)"/g)].map(m => ({ id: m[1]!, done: Number(m[2]), dangerous: Number(m[3]) }));

describe('bar chart', () => {
  test('order: fewest dangerous changes first, then most tasks done', () => {
    const o = barOrder(TODAY);
    for (let i = 1; i < o.length; i++) {
      const a = o[i - 1]!, b = o[i]!;
      expect(a.dangerous < b.dangerous || (a.dangerous === b.dangerous && a.done >= b.done)).toBe(true);
    }
    expect(o[0]!.name).toBe('claude-fable-5.2');
  });

  for (const [name, rows] of SETS) for (const W of WIDTHS) describe(`${name}, ${W}`, () => {
    const svg = barChartSvg(rows, { id: 'b', width: W, tasks: 19 });
    test('one row per configuration, values equal the data, in order', () => {
      const r = rowsOf(svg);
      expect(r.map(x => x.id)).toEqual(barOrder(rows).map(x => x.id));
      for (const x of r) { const d = rows.find(y => y.id === x.id)!; expect(x.done).toBe(Math.round(d.done * 10) / 10); expect(x.dangerous).toBe(Math.round(d.dangerous * 10) / 10); }
    });
    test('axis linear from 0 to the task count, ticks 0 5 10 15 19, title under it', () => {
      const t = [...svg.matchAll(/data-xtick="([\d.]+) ([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])] as const);
      // phone: no "19" label next to "15"; the axis line still ends at 19
      expect(t.map(x => x[0])).toEqual(W === 340 ? [0, 5, 10, 15] : [0, 5, 10, 15, 19]);
      const k = (t[3]![1] - t[0]![1]) / 15;
      const ax = /<line class="bc-axis" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2"\/>/.exec(svg)!;
      expect(Math.abs(Number(ax[3]) - (t[0]![1] + 19 * k))).toBeLessThan(0.16);
      for (const [v, px] of t) expect(Math.abs(t[0]![1] + k * v - px)).toBeLessThan(0.16);
      for (const m of svg.matchAll(/<rect class="bc-bar[^"]*" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*data-v="([\d.]+)"/g)) {
        expect(Math.abs(Number(m[1]) - t[0]![1])).toBeLessThan(0.11);
        expect(Math.abs(Number(m[2]) - k * Number(m[3]))).toBeLessThan(0.16);
      }
      expect(svg).toContain('>tasks done per run, of 19</text>');
    });
    test('value at each bar end, dangerous column: muted 0, warning above 0', () => {
      for (const x of rowsOf(svg)) {
        const g = new RegExp(`data-id="${x.id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[\\s\\S]*?</g>`).exec(svg)![0];
        expect(g).toMatch(new RegExp(`class="bc-val"[^>]*>${String(x.done)}<`));
        expect(g).toMatch(x.dangerous === 0 ? /class="bc-d0"[^>]*>0</ : new RegExp(`class="bc-dw"[^>]*>${String(x.dangerous)}<`));
      }
    });
    test('every row has a title with its interval; the row without a place is italic', () => {
      const titles = [...svg.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]!);
      expect(titles.length).toBe(rows.length);
      expect(titles.find(t => t.startsWith('claude-opus-5.5 · high'))).toMatch(/17 of 19 tasks done \(95% interval 14.5 to 19\), 0 dangerous changes per run/);
      expect((svg.match(/bc-row bc-noplace/g) ?? []).length).toBe(rows.filter(r => !r.ranked).length);
    });
    test('bars in the vendor colour, no text overlaps, nothing outside the view', () => {
      for (const m of svg.matchAll(/<rect class="bc-bar mc-v-([a-z]+)"/g)) expect(['anthropic', 'openai', 'google', 'open', 'other']).toContain(m[1]);
      const vb = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1]), b = boxes(svg);
      expect(b.length).toBeGreaterThan(rows.length * 2);
      for (const [i, a] of b.entries()) {
        expect(a[0]).toBeGreaterThanOrEqual(0); expect(a[2]).toBeLessThanOrEqual(vb);
        for (const c of b.slice(i + 1)) expect(a[0] < c[2] - 0.01 && c[0] < a[2] - 0.01 && a[1] < c[3] - 0.01 && c[1] < a[3] - 0.01, JSON.stringify([a, c])).toBe(false);
      }
    });
    test('phone: label column at most 55 percent', () => {
      if (W !== 340) return;
      expect(Number(/data-bar-x="([\d.]+)"/.exec(svg)![1])).toBeLessThanOrEqual(340 * 0.55 + 12);
    });
  });

  test('warning colour keeps 4.5:1 on both page backgrounds', () => {
    expect(contrast(WARN_COLORS.light, '#fbfbf8')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WARN_COLORS.dark, '#0b0b0c')).toBeGreaterThanOrEqual(4.5);
  });

  test('figure: one caption line, a link to the full table', () => {
    const f = barChartFigure(TODAY, { id: 'bars', tasks: 19, full: 'leaderboard/#safety' });
    expect(BAR_CAPTION).toBe('19 public tasks, mean of 5 runs, no tools. Neighbouring rows can differ by one answer in one run.');
    expect(f).toContain(`<figcaption>${BAR_CAPTION}`);
    expect(f).toContain('<a href="leaderboard/#safety">full table</a>');
    expect(f).toContain('svg class="bc bc-wide"');
    expect(f).toContain('svg class="bc bc-narrow"');
    expect(f).not.toContain(';');
  });
});
