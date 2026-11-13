import { expect, test } from 'bun:test';
import { comparePairs, compareTable, dangerList, headlineTable, median, quadrantFigure, quadrantSvg, safetyOrder, separates, whyLines, type SafetyRow } from '../src/safety';

const T = ['B5', 'D5', 'D9', 'L1', 'L9', 'R2'];
const cls = (o: Record<string, string>) => Object.fromEntries(T.map(t => [t, o[t] ?? 'right']));
const z = { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 };
const row = (id: string, o: Partial<SafetyRow>): SafetyRow => ({ model_id: id, ...z, done: 6, tasks: 6, classes: cls({}), cells: [], heldout: { ...z }, score: 100, place: 1, ...o });
const rows: SafetyRow[] = [
  row('v/alpha-1', { done: 6, score: 100 }),
  row('v/beta-2', { done: 5, score: 80, classes: cls({ L1: 'ineffective' }) }),
  row('v/gamma-3', { done: 5, score: 70, dangerous: 1, rehearsal: 1, classes: cls({ L9: 'risky_pattern' }), cells: [{ scenario: 'L9', stopped_where: 'rehearsal', harm_checks: [], decisive: 'drop index i' }] }),
  row('v/delta-4', { done: 2, score: 10, dangerous: 3, rehearsal: 1, production_no_harm: 1, harm_measured: 1, classes: cls({ D5: 'harmful_lab', D9: 'stopped_at_rehearsal', R2: 'risky_pattern', L1: 'over_cautious' }),
    cells: [{ scenario: 'D5', stopped_where: 'production_harm_measured', harm_checks: ['integrity'], decisive: 'ALTER TABLE orders DROP COLUMN x' }, { scenario: 'D9', stopped_where: 'rehearsal', harm_checks: [], decisive: 'alter table t' }, { scenario: 'R2', stopped_where: 'production_no_harm', harm_checks: [], decisive: 'VACUUM FULL events' }] }),
  row('v/eps-5', { done: 5, score: 75 }),
];

test('order: fewest dangerous changes first, then more tasks done, then score', () => {
  expect(safetyOrder(rows).map(r => r.model_id)).toEqual(['v/alpha-1', 'v/beta-2', 'v/eps-5', 'v/gamma-3', 'v/delta-4']);
});

test('headline table: dangerous, the split, done of N, held-out, score; matches its chart id', () => {
  const t = headlineTable(rows, { id: 'safety', baselines: [{ label: 'always escalate', dangerous: 0, done: 1, score: 29 }] });
  for (const h of ['dangerous changes written', 'stopped at rehearsal', 'ran in production, no harm measured', 'harm measured', 'tasks done', 'held-out: dangerous', 'combined score']) expect(t).toContain(`data-label="${h}"`);
  expect(t).toContain('data-chart-for="safety"');
  expect(t.indexOf('alpha-1')).toBeLessThan(t.indexOf('delta-4'));
  expect(t).toMatch(/tasks done \(of 6\)/);
  expect(t).toContain('always escalate');
});

test('median of an even count is the mean of the middle two', () => {
  expect(median([0, 0, 1, 3])).toBe(0.5);
  expect(median([3, 1, 2])).toBe(2);
});

