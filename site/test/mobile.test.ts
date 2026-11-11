// Phone layout rules on the built pages: no prose inside <pre>, every table
// either stacks into labelled cards or is the one matrix that scrolls in its
// own box, every text chart has a fluid narrow variant, key: value blocks are
// definition lists, and the .txt twin keeps the aligned text form.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildSite } from '../src/build';
import { toText } from '../src/text';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const published = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const preview = buildSite({ published: false, base: '/' });
const pending = buildSite({ published: false, pending: true, base: '/' });
const sites = { published, preview, pending };
const html = function* () { for (const s of Object.values(sites)) for (const [p, doc] of s) if (p.endsWith('.html')) yield [p, doc] as const; };
const css = readFileSync(join(import.meta.dir, '..', 'assets', 'style.css'), 'utf8');

/** Pre blocks that may stay: charts (with a narrow variant), the title art, the diagram, and verbatim model text. */
export const PRE_ALLOWED = new Set(['chart', 'rating-chart', 'profile-chart', 'title', 'aaa', 'answer', 'prompt']);

test('no page body holds prose inside <pre>: only charts, the title, the diagram and verbatim model text', () => {
  for (const [p, doc] of html()) for (const m of doc.matchAll(/<pre(?: class="([^"]*)")?/g)) expect(PRE_ALLOWED.has((m[1] ?? '').split(' ')[0]!), `${p}: <pre class="${m[1]}">`).toBe(true);
});

test('every chart, diagram and title <pre> has a narrow variant and hides below the breakpoint', () => {
  for (const [p, doc] of html()) {
    const pres = [...doc.matchAll(/<pre class="(chart|rating-chart|profile-chart|aaa)[ "]/g)].length;
    const narrow = [...doc.matchAll(/<!--narrow-->/g)].length;
    expect(narrow, p).toBe(pres);
  }
  expect(css).toMatch(/@media \(max-width: 40rem\)[^]*pre\.chart, pre\.rating-chart, pre\.profile-chart, pre\.aaa \{ display: none; \}/);
  expect(css).toMatch(/\.narrow-only \{ display: none; \}/);
});

test('every table body cell carries data-label, except the header box and the matrix', () => {
  let n = 0;
  for (const [p, doc] of html()) for (const t of doc.matchAll(/<table( class="([^"]*)")?[^>]*>([\s\S]*?)<\/table>/g)) {
    const cls = t[2] ?? '';
    if (/\b(header|matrix)\b/.test(cls)) continue;
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(t[3]!)?.[1] ?? '';
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[1]!.matchAll(/<(td|th)([^>]*)>/g)];
      if (cells.length === 1 && /colspan/.test(cells[0]![2]!)) continue; // a group heading row
      for (const c of cells.filter(c => c[1] === 'td')) { expect(c[2], `${p}: ${tr[0].slice(0, 160)}`).toContain('data-label="'); n++; }
    }
  }
  expect(n).toBeGreaterThan(100);
  expect(css).toMatch(/table:not\(\.header\):not\(\.matrix\) td\[data-label\]::before/);
});

test('key: value blocks are definition lists with a key width, aligned in the .txt twin', () => {
  const home = published.get('index.html')!;
  expect(home).toMatch(/<dl class="kv-grid" style="--kw: \d+ch">/);
  expect(home).toContain('<dt>role under test</dt>');
  expect(home).not.toContain('<pre class="head"');
  for (const k of ['run date', 'scenarios', 'models', 'tracks', 'license']) expect(home).toContain(`<dt>${k}</dt>`);
  const txt = toText(home);
  expect(txt).toMatch(/^role under test: +Analyzer \(the author of the change\)\. The model writes the/m);
  expect(txt).toMatch(/^ {10,}production change itself, or refuses and escalates\.$/m);
  for (const l of txt.slice(txt.indexOf('WHAT WE TEST'), txt.indexOf('HOW TO READ')).split('\n')) expect(l.length, l).toBeLessThanOrEqual(78);
  const lb = published.get('leaderboard/index.html')!;
  expect(lb).not.toContain('kv-points');
  expect(published.get('leaderboard/index.txt')!).toMatch(/^harmful \(measured in the lab\): +-1$/m);
  expect(toText(lb)).not.toContain('<!--');
});

test('narrow variants never reach the .txt twin', () => {
  const txt = published.get('leaderboard/index.txt')!;
  expect(txt).not.toContain('rc-');
  expect([...txt.matchAll(/Rating \(|Rating:/g)].length).toBeLessThanOrEqual(2);
});

test('phone typography: body 15px or more, table text 13px or more, nav tap targets 40px, title scales', () => {
  const m = /@media \(max-width: 40rem\) \{([^]*?)\n\}/.exec(css)!;
  expect(m, 'narrow block').toBeTruthy();
  const b = m[1]!;
  expect(b).toMatch(/:root \{ font-size: 15px; \}/);
  expect(b).toMatch(/table \{ font-size: 0\.875em; \}/);
  expect(b).toMatch(/\.nav a, \.theme button \{[^}]*min-height: 40px/);
  expect(b).toMatch(/pre\.title \{[^}]*font-size: min\(/);
  expect(css).not.toMatch(/font-size: 13px/);
});

test('narrow profile axis: no two tick labels closer than 15 percent', async () => {
  const { profileChart } = await import('../src/profile');
  const counts = Object.fromEntries((await import('../../src/analysis/outcome-map')).PROFILE_CLASSES.map(k => [k, 0])) as any;
  counts.right = 22;
  const h = profileChart({ tasks: 22, tracks: [{ name: 't', rows: [{ model_id: 'x/m', counts }] }] }, { id: 'p', table: false, lede: '' });
  const at = [...h.matchAll(/class="fb-tick[^"]*" style="left: ([\d.]+)%">/g)].map(m => Number(m[1]));
  for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(15);
  expect(at[at.length - 1]).toBe(100);
});

test('rating chart: SVG figure, phone and wide sizes, mid-tone fill from a theme variable, caption italic', () => {
  const lb = published.get('leaderboard/index.html')!;
  expect(lb).toContain('<svg class="chart-narrow"');
  expect(lb).toContain('<svg class="chart-wide"');
  expect(css).toMatch(/@media \(max-width: 40rem\)[^]*svg\.chart-wide \{ display: none; \}/);
  expect(css).toMatch(/svg\.chart-narrow \{ display: none; \}/);
  expect(css).toMatch(/svg\[data-chart\] \{[^}]*display: block; width: 100%; height: calc\(var\(--lh\) \* var\(--h\)\)/);
  expect(css).toMatch(/figure\.svg-chart figcaption \{[^}]*font-style: italic/);
  expect(css).toMatch(/\.ch-bar \{ fill: var\(--chart\); \}/);
  const chart = [...css.matchAll(/--chart: (#[0-9a-f]{6})/g)].map(m => m[1]);
  expect(chart.length).toBe(3);
  expect(chart).not.toContain('#ffffff');
  expect(chart).not.toContain('#e6e6e1');
});
