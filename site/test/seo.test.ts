// Search and answer-engine files: robots.txt, sitemap.xml, llms.txt, llms-full.txt, .md twins, page heads.
import { describe, expect, test } from 'bun:test';
import { buildSite } from '../src/build';
import { AI_AGENTS, ORIGIN, describePage, headlineFacts, llmsTxt, robotsTxt, SITEMAP_EXCLUDE } from '../src/seo';
import { parsePooled } from '../src/pooled';
import { pooledJson, site } from './fixtures/seo-site';

const pooled = parsePooled(pooledJson);
const html = [...site.keys()].filter(p => p.endsWith('.html'));
const llms = site.get('llms.txt')!;
const full = site.get('llms-full.txt')!;
const pageUrl = (p: string) => `${ORIGIN}/${p.replace(/index\.html$/, '')}`;

describe('robots.txt', () => {
  const r = site.get('robots.txt')!;
  test('allows all and names the sitemap', () => {
    expect(r).toContain('User-agent: *\nAllow: /');
    expect(r).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(r).not.toMatch(/Disallow: \/\S/);
  });
  test('welcomes the AI crawlers and agents by name', () => {
    for (const a of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot'])
      expect(r).toContain(`User-agent: ${a}\n`);
    expect(robotsTxt()).toBe(r);
    expect(new Set(AI_AGENTS).size).toBe(AI_AGENTS.length);
  });
});

describe('sitemap.xml', () => {
  const sm = site.get('sitemap.xml')!;
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]!);
  test('every HTML page is in the sitemap or on the exclude list', () => {
    for (const p of html) if (!SITEMAP_EXCLUDE.includes(p)) expect(locs, p).toContain(pageUrl(p));
    expect(locs).not.toContain(`${ORIGIN}/404.html`);
  });
  test('absolute https URLs, lastmod from the build data time', () => {
    expect(locs.every(l => l.startsWith('https://pgaibench.dev/'))).toBe(true);
    expect(sm).toContain('<lastmod>2026-11-11</lastmod>');
    expect(sm.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('page heads', () => {
  const heads = html.filter(p => p !== '404.html').map(p => [p, /<head>([\s\S]*?)<\/head>/.exec(site.get(p)!)![1]!] as const);
  test('unique title and description of at most 155 characters on every page', () => {
    const titles = new Set<string>(), descs = new Set<string>();
    for (const [p, h] of heads) {
      const t = /<title>([^<]*)<\/title>/.exec(h)![1]!, d = /<meta name="description" content="([^"]*)">/.exec(h)?.[1];
      expect(d, p).toBeDefined();
      expect(d!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').length, p).toBeLessThanOrEqual(155);
      expect(titles.has(t), `title ${t}`).toBe(false); titles.add(t);
      expect(descs.has(d!), `description ${d}`).toBe(false); descs.add(d!);
      expect((h.match(/<meta name="description"/g) ?? []).length, p).toBe(1);
    }
  });
  test('canonical, Open Graph and Twitter tags', () => {
    for (const [p, h] of heads) {
      expect(h, p).toContain(`<link rel="canonical" href="${pageUrl(p)}">`);
      expect(h, p).toContain(`<meta property="og:url" content="${pageUrl(p)}">`);
      for (const k of ['og:title', 'og:description', 'og:type', 'og:site_name', 'og:image']) expect(h, `${p} ${k}`).toContain(`<meta property="${k}" content="`);
      expect(h, p).toContain(`<meta property="og:image" content="${ORIGIN}/assets/og.png">`);
      expect(h, p).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(h, p).toContain(`<link rel="describedby" type="text/plain" href="${ORIGIN}/llms.txt">`);
    }
  });
  test('JSON-LD WebSite and Dataset on home and data pages, valid JSON', () => {
    for (const p of ['index.html', 'data/index.html']) {
      const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(site.get(p)!)![1]!;
      const j = JSON.parse(ld);
      const types = j['@graph'].map((x: { '@type': string }) => x['@type']);
      expect(types).toEqual(['WebSite', 'Dataset']);
      const ds = j['@graph'][1];
      expect(ds.license).toBe('https://www.apache.org/licenses/LICENSE-2.0');
      expect(ds.creator).toEqual({ '@type': 'Organization', name: 'PGAIBench' });
      expect(ds.dateModified).toBe('2026-11-11T20:00:00Z');
      expect(ds.distribution.map((d: { contentUrl: string }) => d.contentUrl)).toContain(`${ORIGIN}/data/pooled.json`);
      expect(ds.version).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(site.get('method/index.html')).not.toContain('application/ld+json');
  });
  test('the frozen release page is indexable and canonical to itself', () => {
    const r = site.get('releases/v0.1.0/index.html');
    if (r) { expect(r).toContain(`<link rel="canonical" href="${ORIGIN}/releases/v0.1.0/">`); expect(r).not.toContain('noindex'); }
  });
  test('task pages name the trap', () => {
    expect(site.get('scenarios/L1/index.html')).toContain('content="Postgres task L1. Trap: Lock-queue pile-up behind a long transaction.');
  });
  test('describePage stays within 155 characters for long titles', () => {
    expect(describePage('cells/x/B5/index.html', 'x'.repeat(300), pooled).length).toBeLessThanOrEqual(155);
  });
});

describe('llms.txt', () => {
  test('llmstxt.org shape: H1, one blockquote, H2 link lists', () => {
    expect(llms.startsWith('# PGAIBench\n\n> ')).toBe(true);
    expect((llms.match(/^> /gm) ?? []).length).toBe(1);
    for (const h of ['## Data', '## Method and limits', '## Cite, licence, contribute']) expect(llms).toContain(`\n${h}\n`);
    for (const l of llms.split('\n').filter(x => x.startsWith('- ['))) expect(l, l).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/);
  });
  test('links the machine-readable data and the markdown twins', () => {
    for (const u of ['data/pooled.json', 'data/results.json', 'data/models.json', 'data/provisional.json', 'llms-full.txt', 'index.md', 'method.md', 'limits.md'])
      expect(llms).toContain(`(${ORIGIN}/${u})`);
    for (const u of ['index.md', 'method.md', 'limits.md', 'llms-full.txt']) expect(site.has(u), u).toBe(true);
  });
  test('every number comes from pooled.json', () => {
    const f = headlineFacts(pooled);
    expect(f.tasks).toBe(pooled.publicIds.length);
    expect(f.runs).toBe(3);
    expect(f.ranked).toBe(pooled.rows.filter(r => r.place !== null).length);
    expect(llms).toContain(`${f.tasks} public tasks`);
    expect(llms).toContain(`${f.runs} runs`);
    expect(llms).toContain(`${f.models.length} models, ${f.ranked} rows with a place`);
    expect(llms).not.toContain('ranked configurations');
    // The takeaway (same rule as the site): the two included rows with the most tasks done, both without a dangerous
    // change. In the fixture model-b wrote dangerous changes, so there is no takeaway line.
    expect(f.takeaway).toBe('');
    const clean = structuredClone(pooledJson); for (const r of clean.rows) r.dangerous = 0;
    const g = headlineFacts(parsePooled(clean));
    expect(g.takeaway).toBe('On these 6 public tasks, 3 runs, no tools, model-a and model-b did the most tasks (5.7 and 4.7 of 6 per run) and wrote no dangerous change in any run.');
    expect(llmsTxt({ pooled: parsePooled(clean), scenarios: [], dataAt: null, setVersion: 'x' })).toContain(g.takeaway);
  });
  test('scoped results, plain words, no banned forms', () => {
    for (const t of [llms, full, site.get('index.md')!]) {
      expect(t).not.toContain('PostgreSQL');
      expect(t).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      expect(t).not.toMatch(/\bZ9\b/);
    }
    expect(llms).not.toContain(';');
    expect(llms).toMatch(/On these \d+ public tasks, \d+ runs, no tools/);
  });
});

describe('llms-full.txt', () => {
  test('results table rows follow the safety order with numbers from pooled.json', () => {
    const lines = full.split('\n').filter(l => /^\| fixture\//.test(l));
    expect(lines.map(l => l.split('|')[1]!.trim())).toEqual([...pooled.safetyOrder, 'fixture/model-c']);
    expect(lines[0]).toContain('| 96 |');
  });
  test('has the task list, method and limits', () => {
    for (const id of pooled.publicIds) expect(full).toContain(`| ${id} |`);
    for (const h of ['## Method', '## Limits', '## Tasks', '## Results']) expect(full).toContain(`\n${h}\n`);
  });
});

test('no SEO files without a custom domain', () => {
  const s = buildSite({ published: false, base: '/pgaibench/' });
  expect(s.has('robots.txt')).toBe(false);
});

test('og.png: a 1200x630 PNG among the binary assets', async () => {
  const { BINARY_ASSETS } = await import('../src/html');
  expect(BINARY_ASSETS).toContain('og.png');
  const b = new Uint8Array(await Bun.file(new URL('../assets/og.png', import.meta.url)).arrayBuffer());
  const v = new DataView(b.buffer);
  expect([...b.slice(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG');
  expect([v.getUint32(16), v.getUint32(20)]).toEqual([1200, 630]);
});

test('llms-full.txt task table: trap names and kinds, no scoring patterns', () => {
  expect(full).toContain('| B5 | backup-dr-rollback | Lowering wal_level below what the standby and archive need | refuse and escalate |');
  expect(full).not.toMatch(/\\s[*+]/);
  expect(full).toContain('| configuration | effort |');
});

test('llms.txt carries the results table: every row with a place, numbers from pooled.json', () => {
  const placed = [...pooled.rows, ...pooled.effort.flatMap(a => a.rows)].filter(r => r.place !== null);
  const lines = llms.split('\n').filter(l => /^\| fixture\//.test(l));
  expect(lines.length).toBe(placed.length);
  for (const r of placed) {
    const l = lines.find(x => x.startsWith(`| ${r.id} |`))!;
    expect(l, r.id).toBeDefined();
    const c = l.split('|').map(x => x.trim());
    expect(Number(c[3])).toBeCloseTo(r.dangerous!, 1);
    expect(c[4]).toBe(`${Math.round(r.done! * 10) / 10} of ${pooled.publicIds.length}`);
    expect(Number(c[5])).toBe(Math.round(r.score!));
  }
  expect(llms.indexOf('| row | effort |')).toBeGreaterThan(llms.indexOf('Results (release'));
  expect(llms.indexOf('| row | effort |')).toBeLessThan(llms.indexOf('If you are an agent'));
});

test('llms.txt: the limit is its own line, not a trap bullet', () => {
  expect(llms).toContain('\nLimit: these results do not show that any model is safe');
  expect(llms).not.toContain('- These results do not show');
});

test('llms.txt: the takeaway note of the site follows the takeaway', async () => {
  const { TAKEAWAY_NOTE } = await import('../src/pages');
  const clean = structuredClone(pooledJson); for (const r of clean.rows) r.dangerous = 0;
  const t = llmsTxt({ pooled: parsePooled(clean), scenarios: [], dataAt: null, setVersion: 'x' });
  expect(t).toContain(`did the most tasks (5.7 and 4.7 of 6 per run) and wrote no dangerous change in any run. ${TAKEAWAY_NOTE}`);
});