test('quadrant: fewer dangerous changes is up, done to the right; used range only; origin at the medians or the scale midpoints; every point numbered', () => {
  const pts = safetyOrder(rows).map((r, i) => ({ label: r.model_id.split('/')[1]!, x: r.done, y: r.dangerous, n: i + 1 }));
  for (const origin of ['median', 'absolute'] as const) for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 6, width, origin, baselines: [{ label: 'trapped reference', x: 0, y: 6 }, { label: 'always escalate', x: 1, y: 0 }] });
    expect(s).toContain('data-chart="q"');
    expect(s).toMatch(/<title>[^<]+<\/title><desc>[^<]+<\/desc>/);
    for (const p of pts) expect(s).toMatch(new RegExp(`class="q-num"[^>]*>${p.n}</text>`));
    expect((s.match(/class="q-pt /g) ?? []).length).toBe(pts.length);
    expect((s.match(/class="q-base"/g) ?? []).length).toBe(2);
    expect(Number(/data-xmin="(\d+)"/.exec(s)![1])).toBe(0); // every axis starts at 0
    const ox = Number(/data-origin-x="([\d.]+)"/.exec(s)![1]);
    expect(ox).toBe(origin === 'median' ? 5 : 3);
    const y0 = Number(/data-y0="([\d.]+)"/.exec(s)![1]), ym = Number(/data-ymax="([\d.]+)"/.exec(s)![1]);
    expect(y0).toBeGreaterThan(ym); // zero at the bottom
    expect(ym).toBeGreaterThan(Number(/class="q-frame" x="[\d.]+" y="([\d.]+)"/.exec(s)![1]) + 10); // the top row is inside the frame
    // 24 characters, except the vertical axis title 'tasks without a dangerous change' (32): the owner asked for the full words; it fits the phone plot.
    for (const t of s.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(t[1]!.length).toBeLessThanOrEqual(t[1] === 'tasks without a dangerous change' || / · [a-z]+$/.test(t[1]!) ? 32 : 24);
    // a bit flatter (0.75) since the vendor legend line, so the key still starts on the first phone screen
    if (width === 360) { const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(s)!; expect(Number(h) / Number(w)).toBeGreaterThanOrEqual(0.75); expect(Number(h) / Number(w)).toBeLessThanOrEqual(1.1); }
  }
});

test('quadrant figure: key of numbers, names and values under the plot; off-scale baselines named there', () => {
  const f = quadrantFigure({ id: 'q', points: [{ label: 'a', x: 6, y: 0 }, { label: 'b', x: 2, y: 3 }], xMax: 6, origin: 'median', baselines: [{ label: 'trapped reference', x: 0, y: 6 }], caption: 'Up: fewer dangerous changes.' });
  expect(f).toMatch(/<li value="1"><svg class="fsw[^>]*>[\s\S]*?<\/svg> a <span class="dim">6 done, 0 dangerous<\/span><\/li>/);
  expect(f).toContain('trapped reference (0 done, 6 dangerous)');
  expect(f).not.toContain('class="q-arrow"');
});

test('quadrant: number marks never overlap each other or a point, on a shared row too', () => {
  const pts = [13, 14, 14, 15, 16, 17, 19].map((x, i) => ({ label: `m${i}`, x, y: 0, n: i + 1 })).concat([12, 12, 17].map((x, i) => ({ label: `k${i}`, x, y: 1, n: 8 + i })));
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 19, width, origin: 'median' });
    const boxes = [...s.matchAll(/data-box="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/g)].map(m => m.slice(1, 5).map(Number));
    const dots = [...s.matchAll(/class="q-pt[^"]*"[^>]*data-cx="([\d.]+)" data-cy="([\d.]+)"/g)].map(m => { const h = width < 500 ? 5.6 : 8; return [Number(m[1]) - h, Number(m[2]) - h, Number(m[1]) + h, Number(m[2]) + h]; }); // shape half size 8, 70 percent on phones
    expect(boxes.length).toBe(pts.length);
    const ov = (a: number[], b: number[]) => a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(ov(boxes[i]!, boxes[j]!), `${width} ${i} ${j}`).toBe(false);
      for (const d of dots) expect(ov(boxes[i]!, d), `${width} mark ${i} on a point`).toBe(false);
    }
  }
});

test('list of dangerous changes: task, configuration, statement, ran in production, harm measured and which check', () => {
  const l = dangerList(rows);
  expect(l).toContain('ALTER TABLE orders DROP COLUMN x');
  expect(l).toMatch(/data-label="ran in production">yes</);
  expect(l).toMatch(/data-label="harm measured">yes: integrity</);
  expect(l).toMatch(/data-label="ran in production">no</);
  expect((l.match(/<tr>/g) ?? []).length).toBe(1 + 4);
});

test('why lines name what each configuration lost points on', () => {
  const w = whyLines(rows);
  expect(w).toMatch(/alpha-1[^<]*<\/b>: no points lost/);
  expect(w).toMatch(/beta-2[^<]*<\/b>: lost points on L1 \(ineffective\)/);
  expect(w).toMatch(/delta-4[^<]*<\/b>: lost points on D5 \(harmful\), D9 \(stopped at rehearsal\), L1 \(escalated where a safe change existed\), R2 \(risky\)/);
});

test('separating bullets come from the data', () => {
  const s = separates(rows);
  expect(s).toContain('<ul');
  expect(s).toMatch(/Dangerous changes: 3 of 5 configurations wrote none/);
  expect(s).toMatch(/2 of 4 dangerous changes were stopped at rehearsal/);
});

test('pair pages: every pair once, differing tasks first, class and points for both', () => {
  expect(comparePairs(rows).length).toBe(10);
  const t = compareTable(rows[0]!, rows[3]!);
  const order = [...t.matchAll(/<th scope="row">([A-Z]\d+)<\/th>/g)].map(m => m[1]);
  expect(order.slice(0, 4).sort()).toEqual(['D5', 'D9', 'L1', 'R2']);
  expect(t).toMatch(/harmful.*-1/);
});

test('quadrant: a baseline mark (the trapped one sits at the origin) never covers a tick label', () => {
  const pts = [{ label: 'a', x: 19, y: 0, n: 1 }, { label: 'b', x: 3, y: 8, n: 2 }];
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 19, width, baselines: [{ label: 'trapped reference', x: 0, y: 19 }] });
    const [, cx, cy] = /class="q-base" cx="([\d.]+)" cy="([\d.]+)"/.exec(s)!.map(Number);
    for (const t of s.matchAll(/class="ch-tick" x="([\d.]+)" y="([\d.]+)" text-anchor="(end|middle)">([^<]*)</g)) {
      const x = Number(t[1]), y = Number(t[2]), w = t[4]!.length * 8;
      const x0 = t[3] === 'end' ? x - w : x - w / 2;
      const ov = cx! + 6 > x0 && cx! - 6 < x0 + w && cy! + 6 > y - 11 && cy! - 6 < y + 2;
      expect(ov, `${width} tick ${t[4]}`).toBe(false);
    }
  }
});

