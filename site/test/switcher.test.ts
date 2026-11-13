// Chart switcher on the two-axis plot (owner, 2026-11-11): default view without JavaScript, filters in a small script.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quadrantSvg, quadrantFigure, type QPoint } from '../src/safety';

await import('../assets/plot.js');
const F = (globalThis as unknown as { PlotFilter: any }).PlotFilter;

const base: QPoint[] = [
  { label: 'claude-fable-5.2 · high', x: 18.33, y: 0, n: 1, family: 'anthropic', model: 'claude-fable-5.2', effort: 'high', main: true },
  { label: 'gpt-6.1-terra · medium', x: 14, y: 0, n: 2, family: 'openai', model: 'gpt-6.1-terra', effort: 'medium', main: true },
  { label: 'gemini-4-argon · default', x: 16, y: 0, n: 3, family: 'google', model: 'gemini-4-argon', effort: 'default', main: true },
];
const extra: QPoint[] = [{ label: 'gpt-6.1-terra · high (one run)', x: 15, y: 0, n: 4, family: 'openai', model: 'gpt-6.1-terra', effort: 'high', main: false, oneRun: true }];
const strip = (s: string) => s.replace(/<[^>]*class="[^"]*\bq-off\b[^"]*"[^>]*\/>/g, '').replace(/<(text|polyline)[^>]*class="[^"]*\bq-off\b[^"]*"[^>]*>[^<]*<\/\1>/g, '').replace(/ data-(family|model|effort|main|onerun)="[^"]*"/g, '');

test('default SVG: unchanged in content when the extra points are added (they start hidden)', () => {
  for (const width of [360, 760]) {
    const a = quadrantSvg({ id: 'q', points: base, xMax: 19, width });
    const b = quadrantSvg({ id: 'q', points: [...base, ...extra], xMax: 19, width });
    expect(strip(b)).toBe(strip(a));
    expect(b).toContain('q-one');
  }
});

test('every configuration has a point element with family, model and effort; numbers stable; key coordinates equal the plot', () => {
  const fig = quadrantFigure({ id: 'q', points: [...base, ...extra], xMax: 19, caption: 'c' });
  for (const p of [...base, ...extra]) {
    expect(fig).toMatch(new RegExp(`class="q-pt[^"]*"[^>]*data-n="${p.n}" data-family="${p.family}" data-model="${p.model}" data-effort="${p.effort}"`));
    expect(fig).toMatch(new RegExp(`<li value="${p.n}"[^>]*data-family="${p.family}" data-model="${p.model}" data-effort="${p.effort}"`));
  }
  expect(fig).toMatch(/<li value="4"[^>]*hidden/);
  expect(fig).toContain('gpt-6.1-terra · high (one run) <span class="dim">15 done, 0 dangerous</span>');
  expect(fig).toMatch(/<polyline class="q-line q-off" data-model="gpt-6.1-terra"/);
  // controls: hidden without JavaScript, above the plot
  expect(fig).toMatch(/<div class="qctl" data-for="q" hidden>/);
  expect(fig.indexOf('class="qctl"')).toBeGreaterThan(fig.indexOf('<svg')); // owner, 2026-11-12: controls under the chart
  for (const w of ['Anthropic', 'OpenAI', 'Google', 'high', 'medium', 'default', 'reset', 'one run', 'one model, all levels']) expect(fig).toContain(w);
});

const P = { family: 'openai', model: 'gpt-6.1-terra', effort: 'medium', main: true, oneRun: false };
const X = { family: 'openai', model: 'gpt-6.1-terra', effort: 'high', main: false, oneRun: true };
const A = { family: 'anthropic', model: 'claude-fable-5.2', effort: 'high', main: true, oneRun: false };
test('filter logic: defaults show main points only; families and efforts toggle; one model shows all its levels, others dim', () => {
  const d = F.defaults();
  expect([P, X, A].map(p => F.show(p, d))).toEqual(['on', 'off', 'on']);
  expect(F.show(P, { ...d, off: ['f:openai'] })).toBe('off');
  expect(F.show(A, { ...d, off: ['e:high'] })).toBe('off');
  expect(F.show(X, { ...d, oneRun: true })).toBe('on');
  expect(F.show(X, { ...d, oneRun: true, off: ['e:high'] })).toBe('off');
  const m = { ...d, model: 'gpt-6.1-terra' };
  expect([P, X, A].map(p => F.show(p, m))).toEqual(['on', 'on', 'dim']);
  expect(F.lineOrder([X, A, P], 'gpt-6.1-terra').map((p: { effort: string }) => p.effort)).toEqual(['high', 'medium']);
});

test('hash round-trip; the default state has no hash; junk is ignored', () => {
  const s = { off: ['e:default', 'f:open'], levels: true, oneRun: true, model: 'gpt-6.1-terra' };
  expect(F.fromHash(F.toHash(s))).toEqual(s);
  expect(F.toHash(F.defaults())).toBe('');
  expect(F.fromHash('#plot=-f:openai,bogus,<x>')).toEqual({ ...F.defaults(), off: ['f:openai'] });
  expect(F.fromHash('')).toEqual(F.defaults());
});

test('no JavaScript: controls hidden, extra points hidden by CSS; the script is loaded on every page', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'assets', 'style.css'), 'utf8');
  expect(css).toMatch(/\.q-off\s*\{\s*display:\s*none/);
  expect(css).toMatch(/\.qctl\[hidden\]/);
});
