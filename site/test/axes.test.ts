import { expect, test } from 'bun:test';
import { hbarSvg, stackedSvg } from '../src/svg';
import { quadrantSvg, quadrantFigure, compactTable, headlineTable, fmtNum, type SafetyRow } from '../src/safety';

// Owner rule: every numeric axis on the site includes 0 and starts at 0.
// Ticks under the plot (y > frame bottom) are the horizontal axis; ticks with text-anchor end are the vertical axis.
const ticks = (s: string) => [...s.matchAll(/<text class="ch-tick" x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)">([^<]*)<\/text>/g)].map(m => ({ x: +m[1]!, y: +m[2]!, anchor: m[3]!, v: parseFloat(m[4]!) }));
function startsAtZero(s: string) {
  const all = ticks(s);
  const h = all.filter(t => t.anchor === 'middle'), v = all.filter(t => t.anchor === 'end');
  expect(h.length).toBeGreaterThan(0);
  const hl = h.reduce((a, b) => (b.x < a.x ? b : a));
  expect(hl.v).toBe(0);
  if (v.length) expect(v.reduce((a, b) => (b.y < a.y ? b : a)).v).toBe(0); // dangerous changes: 0 at the top
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
    expect(s).not.toContain('q-arrow'); // escalate baseline (4, 0) is inside the scale
    expect(s).toContain('from 0 to 19');
  }
});

test('fractional values: plot, key and tables print up to two decimals, whole numbers without zeros', () => {
  expect(fmtNum(3)).toBe('3'); expect(fmtNum(0.333333)).toBe('0.33'); expect(fmtNum(14.6667)).toBe('14.67'); expect(fmtNum(2.5)).toBe('2.5'); expect(fmtNum(4.0001)).toBe('4');
  const f = quadrantFigure({ id: 'q', points: pts, xMax: 19, caption: 'c' });
  expect(f).toContain('(0.33, 14.67)'); expect(f).toContain('(2.5, 9)'); expect(f.slice(f.indexOf('<ol'))).not.toMatch(/\d\.\d{3}/);
  const z = { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 };
  const r: SafetyRow = { model_id: 'v/a-1', ...z, dangerous: 0.33, rehearsal: 0.33, done: 14.666667, tasks: 19, classes: {}, cells: [], heldout: { ...z }, score: 51.2, place: 1 };
  const c = compactTable([r], { id: 'q', baselines: [{ label: 'always escalate', dangerous: 0, done: 4.5, score: 23 }] });
  expect(c).toContain('>0.33<'); expect(c).toContain('>14.67<'); expect(c).toContain('>4.5<');
  const t = headlineTable([r], { id: 'q' });
  expect(t).toContain('14.67 of 19'); expect(t).toContain('>0.33<'); expect(t).not.toMatch(/\d\.\d{3}/);
});
