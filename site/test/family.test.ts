import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILIES, familyFrom, familyOf, shapeSvg, shapeArea, swatch } from '../src/family';
import { quadrantSvg, quadrantFigure, placeMarks } from '../src/safety';

const models = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'models.json'), 'utf8')) as { id: string; vendor: string; open_weights: boolean }[];

test('every configuration has a family from models.json (vendor, open_weights), and every family a shape; shapes are distinct', () => {
  for (const m of models) { const f = familyFrom(m); expect(FAMILIES[f], m.id).toBeDefined(); expect(familyOf(m.id)).toBe(f); }
  for (const m of models.filter(x => x.open_weights)) expect(familyOf(m.id)).toBe('open');
  expect(familyOf('anthropic/claude-fable-5.2')).toBe('anthropic'); expect(familyOf('openai/gpt-6-luna')).toBe('openai'); expect(familyOf('google/gemini-4-argon')).toBe('google'); expect(familyOf('qwen/qwen3.8-27b')).toBe('open'); expect(familyOf('deepseek/deepseek-v4-pro-0813')).toBe('open');
  const shapes = Object.values(FAMILIES).map(f => f.shape);
  expect(new Set(shapes).size).toBe(shapes.length);
  expect(FAMILIES.anthropic!.shape).toBe('circle'); expect(FAMILIES.openai!.shape).toBe('square'); expect(FAMILIES.google!.shape).toBe('triangle'); expect(FAMILIES.open!.shape).toBe('diamond');
  expect(familyOf('nobody/unknown-model')).toBe('other');
});

test('shapes have equal area (within 2 percent)', () => {
  const a = Object.values(FAMILIES).map(f => shapeArea(f.shape));
  for (const x of a) expect(Math.abs(x / a[0]! - 1)).toBeLessThan(0.02);
});

test('plot: each point drawn as its family shape with the family class; baselines stay hollow circles', () => {
  const pts = [{ label: 'a', x: 19, y: 0, family: 'anthropic' }, { label: 'b', x: 17, y: 1, family: 'openai' }, { label: 'c', x: 12, y: 1, family: 'google' }, { label: 'd', x: 3, y: 8, family: 'open' }];
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 19, width, baselines: [{ label: 't', x: 0, y: 19 }] });
    for (const f of ['anthropic', 'openai', 'google', 'open']) expect(s).toMatch(new RegExp(`class="q-pt q-f-${f}"`));
    expect(s).toMatch(/<circle class="q-base"/);
    expect(s).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(shapeSvg('square', 10, 10, 'x')).toMatch(/^<rect /); expect(shapeSvg('triangle', 10, 10, 'x')).toMatch(/^<path /);
  }
});

test('figure: one legend line with SVG swatches for the families shown plus baseline; each key entry starts with its swatch', () => {
  const f = quadrantFigure({ id: 'q', points: [{ label: 'a', x: 19, y: 0, family: 'anthropic' }, { label: 'd', x: 3, y: 8, family: 'open' }], xMax: 19, caption: 'c', baselines: [{ label: 't', x: 0, y: 19 }] });
  const leg = /<p class="qlegend">([\s\S]*?)<\/p>/.exec(f)![1]!;
  expect(leg).toContain('Anthropic'); expect(leg).toContain('open-weight'); expect(leg).toContain('baseline'); expect(leg).not.toContain('OpenAI');
  expect((leg.match(/<svg class="fsw/g) ?? []).length).toBe(3);
  expect(f.indexOf('class="qlegend"')).toBeGreaterThan(f.indexOf('</figcaption>'));
  expect(f).toMatch(/<li value="1"><svg class="fsw fsw-anthropic"[^>]*>[\s\S]*?<\/svg> ?a /);
  expect(f).toMatch(/<li value="2"><svg class="fsw fsw-open"/);
  expect(swatch('google')).toContain('aria-hidden="true"');
});

test('number marks clear the larger shapes (half size 8) on a crowded row', () => {
  const ps = [13, 14, 15, 16, 17, 19].map((x, i) => ({ n: i + 1, cx: 28 + x * 16.8, cy: 48 }));
  const marks = placeMarks(ps, 360);
  for (const m of marks) for (const p of ps) expect(m.box.x0 < p.cx + 8 && p.cx - 8 < m.box.x1 && m.box.y0 < p.cy + 8 && p.cy - 8 < m.box.y1, `${m.n} on ${p.n}`).toBe(false);
});

test('theme: a light and a dark colour per family as CSS variables, no brand names in them', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'site', 'assets', 'style.css'), 'utf8');
  for (const f of ['anthropic', 'openai', 'google', 'open']) { expect((css.match(new RegExp(`--fam-${f}:`, 'g')) ?? []).length).toBeGreaterThanOrEqual(3); expect(css).toContain(`.q-f-${f}`); }
});

test('number marks stay inside the frame (below its top line) with a full top row of shapes', () => {
  const pts = [13, 14, 15, 16, 17, 19, 12, 17].map((x, i) => ({ label: `m${i}`, x, y: i < 6 ? 0 : 1, n: i + 1, family: ['anthropic', 'openai', 'google', 'open'][i % 4] }));
  for (const width of [360, 760]) {
    const s = quadrantSvg({ id: 'q', points: pts, xMax: 19, width, baselines: [{ label: 'e', x: 3, y: 0 }] });
    const top = +/class="q-frame" x="[\d.]+" y="([\d.]+)"/.exec(s)![1]!;
    for (const m of s.matchAll(/class="q-num"[^>]*data-box="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/g)) expect(+m[2]!, `${width}`).toBeGreaterThanOrEqual(top);
  }
});

test('family colours follow each vendor brand hue, with at least 3:1 contrast in both themes', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'site', 'assets', 'style.css'), 'utf8');
  const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (h: string) => { const [r, g, b] = rgb(h).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
  const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const hue = (h: string) => { const [r, g, b] = rgb(h) as [number, number, number]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; const k = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (k * 60 + 360) % 360; };
  const blocks = [...css.matchAll(/--bg: (#[0-9a-f]{6});[^}]*?--fam-anthropic: (#[0-9a-f]{6}); --fam-openai: (#[0-9a-f]{6}); --fam-google: (#[0-9a-f]{6}); --fam-open: (#[0-9a-f]{6});/gi)];
  expect(blocks.length).toBe(3); // light, dark (system), dark (chosen)
  // brand hues: Anthropic clay orange, OpenAI green, Google blue, open weights purple
  const want: [number, number][] = [[10, 30], [150, 175], [210, 225], [270, 300]];
  for (const m of blocks) m.slice(2, 6).forEach((c, i) => {
    expect(contrast(c!, m[1]!), `${c} on ${m[1]}`).toBeGreaterThanOrEqual(3);
    const h = hue(c!); expect(h >= want[i]![0] && h <= want[i]![1], `${c} hue ${h}`).toBe(true);
  });
});
