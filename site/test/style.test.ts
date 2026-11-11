import { THEME_HEAD } from '../src/html';
import { barsToText } from '../src/bars';
// Text-first style: monospace, no images, text charts with tables,
// relative links, GitHub Pages files, two colour themes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { BAR_WIDTH } from '../src/chart';
import { CITATIONS } from '../src/pages';
import { REPO } from '../src/html';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const fixture = () => JSON.parse(readFileSync(fx('results/results.json'), 'utf8'));
const sites = {
  plain: buildSite({ published: false, base: '/pgaibench/' }),
  fixture: buildSite({ published: false, base: '/pgaibench/', resultsJson: fixture(), frozenPath: fx('frozen.example.json'), cellsJson: JSON.parse(readFileSync(fx('results/cells.json'), 'utf8')) }),
  published: buildSite({ published: true, base: '/pgaibench/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') }),
};
const all = Object.entries(sites);
const html = (m: Map<string, string>) => [...m].filter(([p]) => p.endsWith('.html'));
const css = sites.plain.get('assets/style.css')!;
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('no graphics', () => {
  test('no img, canvas, picture or iframe in any file; svg only as a build-generated chart (data-chart)', () => {
    for (const [n, s] of all) for (const [p, doc] of s) {
      expect(doc, `${n} ${p}`).not.toMatch(/<(img|canvas|picture|iframe|video|object|embed)\b/i);
      if (!p.endsWith('.svg')) expect(doc, `${n} ${p}`).not.toMatch(/<svg\b(?![^>]*\bdata-chart=)/i);
    }
  });
  test('every chart SVG has a title, a desc, role img, an aria-label and a matching table on the same page', () => {
    let seen = 0;
    for (const [n, s] of all) for (const [p, doc] of html(s)) for (const m of doc.matchAll(/<svg\b[^>]*data-chart="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g)) {
      seen++;
      expect(m[0], `${n} ${p}`).toMatch(/role="img"/);
      expect(m[0], `${n} ${p}`).toMatch(/aria-label="[^"]{10,}"/);
      expect(m[2], `${n} ${p}`).toMatch(/^<title>[^<]+<\/title><desc>[^<]+<\/desc>/);
      expect(m[2], `${n} ${p}`).not.toMatch(/<(script|image|foreignObject|use)\b|href=/);
      expect(doc, `${n} ${p} ${m[1]}`).toContain(`data-chart-for="${m[1]}"`);
    }
    expect(seen).toBeGreaterThan(0);
  });
  test('the .txt twin keeps the chart table and has no svg', () => {
    const t = sites.published.get('leaderboard/index.txt')!;
    expect(t).not.toMatch(/<svg|<\/?text\b/);
    expect(t).toContain('baselines (no model)');
    expect(t).toMatch(/^model-a +1 \(1-2\)|^1 \(1-2\) +model-a/m);
  });
  test('the stylesheet has no url(), import, web font, gradient, shadow or rounded corner', () => {
    const rest = css.replace(/^\.bx[^{]*\{[^}]*\}$/gm, ''); // bar patterns (bars.ts) are the only gradients
    expect(rest).not.toMatch(/url\(|@import|@font-face|gradient|box-shadow|text-shadow|border-radius|filter:/i);
    expect(css).not.toMatch(/url\(|@import|@font-face|text-shadow|border-radius|filter:/i);
  });
  test('no external URL in CSS or in any src attribute', () => {
    expect(css).not.toMatch(/https?:/);
    for (const [n, s] of all) for (const [p, doc] of html(s)) expect(doc, `${n} ${p}`).not.toMatch(/\bsrc="(?:https?:)?\/\//);
  });
});

describe('monospace', () => {
  test('one monospace stack, no other font family', () => {
    expect(css).toContain('ui-monospace, "SF Mono", Menlo, Consolas, monospace');
    const families = [...css.matchAll(/font-family:\s*([^;}]+)/g)].map(m => m[1]!.trim());
    expect(families.length).toBeGreaterThan(0);
    for (const f of families) expect(f).toMatch(/^(var\(--mono\)|inherit)$/);
    expect(css).not.toMatch(/\bfont:\s/);
  });
});

describe('themes and width', () => {
  const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1]!, m[2]!]));
  const light = vars(css.split('@media (prefers-color-scheme: dark)')[0]!);
  const dark = vars(css.split('@media (prefers-color-scheme: dark)')[1]!.split('}')[0]!);
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  test('both colour themes are defined', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('color-scheme: light dark');
    for (const t of [light, dark]) for (const k of ['bg', 'ink', 'muted', 'accent']) expect(t[k], k).toMatch(/^#/);
    expect(light.bg).not.toBe(dark.bg);
  });
  test('text colours meet WCAG AA (4.5:1) in both themes', () => {
    for (const t of [light, dark]) for (const k of ['ink', 'muted', 'accent']) expect(ratio(t[k]!, t.bg!), k).toBeGreaterThanOrEqual(4.5);
  });
  test('page width rule: prose at 80 columns, wide blocks scroll inside themselves', () => {
    expect(css).toMatch(/\.wrap\s*\{[^}]*max-width:\s*calc\(min\(80ch, round\(down, 100%, 1ch\)\)\)/);
    expect(css).toMatch(/--lh:\s*[\d.]+rem/);
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/pre\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*hidden|body\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe('per-metric charts', () => {
  const charts = (doc: string) => [...doc.matchAll(/<svg class="chart-wide"[^>]*data-chart="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g)].map(m => ({ id: m[1]!, body: m[2]! }));
  const tableFor = (doc: string, id: string) => {
    const t = new RegExp(`<table[^>]*data-chart-for="${id}"[^>]*>([\\s\\S]*?)</table>`).exec(doc);
    if (!t) return null;
    return [...t[1]!.matchAll(/<tr[^>]*data-k="(\d+)" data-n="(\d+)" data-lo="([\d.]+)" data-hi="([\d.]+)"[^>]*><th scope="row">([^<]+)<\/th>/g)]
      .map(m => ({ k: +m[1]!, n: +m[2]!, lo: +m[3]!, hi: +m[4]!, label: unesc(m[5]!) }));
  };
  test('per-metric charts are SVG figures with a table of the same numbers; bars linear from zero', () => {
    let checked = 0;
    for (const [, s] of [['fixture', sites.fixture], ['published', sites.published]] as const) for (const [p, doc] of html(s)) for (const c of charts(doc)) {
      if (!/-(right|harm)$/.test(c.id)) continue;
      const t = tableFor(doc, c.id)!;
      expect(t, `${p} ${c.id}`).not.toBeNull();
      const x0 = Number(/data-x0="([\d.]+)"/.exec(doc.slice(doc.indexOf(`data-chart="${c.id}"`) - 400))![1]);
      const ticks = [...c.body.matchAll(/<line class="ch-(?:zero|grid)" x1="([\d.]+)"/g)].map(m => Number(m[1]));
      expect(ticks.length).toBe(5);
      const span = ticks[4]! - ticks[0]!;
      for (let i = 1; i < 5; i++) expect(Math.abs(ticks[i]! - ticks[i - 1]! - span / 4)).toBeLessThan(0.2);
      expect(c.body).toMatch(/>0%<\/text>[\s\S]*>100%<\/text>/);
      const vals = [...c.body.matchAll(/class="ch-v"[^>]*>(\d+)%?</g)].map(m => Number(m[1]));
      expect(vals.length, `${p} ${c.id}`).toBe(t.length);
      t.forEach((r, i) => { expect(vals[i]).toBe(Math.round(100 * r.k / r.n)); checked++; });
      const bars = [...c.body.matchAll(/class="ch-bar" x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
      for (const m of bars) expect(Number(m[1])).toBe(x0);
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('links and GitHub Pages', () => {
  test('every href and src is relative, except the repository and the fixed citation list', () => {
    const allowed = (u: string) => u.startsWith(REPO) || CITATIONS.includes(u);
    for (const [n, s] of all) for (const [p, doc] of html(s)) {
      const body = p === '404.html' ? doc.replace(/<base href="[^"]*">/, '') : doc;
      for (const m of body.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
        const u = unesc(m[1]!);
        expect(u, `${n} ${p}`).not.toMatch(/^\//);
        if (/^[a-z]+:/i.test(u)) expect(allowed(u), `${n} ${p}: ${u}`).toBe(true);
      }
    }
  });
  test('CITATIONS is short and every entry is https', () => {
    expect(CITATIONS.length).toBeLessThanOrEqual(30);
    for (const c of CITATIONS) expect(c).toMatch(/^https:\/\//);
  });
  test('only the 404 page uses a base element, set to the base path', () => {
    for (const [, s] of all) for (const [p, doc] of html(s)) {
      if (p === '404.html') expect(doc).toContain('<base href="/pgaibench/">');
      else expect(doc, p).not.toContain('<base ');
    }
  });
  test('.nojekyll and 404.html are in the build', () => {
    for (const [, s] of all) { expect(s.has('.nojekyll')).toBe(true); expect(s.has('404.html')).toBe(true); }
  });
});

describe('page structure', () => {
  test('every page opens with a bordered header table: title, version, commit, updated', () => {
    for (const [p, doc] of html(sites.published)) {
      const t = /<table class="header">([\s\S]*?)<\/table>/.exec(doc);
      expect(t, p).not.toBeNull();
      for (const k of ['<h1>', '>Version<', '>Commit<', '>Updated<']) expect(t![1], p).toContain(k);
    }
    expect(sites.published.get('leaderboard/index.html')!).toMatch(/<th[^>]*>Updated<\/th><td[^>]*>2026-01-02<\/td>/);
    expect(css).toMatch(/\.header th, \.header td|table\.header/);
  });
  test('the home page has an ASCII title block, hidden from screen readers, and a report prompt', () => {
    const h = sites.plain.get('index.html')!;
    const t = /<pre class="title" aria-hidden="true">([\s\S]*?)<\/pre>/.exec(h)![1]!;
    expect(barsToText(t)).toMatch(/^[# \n]+$/);
    expect(h).toContain('-- pgaibench report --');
  });
  test('the cursor blink is CSS only and stops under prefers-reduced-motion', () => {
    expect(css).toMatch(/@keyframes blink/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.cursor\s*\{[^}]*animation:\s*none/);
  });
  test('the footer credits the style and the CSS keeps the MIT notice', () => {
    for (const [p, doc] of html(sites.plain)) expect(doc, p).toContain('Style inspired by The Monospace Web');
    expect(css).toContain('Copyright 2024 Oskar Wickström');
    expect(css).toContain('Permission is hereby granted, free of charge');
  });
  test('CNAME is written only when configured', () => {
    expect(sites.plain.has('CNAME')).toBe(false);
    expect(buildSite({ published: false, base: '/', cname: 'pgaibench.dev' }).get('CNAME')).toBe('pgaibench.dev\n');
    expect(() => buildSite({ published: false, base: '/', cname: 'not a host' })).toThrow(/CNAME/);
  });
  test('the home page opens with a header block of key: value lines', () => {
    for (const s of [sites.plain, sites.published]) {
      const h = /<div class="head"[^>]*>([\s\S]*?)<\/div>/.exec(s.get('index.html')!)![1]!;
      for (const k of ['run date', 'scenarios', 'models', 'tracks', 'license']) expect(h).toContain(`<dt>${k}</dt>`);
    }
    expect(sites.plain.get('index.html')!).toContain('How to read this');
  });
  test('the nav is one plain text line on every page', () => {
    for (const [p, doc] of html(sites.plain)) expect(doc.replace(/<\/?span( class="ni")?>/g, ""), p).toMatch(/<nav class="nav" aria-label="Main">\[<a [^>]+>home<\/a>\] \[<a /);
  });
  test('outcome classes carry ASCII tags, not colour alone', () => {
    const m = sites.plain.get('method/index.html')!;
    for (const t of ['[ok]', '[harm]', '[esc]', '[inef]', '[rev]', '[stop]', '[risk]']) expect(m).toContain(t);
  });
  test('the results page links its plain-text twin and the JSON', () => {
    const lb = sites.published.get('leaderboard/index.html')!;
    expect(lb).toContain('href="index.txt"');
    expect(lb).toContain('href="../data/results.json"');
    const txt = sites.published.get('leaderboard/index.txt')!;
    expect(txt).not.toMatch(/<[a-z]/i);
    expect(txt).toContain('PGAIBench');
    expect(txt).toContain('Baseline (no model): always escalate');
    expect(txt).toContain('not separated at this sample size');
    expect(JSON.parse(sites.published.get('data/results.json')!).scenario_set).toBe(fixture().scenario_set);
    for (const m of lb.matchAll(/data-k="(\d+)" data-n="(\d+)"/g)) expect(txt).toContain(`${m[1]} of ${m[2]}`);
  });
  test('the preview without results has a text twin with no result numbers', () => {
    expect(sites.plain.get('leaderboard/index.txt')!).toContain('No results yet');
    expect(sites.plain.has('data/results.json')).toBe(false);
  });
  test('scenario pages keep the full prompt in a wrapped pre', () => {
    const doc = sites.plain.get('scenarios/L1/index.html')!;
    expect(doc).toMatch(/<pre class="prompt" id="system-prompt">/);
    expect(css).toMatch(/pre\.prompt\s*\{[^}]*white-space:\s*pre-wrap/);
  });
  test('no script is needed: the only inline script is the theme line; the switcher is hidden without JavaScript', () => {
    for (const [p, doc] of html(sites.published)) {
      const inline = [...doc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      expect(inline, p).toEqual([THEME_HEAD]);
      expect(doc, p).toMatch(/<span class="theme" hidden>theme: <button type="button" data-theme-set="system" aria-pressed="true">system<\/button>/);
      expect([...doc.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]!.replace(/^(\.\.\/)*/, ''))).toEqual(['assets/sort.js', 'assets/theme.js']);
    }
  });
});
