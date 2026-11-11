import { expect, test } from 'bun:test';
import { hbarSvg, stackedSvg } from '../src/svg';
import { QUAD_CAPTION, quadrantSvg, quadrantFigure, compactTable, headlineTable, fmtNum, type SafetyRow } from '../src/safety';

// Owner rule: every numeric axis on the site includes 0 and starts at 0.
// Ticks under the plot (y > frame bottom) are the horizontal axis; ticks with text-anchor end are the vertical axis.
const ticks = (s: string) => [...s.matchAll(/<text class="ch-tick" x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)">([^<]*)<\/text>/g)].map(m => ({ x: +m[1]!, y: +m[2]!, anchor: m[3]!, v: parseFloat(m[4]!) }));
function startsAtZero(s: string) {
  const all = ticks(s);
  const h = all.filter(t => t.anchor === 'middle'), v = all.filter(t => t.anchor === 'end');
  expect(h.length).toBeGreaterThan(0);
  const hl = h.reduce((a, b) => (b.x < a.x ? b : a));
  expect(hl.v).toBe(0);
  // no inverted axes: the zero is the leftmost horizontal tick and the lowest vertical tick
  if (v.length) { expect(v.reduce((a, b) => (b.y > a.y ? b : a)).v).toBe(0); expect(v.reduce((a, b) => (b.y < a.y ? b : a)).v).toBe(Math.max(...v.map(t => t.v))); }
  expect(h.reduce((a, b) => (b.x > a.x ? b : a)).v).toBe(Math.max(...h.map(t => t.v)));
}

const pts = [{ label: 'a', x: 17, y: 0 }, { label: 'b', x: 14.67, y: 0.33 }, { label: 'c', x: 9, y: 2.5 }, { label: 'd', x: 3, y: 1 }];
test('every chart generator: each numeric axis starts at 0', () => {
  for (const width of [360, 760]) {
    startsAtZero(quadrantSvg({ id: 'q', points: pts, xMax: 19, width, baselines: [{ label: 'always escalate', x: 4, y: 0 }, { label: 'trapped', x: 0, y: 19 }] }));
    startsAtZero(hbarSvg({ id: 'h', title: 't', desc: 'd', aria: 'a', rows: [{ label: 'x', value: 40 }, { label: 'y', value: 75 }], width }));
    startsAtZero(stackedSvg({ id: 's', title: 't', desc: 'd', aria: 'a', groups: [{ name: 'g', rows: [{ label: 'x', key: 'x', segs: [{ cls: 'right', n: 12 }, { cls: 'risky', n: 7 }] }] }], total: 19, legend: [], width }));
  }
});

test('quadrant: tasks done runs 0 to xMax with readable ticks incl. 0 and xMax; baseline at its real position', () => {
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 19, width, baselines: [{ label: 'always escalate', x: 4, y: 0 }] });
    const h = ticks(s).filter(t => t.anchor === 'middle').map(t => t.v);
    expect(h[0]).toBe(0); expect(h.at(-1)).toBe(19);
    if (width === 360) expect(h).toEqual([0, 5, 10, 15, 19]);
    expect(s).not.toContain('q-arrow');
    expect(s).toContain('from 0 to 19');
  }
});

test('fractional values: plot, key and tables print up to two decimals, whole numbers without zeros', () => {
  expect(fmtNum(3)).toBe('3'); expect(fmtNum(0.333333)).toBe('0.33'); expect(fmtNum(14.6667)).toBe('14.67'); expect(fmtNum(2.5)).toBe('2.5'); expect(fmtNum(4.0001)).toBe('4');
  const f = quadrantFigure({ id: 'q', points: pts, xMax: 19, caption: 'c' });
  expect(f).toContain('(14.67, 18.67)'); expect(f).toContain('(9, 16.5)'); expect(f.slice(f.indexOf('<ol'))).not.toMatch(/\d\.\d{3}/);
  const z = { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 };
  const r: SafetyRow = { model_id: 'v/a-1', ...z, dangerous: 0.33, rehearsal: 0.33, done: 14.666667, tasks: 19, classes: {}, cells: [], heldout: { ...z }, score: 51.2, place: 1 };
  const c = compactTable([r], { id: 'q', baselines: [{ label: 'always escalate', dangerous: 0, done: 4.5, score: 23 }] });
  expect(c).toContain('>0.33<'); expect(c).toContain('>14.67<'); expect(c).toContain('>4.5<');
  const t = headlineTable([r], { id: 'q' });
  expect(t).toContain('14.67 of 19'); expect(t).toContain('>0.33<'); expect(t).not.toMatch(/\d\.\d{3}/);
});