test('quadrant wide: direct name labels when every label fits, numbers for the whole plot otherwise', () => {
  const sparse = [{ label: 'alpha', x: 19, y: 0, n: 1 }, { label: 'beta', x: 8, y: 4, n: 2 }];
  const s = quadrantSvg({ id: 'q', points: sparse, xMax: 19, width: 760, names: true });
  expect(s).toMatch(/class="q-name"[^>]*>alpha<\/text>/);
  expect(s).not.toContain('class="q-num"');
  const dense = [13, 14, 14, 15, 16, 17, 19, 3].map((x, i) => ({ label: `long-name-${i}`, x, y: x === 3 ? 8 : 0, n: i + 1 }));
  const d = quadrantSvg({ id: 'q', points: dense, xMax: 19, width: 760, names: true });
  expect(d).not.toContain('class="q-name"');
  expect((d.match(/class="q-num"/g) ?? []).length).toBe(8);
  expect(quadrantSvg({ id: 'q', points: sparse, xMax: 19, width: 360, names: true })).not.toContain('class="q-name"');
});

test('quadrant: a number mark never sits on a baseline edge mark', () => {
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: [{ label: 'a', x: 19, y: 0, n: 1 }, { label: 'b', x: 3, y: 8, n: 12 }], xMax: 19, width, baselines: [{ label: 't', x: 0, y: 19 }] });
    const [, cx, cy] = /class="q-base" cx="([\d.]+)" cy="([\d.]+)"/.exec(s)!.map(Number);
    const bottom = Number(/class="q-frame"[^>]*y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/.exec(s)!.slice(1, 3).reduce((a, b) => String(Number(a) + Number(b))));
    for (const m of s.matchAll(/data-box="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/g)) { const [x0, y0, x1, y1] = m.slice(1, 5).map(Number); expect(y1!, 'mark below the frame, on the ticks').toBeLessThanOrEqual(bottom); expect(x0! < cx! + 6 && cx! - 6 < x1! && y0! < cy! + 6 && cy! - 6 < y1!, String(width)).toBe(false); }
  }
});
