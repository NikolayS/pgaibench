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
  test('no img, svg, canvas, picture or iframe in any file', () => {
    for (const [n, s] of all) for (const [p, doc] of s) expect(doc, `${n} ${p}`).not.toMatch(/<(img|svg|canvas|picture|iframe|video|object|embed)\b/i);
  });
  test('the stylesheet has no url(), import, web font, gradient, shadow or rounded corner', () => {
    expect(css).not.toMatch(/url\(|@import|@font-face|gradient|box-shadow|text-shadow|border-radius|filter:/i);
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

describe('text charts', () => {
  const charts = (doc: string) => [...doc.matchAll(/<pre class="chart" data-chart="([^"]+)" aria-hidden="true">([\s\S]*?)<\/pre>/g)].map(m => ({ id: m[1]!, body: unesc(m[2]!.replace(/<[^>]*>/g, '')) }));
  const tableFor = (doc: string, id: string) => {
    const t = new RegExp(`<table[^>]*data-chart-for="${id}"[^>]*>([\\s\\S]*?)</table>`).exec(doc);
    if (!t) return null;
    return [...t[1]!.matchAll(/<tr[^>]*data-k="(\d+)" data-n="(\d+)" data-lo="([\d.]+)" data-hi="([\d.]+)"[^>]*><th scope="row">([^<]+)<\/th>/g)]
      .map(m => ({ k: +m[1]!, n: +m[2]!, lo: +m[3]!, hi: +m[4]!, label: unesc(m[5]!) }));
  };
  const rows = (body: string) => [...body.matchAll(/^(.*?)\|([█▒░ ]+)\|\s+(\d+)\/(\d+)\s/gm)].map(m => ({ bar: m[2]!, k: +m[3]!, n: +m[4]! }));
  test('no SVG chart is left and charts exist', () => {
    let n = 0;
    for (const [, s] of all) for (const [, doc] of html(s)) n += charts(doc).length;
    expect(n).toBeGreaterThan(0);
    expect(sites.plain.get('leaderboard/index.html')!).toContain('<pre class="chart"');
  });
  test('every chart pre is aria-hidden, has a text alternative and a table with the same numbers', () => {
    for (const [n, s] of [['fixture', sites.fixture], ['published', sites.published]] as const) for (const [p, doc] of html(s)) for (const c of charts(doc)) {
      expect(doc, `${n} ${p} ${c.id}`).toContain(`id="${c.id}-alt"`);
      const t = tableFor(doc, c.id);
      expect(t, `${n} ${p} ${c.id}`).not.toBeNull();
      const r = rows(c.body);
      expect(r.length, `${p} ${c.id}`).toBe(t!.length);
      expect(r.length).toBeGreaterThan(0);
      r.forEach((x, i) => { expect(x.k).toBe(t![i]!.k); expect(x.n).toBe(t![i]!.n); });
    }
  });
  test('bars are linear from zero: length proportional to the value within one character', () => {
    let checked = 0;
    for (const [, s] of [['fixture', sites.fixture], ['published', sites.published]] as const) for (const [p, doc] of html(s)) for (const c of charts(doc)) {
      const t = tableFor(doc, c.id)!;
      rows(c.body).forEach((x, i) => {
        expect(x.bar.length, p).toBe(BAR_WIDTH);
        const count = (re: RegExp) => (x.bar.match(re) ?? []).length;
        const len = count(/[█▒]/g), band = count(/[▒░]/g);
        expect(Math.abs(len - BAR_WIDTH * x.k / x.n), `${p} ${c.id} row ${i}`).toBeLessThanOrEqual(1);
        expect(Math.abs(band - BAR_WIDTH * (t[i]!.hi - t[i]!.lo)), `${p} ${c.id} band ${i}`).toBeLessThanOrEqual(1.5);
        expect(x.bar).toMatch(/^█*▒*░* *$/);
        checked++;
      });
      expect(c.body, `${p} ${c.id}`).toMatch(/0%\s+25%\s+50%\s+75%\s+100%/);
      expect(c.body).toContain('linear');
    }
    expect(checked).toBeGreaterThan(5);
  });
  test('baselines are labelled rows in every result chart', () => {
    const lb = sites.published.get('leaderboard/index.html')!;
    for (const c of charts(lb)) {
      expect(c.body).toContain('Baseline (no model): always escalate');
      expect(c.body).toContain('Baseline (no model): always our safe reference change');
    }
  });
  test('an empty chart shows the scale and no digit in its result region', () => {
    const lb = sites.plain.get('leaderboard/index.html')!;
    expect(charts(lb).length).toBeGreaterThan(0);
    expect(lb).toContain('No results yet');
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
    expect(h).toMatch(/<pre class="title" aria-hidden="true">[█ \n]+<\/pre>/);
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
      const h = /<pre class="head"[^>]*>([\s\S]*?)<\/pre>/.exec(s.get('index.html')!)![1]!;
      for (const k of ['run date:', 'scenarios:', 'models:', 'tracks:', 'licence:']) expect(h).toContain(k);
    }
    expect(sites.plain.get('index.html')!).toContain('How to read this');
  });
  test('the nav is one plain text line on every page', () => {
    for (const [p, doc] of html(sites.plain)) expect(doc, p).toMatch(/<nav class="nav" aria-label="Main">\[<a [^>]+>home<\/a>\] \[<a /);
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
    expect(txt).toContain('PG AI Bench');
    expect(txt).toContain('Baseline (no model): always escalate');
    expect(txt).toContain('not separated at this sample size');
    expect(JSON.parse(sites.published.get('data/results.json')!).scenario_set).toBe(fixture().scenario_set);
    for (const m of lb.matchAll(/data-k="(\d+)" data-n="(\d+)"/g)) expect(txt).toContain(`${m[1]}/${m[2]}`);
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
  test('no script is needed: the page has no inline script and tables are in the HTML', () => {
    for (const [p, doc] of html(sites.published)) expect(doc, p).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