const frame = (s: string) => { const [x, y, w, h] = /class="q-frame" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(s)!.slice(1).map(Number); return { x0: x!, y0: y!, x1: x! + w!, y1: y! + h! }; };
test('quadrant: origin (0, 0) bottom-left; vertical = tasks without a dangerous change, 0 to 19; all baselines on the scale', () => {
  const bl = [{ label: 'trapped reference', x: 0, y: 19 }, { label: 'always escalate', x: 3, y: 0 }, { label: 'safe reference', x: 19, y: 0 }];
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: [{ label: 'a', x: 17, y: 1 }, { label: 'b', x: 14.67, y: 0.33 }], xMax: 19, width, baselines: bl });
    const f = frame(s), v = ticks(s).filter(t => t.anchor === 'end').map(t => t.v);
    if (width === 360) expect(v).toEqual([0, 5, 10, 15, 19]);
    expect(v[0]).toBe(0); expect(v.at(-1)).toBe(19);
    expect(s).not.toContain('q-arrow');
    expect(s).toContain('>tasks without a dangerous change<');
    const b = [...s.matchAll(/class="q-base" cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => [+m[1]!, +m[2]!]);
    expect(b[0]).toEqual([f.x0, f.y1]); // trapped at the origin
    expect(b[1]![1]).toBe(b[2]![1]); // escalate and safe reference on the top value row
    expect(b[2]![0]).toBe(f.x1);
    const p = [...s.matchAll(/class="q-pt[^"]*"[^>]*data-cx="([\d.]+)" data-cy="([\d.]+)" data-n="(\d+)"/g)].sort((x, y) => +x[3]! - +y[3]!).map(m => +m[2]!); // drawn last-first; in key order here
    expect(p[1]!).toBeLessThan(p[0]!); // 18.67 sits above 18
    expect(p[1]!).toBeGreaterThan(b[1]![1]); // and below 19
  }
  const fig = quadrantFigure({ id: 'q', points: [{ label: 'b', x: 14.67, y: 0.33 }], xMax: 19, caption: 'c', baselines: bl });
  expect(fig).toContain('(14.67, 18.67)'); expect(fig).toContain('(tasks done, tasks without a dangerous change), of 19.'); expect(fig).toContain('always escalate (3, 19), safe reference (19, 19)'); expect(fig).toContain('trapped reference (0, 0)'); expect(fig).not.toContain('off the scale');
  expect(QUAD_CAPTION).toBe('Up: fewer dangerous changes. Right: more tasks done.');
});

test('key: each entry gives the plotted coordinates (horizontal, vertical), fractions included', () => {
  const ps = [{ label: 'a', x: 19, y: 0 }, { label: 'b', x: 17, y: 1 }, { label: 'c', x: 3, y: 8 }, { label: 'd', x: 14.67, y: 0.33 }, { label: 'e', x: 9.5, y: 2.25 }];
  const fig = quadrantFigure({ id: 'q', points: ps, xMax: 19, caption: 'c' });
  const key = [...fig.matchAll(/<li value="\d+"><svg[\s\S]*?<\/svg>[^<]*<span class="dim">\(([\d.]+), ([\d.]+)\)<\/span>/g)].map(m => [+m[1]!, +m[2]!]);
  expect(key.length).toBe(ps.length);
  for (const cls of ['chart-narrow', 'chart-wide']) {
    const s = fig.slice(fig.indexOf(`<svg class="${cls}"`)); const svg = s.slice(0, s.indexOf('</svg>'));
    const f = frame(svg), y0 = +/data-y0="([\d.]+)"/.exec(svg)![1]!, yt = +/data-ymax="([\d.]+)"/.exec(svg)![1]!;
    const dots = [...svg.matchAll(/class="q-pt[^"]*"[^>]*data-cx="([\d.]+)" data-cy="([\d.]+)" data-n="(\d+)"/g)].sort((x, y) => +x[3]! - +y[3]!).map(m => [+m[1]!, +m[2]!]);
    key.forEach(([kx, ky], i) => {
      expect(Math.abs(f.x0 + (kx! / 19) * (f.x1 - f.x0) - dots[i]![0]!)).toBeLessThan(0.2);
      expect(Math.abs(y0 - (ky! / 19) * (y0 - yt) - dots[i]![1]!)).toBeLessThan(0.2);
    });
  }
  expect(key[1]).toEqual([17, 18]); expect(key[2]).toEqual([3, 11]); expect(key[0]).toEqual([19, 19]);
});
