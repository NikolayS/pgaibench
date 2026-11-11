import { expect, test } from 'bun:test';
import { hbarSvg, shortName, urlSlug, chartFigure } from '../src/svg';

const rows = [
  { label: 'fable-5.2', value: 100, lo: 100, hi: 100 },
  { label: 'qwen3.8-27b', value: 31.6, lo: 8, hi: 58 },
  { label: 'deepseek-v4-pro', value: 5.3, lo: -16, hi: 26 },
  { label: 'neg', value: -12, lo: -30, hi: 4 },
];
const spec = { id: 't', title: 'Score', desc: 'Score per configuration, 0 to 100.', aria: 'fable-5.2 leads.', rows, baselines: [{ label: 'always escalate', value: 28.9, lo: 16, hi: 45 }], notes: ['trapped reference: -50, not drawn'] };

test('short names drop vendor, path, effort and date suffix', () => {
  expect(shortName('anthropic/claude-fable-5.2')).toBe('claude-fable-5.2');
  expect(shortName('google/gemini-4-argon')).toBe('gemini-4-argon');
  expect(shortName('google/gemini-3.8-flash')).toBe('gemini-3.8-flash');
  expect(shortName('openai/gpt-6.1-sol')).toBe('gpt-6.1-sol');
  expect(shortName('deepseek/deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
  expect(shortName('qwen/qwen3.8-27b')).toBe('qwen3.8-27b');
  // URL slugs stay as they were, so old links keep working
  expect(urlSlug('anthropic/claude-fable-5.2')).toBe('fable-5.2'); expect(urlSlug('google/gemini-4-argon')).toBe('argon');
});

test('svg: viewBox, role img, aria-label, title, desc, data-chart, no colour literals, no script or external refs', () => {
  const s = hbarSvg({ ...spec, width: 360 });
  expect(s).toMatch(/^<svg [^>]*viewBox="0 0 360 \d+"/);
  expect(s).toContain('role="img"');
  expect(s).toContain('aria-label="fable-5.2 leads."');
  expect(s).toContain('data-chart="t"');
  expect(s).toContain('<title>Score</title>');
  expect(s).toContain('<desc>Score per configuration, 0 to 100.</desc>');
  expect(s).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|<script|href=|url\(/i);
  expect(s).toContain('font-family="inherit"');
});

test('ticks at 0, 25, 50, 75, 100; one bar per row; value text in bold at the bar end', () => {
  const s = hbarSvg({ ...spec, width: 360 });
  for (const t of [0, 25, 50, 75, 100]) expect(s).toMatch(new RegExp(`class="ch-tick"[^>]*>${t}</text>`));
  expect((s.match(/class="ch-bar"/g) ?? []).length).toBe(3); // the negative row has no bar
  expect((s.match(/class="ch-base"/g) ?? []).length).toBe(1);
  expect(s).toMatch(/class="ch-v"[^>]*font-weight="800"[^>]*>32</);
  expect(s).toContain('>fable-5.2</text>');
});

test('nothing is drawn left of 0: intervals and values below 0 are clipped with a mark', () => {
  const s = hbarSvg({ ...spec, width: 360 });
  const x0 = Number(/data-x0="([\d.]+)"/.exec(s)![1]);
  for (const m of s.matchAll(/ x[12]?="(-?[\d.]+)"/g)) if (!/ch-lbl|ch-note|ch-group/.test(m.input!.slice(m.index! - 60, m.index!))) expect(Number(m[1])).toBeGreaterThanOrEqual(0);
  for (const m of s.matchAll(/<line class="ch-ci" x1="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(x0);
  expect((s.match(/class="ch-clip"/g) ?? []).length).toBe(2); // deepseek interval, neg value
  expect(s).toContain('>trapped reference: -50, not drawn</text>');
});

test('height is a whole number of 20-unit lines and rows are 30 units tall', () => {
  const s = hbarSvg({ ...spec, width: 760 });
  const h = Number(/viewBox="0 0 760 (\d+)"/.exec(s)![1]);
  expect(h % 20).toBe(0);
  expect(s).toMatch(/style="--h: \d+"/);
});

test('figure: two sizes (phone, wide), italic caption, matching table', () => {
  const f = chartFigure({ ...spec, caption: 'Higher is better.', table: '<table class="x" data-chart-for="t"></table>' });
  expect(f).toMatch(/^<figure class="svg-chart" id="t">/);
  expect(f).toContain('class="chart-narrow"');
  expect(f).toContain('class="chart-wide"');
  expect(f).toContain('<figcaption>Higher is better.</figcaption>');
  expect(f).toContain('data-chart-for="t"');
});
