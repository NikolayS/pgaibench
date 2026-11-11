// Width checks on the built pages: no chart line above 78 characters, and no
// table wider than 108 characters (sum over columns of the longest cell text,
// or the longest word of a cell that wraps, plus 2 characters of padding), so a 1280 px desktop window needs no
// sideways scrolling. Also: no markdown syntax leaks into page text, every
// numeric result header has a direction mark, every chart caption a direction.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildSite } from '../src/build';
import { cellText, preLines, tableWidth, unesc } from '../src/measure';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const published = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const preview = buildSite({ published: false, base: '/' });
const pending = buildSite({ published: false, pending: true, base: '/' });
const sites = { published, preview, pending };

test('no chart line is longer than 78 characters', () => {
  let max = 0;
  for (const s of Object.values(sites)) for (const [p, doc] of s) if (p.endsWith('.html')) for (const l of preLines(doc)) { max = Math.max(max, [...l].length); expect([...l].length, `${p}: ${l}`).toBeLessThanOrEqual(78); }
  expect(max).toBeGreaterThan(40);
});

// Pages with result tables (the scope of the desktop rule); prose pages such as related work keep wrapping tables.
const RESULT_PAGES = /^(index\.html|leaderboard\/|grid\/|cells\/|scenarios\/)/;
test('no table on a results page is wider than 108 characters', () => {
  for (const s of Object.values(sites)) for (const [p, doc] of s) if (p.endsWith('.html') && RESULT_PAGES.test(p)) for (const t of doc.matchAll(/<table[\s\S]*?<\/table>/g)) expect(tableWidth(t[0]), `${p}: ${t[0].slice(0, 120)}`).toBeLessThanOrEqual(108);
});

test('the first column never breaks inside a word; no hidden scrollbars; the scroll hint shows on narrow screens only', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'assets', 'style.css'), 'utf8');
  expect(css).toMatch(/th\[scope="row"\][^{]*\{[^}]*white-space: nowrap/);
  expect(css).toMatch(/table, th, td \{ overflow-wrap: normal; word-break: normal; \}/);
  expect(css).not.toMatch(/scrollbar-width:\s*none|::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  expect(css).toMatch(/\.scroll-hint \{ display: none;/);
  expect(css).toMatch(/@media \(max-width: [\d.]+rem\) \{ \.scroll-hint \{ display: block; \} \}/);
});

test('no markdown syntax in page text: no line starting with "# ", no "](", no "**"', () => {
  for (const s of Object.values(sites)) for (const [p, doc] of s) if (p.endsWith('.html')) {
    const body = doc.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    const lines = unesc(body.replace(/<[^>]*>/g, '\n')).split('\n').map(l => l.trim());
    for (const l of lines) { expect(l, p).not.toMatch(/^#{1,6} /); expect(l, p).not.toContain(']('); expect(l, p).not.toMatch(/\*\*\S/); }
  }
});

test('every numeric results header has a direction mark; every chart caption has a direction phrase', () => {
  const lb = published.get('leaderboard/index.html')!;
  for (const h of lb.matchAll(/<th scope="col" class="num[^"]*"[^>]*>([\s\S]*?)<\/th>/g)) {
    if (/Tasks both scored|Only [AB] right|Exact p|Holm p|Cells/.test(h[1]!)) continue; // paired-test and confusion tables: statistics, not outcome columns
    expect(cellText(h[1]!), h[0]).toMatch(/[+.-]$/);
  }
  const caps = [...lb.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map(m => cellText(m[1]!));
  expect(caps.length).toBeGreaterThan(2);
  for (const c of caps) expect(c).toMatch(/\((higher is better|lower is better|context, not a quality measure)\)/);
});
