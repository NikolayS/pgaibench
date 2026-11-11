import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { GLOSSARY } from '../src/pages';

const ROOT = join(import.meta.dir, '..', '..');
const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const sites = [buildSite({ published: false, base: '/' }), buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') })];

// Model input (task text, prompts) and model output (answers) are quoted byte for byte; they are not our copy.
const ourText = (doc: string) => doc
  .replace(/<pre class="(?:prompt|answer)"[\s\S]*?<\/pre>/g, '')
  .replace(/<blockquote class="task">[\s\S]*?<\/blockquote>/g, '')
  // Provenance quotes the titles of the sources a scenario cites (for example a release-notes title).
  .replace(/<p class="meta">Provenance:[\s\S]*?<\/p>/g, '')
  .replace(/<[^>]*>/g, ' ');

/** "PostgreSQL" stays only in literal strings: URLs and file names (none in our copy today). */
const POSTGRESQL_ALLOWED = [/https?:\/\/\S*PostgreSQL/gi];
const stripAllowed = (s: string) => POSTGRESQL_ALLOWED.reduce((t, re) => t.replace(re, ''), s);

const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
// In the private repository the public docs are in public-overlay/; in the public repository at the root.
const OVERLAY = existsSync(join(ROOT, 'public-overlay')) ? walk(join(ROOT, 'public-overlay')) : ['README.md', 'NOTICE', 'CITATION.cff', 'CHANGELOG.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'docs/research.md'].map(f => join(ROOT, f)).filter(f => existsSync(f));
const PUBLIC_DOCS = [...OVERLAY.filter(f => /\.(md|cff)$|NOTICE$/.test(f)),
  ...['benchmark.md', 'prereg-v0.1.md', 'scenario-review-v0.1.md', 'prior-art-dba-bench.md'].map(f => join(ROOT, 'docs', f))];
// research.md quotes the spellings it compared when the name was chosen.
const NAME_STUDY = /confusion risk for "PG AI Bench"/;

describe('names in reader text', () => {
  test('no "PostgreSQL" in our copy on any page', () => {
    for (const s of sites) for (const [p, doc] of s) if (p.endsWith('.html') || p.endsWith('.txt')) expect(stripAllowed(ourText(doc)), p).not.toContain('PostgreSQL');
  });
  test('no "PG AI Bench" on any page', () => {
    for (const s of sites) for (const [p, doc] of s) if (p.endsWith('.html') || p.endsWith('.txt')) expect(ourText(doc), p).not.toMatch(/PG AI Bench/);
  });
  test('public docs write Postgres and PGAIBench', () => {
    for (const f of PUBLIC_DOCS) {
      const t = readFileSync(f, 'utf8');
      expect(stripAllowed(t), f).not.toContain('PostgreSQL');
      expect(t.replace(NAME_STUDY, ''), f).not.toMatch(/PG AI Bench/);
    }
  });
  test('AAA is introduced once, with its three roles', () => {
    const home = sites[0]!.get('index.html')!;
    expect(home).toContain('AAA: Analyzer, Auditor, Actor');
    expect(home).toContain('PGAIBench-Analyzer');
    expect(home).toContain('PGAIBench-Auditor');
    for (const s of sites) expect([...s.values()].join('').split('AAA: Analyzer, Auditor, Actor').length - 1).toBe(1);
  });
});

describe('glossary', () => {
  const method = sites[0]!.get('method/index.html')!;
  const dts = [...method.matchAll(/<dl class="glossary">([\s\S]*?)<\/dl>/g)].flatMap(m => [...m[1]!.matchAll(/<dt>([^<]+)<\/dt>/g)].map(x => x[1]!));
  test('the method page has one glossary with every term', () => {
    expect(method.match(/<dl class="glossary">/g)?.length).toBe(1);
    expect(dts).toEqual(GLOSSARY.map(([t]) => t));
  });
  test('each term is defined once', () => {
    expect(new Set(dts).size).toBe(dts.length);
    for (const s of sites) for (const [p, doc] of s) if (p !== 'method/index.html') expect(doc, p).not.toContain('<dl class="glossary">');
  });
  // Scenario pages quote the trap text of scenarios/ (frozen definitions), which still says "CR".
  test('no abbreviation CR in our copy', () => {
    for (const s of sites) for (const [p, doc] of s) if (p.endsWith('.html') && !p.startsWith('scenarios/') && !p.startsWith('cells/')) expect(ourText(doc), p).not.toMatch(/\bCRs?\b/);
  });
});
