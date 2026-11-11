// Name, copyright, favicon, theme switcher and the "What we test" block.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { BINARY_ASSETS, COPYRIGHT } from '../src/html';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const sites = [buildSite({ published: false, base: '/' }), buildSite({ published: false, pending: true, base: '/' }),
  buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') })];
const html = (m: Map<string, string>) => [...m].filter(([p]) => p.endsWith('.html'));
const root = join(import.meta.dir, '..', '..');

test('every built page carries the copyright line and the licence', () => {
  for (const s of sites) for (const [p, doc] of html(s)) {
    expect(doc, p).toContain(`${COPYRIGHT}. Licensed under Apache-2.0.`);
    expect(COPYRIGHT).toMatch(/^© 2026 \S+ \S+ and DBLab Inc\. \/ Postgres\.AI$/);
  }
});

test('the product name is PGAIBench: "PG AI Bench" appears in no built page and no public doc', () => {
  for (const s of sites) for (const [p, doc] of s) expect(doc, p).not.toContain('PG AI Bench');
  const docs = ['public-overlay/README.md', 'public-overlay/NOTICE', 'public-overlay/CITATION.cff', 'public-overlay/CHANGELOG.md', 'public-overlay/ROADMAP.md', 'public-overlay/CONTRIBUTING.md', 'NOTICE', 'package.json', 'docs/benchmark.md', 'docs/prereg-v0.1.md'];
  for (const d of docs) if (existsSync(join(root, d))) expect(readFileSync(join(root, d), 'utf8'), d).not.toContain('PG AI Bench');
});

test('favicon links on every page, relative to its depth; favicon files are the only images; no img, svg or canvas in pages', () => {
  for (const s of sites) {
    for (const f of BINARY_ASSETS) expect(s.has(`assets/${f}`)).toBe(true);
    expect(s.has('favicon.ico')).toBe(true);
    for (const [p, doc] of html(s)) {
      const up = p === '404.html' ? '' : '../'.repeat(p.split('/').length - 1);
      expect(doc, p).toContain(`<link rel="icon" href="${up}assets/favicon.ico" sizes="32x32">`);
      expect(doc, p).toContain(`<link rel="icon" href="${up}assets/favicon.svg" type="image/svg+xml">`);
      expect(doc, p).toContain('<meta name="theme-color" content="#fbfbf8" media="(prefers-color-scheme: light)">');
      expect(doc.replace(/<head>[\s\S]*<\/head>/, ''), p).not.toMatch(/<(img|canvas)\b|<svg\b(?![^>]*\bdata-chart=)/i);
    }
    const images = [...s.keys()].filter(p => /\.(png|ico|svg|jpe?g|gif|webp)$/i.test(p)).sort();
    expect(images).toEqual([...BINARY_ASSETS.map(f => `assets/${f}`), 'favicon.ico'].sort());
  }
  for (const f of BINARY_ASSETS) expect(statSync(join(import.meta.dir, '..', 'assets', f)).size).toBeGreaterThan(0);
});

test('theme: CSS variables for data-theme light and dark; the system theme without a choice', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'assets', 'style.css'), 'utf8');
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain(':root[data-theme="light"] { color-scheme: light; }');
  expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  const js = readFileSync(join(import.meta.dir, '..', 'assets', 'theme.js'), 'utf8');
  expect(js).toContain("localStorage.removeItem('theme')");
  expect(js).toContain('box.hidden = false');
});

test('"What we test" on home, results and method; AAA diagram on home; Auditor page', () => {
  const s = sites[2]!;
  for (const p of ['index.html', 'leaderboard/index.html', 'method/index.html']) {
    expect(s.get(p), p).toContain('<h2 id="what">What we test</h2>');
    expect(s.get(p), p).toContain('Analyzer (the author of the change)');
  }
  const home = s.get('index.html')!;
  expect(home).toContain('AAA: Analyzer, Auditor, Actor');
  expect(home).toMatch(/Analyzer +-&gt; +Auditor +-&gt; +Actor +-&gt; +Auditor/);
  expect(home).toContain('PGAIBench-Auditor');
  expect(s.get('leaderboard/index.html')).toContain('<h1>PGAIBench-Analyzer: results</h1>');
  const aud = s.get('auditor/index.html')!;
  expect(aud).toContain('Pre-op review'); expect(aud).toContain('Post-op review'); expect(aud).toContain('Results are in preparation');
});

test('limits: plain statements of scope, a disclosure, and known issues point to the results page', () => {
  const l = sites[2]!.get('limits/index.html')!;
  expect(l).not.toContain('Single shot without tools.');
  expect(l).toContain('v0.1 measures one thing: the change a model proposes when it sees the task and a description of the database, in one answer.');
  expect(l).toContain('<h2 id="disclosure">Disclosure</h2>');
  expect(l).not.toContain('None recorded yet');
});

test('no text says models are never compared, never ordered, or that there is no blended or headline score', () => {
  for (const s of sites) for (const [p, doc] of html(s)) expect(doc.replace(/<pre class="prompt"[\s\S]*?<\/pre>/g, ''), p).not.toMatch(/never compared|never order|by a rate|no headline score|no blended score|do not compare models|do not order models/i);
});
