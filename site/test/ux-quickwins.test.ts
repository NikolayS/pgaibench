// UX quick wins (review of 2026-11-13): phone table without sideways scrolling, one-line navigation, the question as
// h1, no duplicates on home, plain row labels, a quieter desktop table, polish.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { pooledJson, modelsJson } from './pooled.test';
import { takeaway, WORDS } from '../src/front';
import { shortName, frozenName } from '../src/svg';
import { compactTable, headlineTable, quadrantFigure, type SafetyRow } from '../src/safety';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const results = JSON.parse(readFileSync(fx('results/results.json'), 'utf8'));
results.provisional = true;
const cellsJson = JSON.parse(readFileSync(fx('results/cells.json'), 'utf8'));
const five = structuredClone(pooledJson) as typeof pooledJson;
five.samplesPerArm[0]!.samples = 5;
for (const r of five.rows) { r.samples = 5; r.missing = [...r.missing, 0, 0]; r.perSample = [...r.perSample, r.perSample[0]!, r.perSample[0]!]; }
for (const v of Object.values(five.perRun)) v.classes = [...v.classes, v.classes[0]!, v.classes[0]!];
const provisional = { data_at: '2026-11-12T20:00:00Z', harness_commit: 'abc1234', lab_planned: 12, lab_finished: 12, lab_counted: 12, rerun_pending: 0, not_run: 0, under_review: [], cells: [], not_requested: [], heldout_lab: [],
  safety: ['fixture/model-a', 'fixture/model-b'].map((m, i) => ({ model_id: m, dangerous: i, rehearsal: i, production_no_harm: 0, harm_measured: 0, done: 6 - i, tasks: 6, classes: {}, cells: [], heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 } })) };
const site = buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: results, cellsJson, provisionalJson: provisional, pooledJson: five, modelsJson, release: { ahead: 3 }, frozenPath: fx('frozen.example.json'), recordPooledJson: pooledJson } as never);
const text = (doc: string) => doc.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1');
const home = site.get('index.html')!;
const header = /<header class="top">([\s\S]*?)<\/header>/.exec(home)![1]!;
const footer = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(home)![1]!;
const css = readFileSync(join(import.meta.dir, '..', 'assets', 'style.css'), 'utf8');

const row = (id: string, dangerous: number, done: number, o: Partial<SafetyRow> = {}): SafetyRow => ({ model_id: id, dangerous, rehearsal: 0, production_no_harm: 0, harm_measured: 0, done, tasks: 19, classes: {}, cells: [],
  heldout: { dangerous: 0, rehearsal: 0, production_no_harm: 0, harm_measured: 0 }, score: 95, place: 1,
  avg: { runs: 5, whole: true, lo: 86, hi: 100, placeLo: 1, placeHi: 3, twoLevel: { lo: 86, hi: 100, placeLo: 1, placeHi: 3 }, dangerBound: { count: 0, answers: 95, upper: 0.03 }, held: { dangerous: 0, tasks: 3 }, classes: [] }, ...o } as never);

test('labels: Antigravity CLI row reads "CLI", router row "API"; frozen pages keep the tagged names', () => {
  expect(shortName('google/gemini-4-carbon@agy')).toContain('gemini-4-carbon CLI');
  expect(shortName('google/gemini-4-carbon@agy')).not.toContain('(agy)');
  expect(shortName('google/gemini-4-carbon@or')).toContain('gemini-4-carbon API');
  expect(frozenName('google/gemini-4-carbon@agy')).toContain('(agy)');
  expect(frozenName('google/gemini-4-carbon@or')).not.toContain('API');
});

test('phone table: three columns, score and place on a dim second line, "0/95", short label for the row without a place', () => {
  const prov = [{ id: 'google/gemini-4-carbon@or', samples: 5, score: 80, lo: 65, hi: 94, dangerous: 0.2, done: 15.2, split: { rehearsal: 0, production_no_harm: 0, harm_measured: 0.2 } }];
  const t = compactTable([row('anthropic/claude-fable-5.2', 0, 18)], { id: 'x', provisional: prov });
  expect([...t.matchAll(/<th scope="col"/g)].length).toBe(3);
  expect(t).toContain('0/95');
  expect(t).not.toContain('of 95 answers');
  expect(text(t)).toMatch(/score 95, place 1 to 3/);
  expect(text(t)).toContain('gemini-4-carbon API');
  expect(t).toMatch(/<span class="dim">no place, score 80<\/span>/);
  expect(t).not.toContain('second access path');
  expect(css).toMatch(/table\.compact tbody th\[scope="row"\] \{ white-space: normal/);
});

test('desktop table: place column first, "of 19" in the header, dim count, effort column, dim zeros', () => {
  const t = headlineTable([row('anthropic/claude-fable-5.2', 0, 18)], { id: 'x' });
  const heads = [...t.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map(m => text(m[1]!).trim());
  expect(heads[0]).toBe('place');
  expect(heads[1]).toBe('model');
  expect(heads[2]).toBe('effort');
  expect(heads.some(h => /\(of 19\)$/.test(h))).toBe(true);
  expect(t).not.toMatch(/18 of 19/);
  expect(t).toMatch(/>0 <span class="dim">0\/95<\/span>/);
  expect(t).toMatch(/<td[^>]*class="num none"[^>]*>0<\/td>/);
  expect(t).not.toMatch(/<th scope="col"[^>]* title=/);
  expect(css).toMatch(/table\.safety \{[^}]*max-width: 110ch/);
  expect(css).toMatch(/table\.safety tbody th\[scope="row"\] \{[^}]*font-weight: 600/);
});

test('key: "18 done, 0 dangerous", no pair note; one legend line for no place', () => {
  const f = quadrantFigure({ id: 'q', points: [{ label: 'm · high', x: 18, y: 0, family: 'anthropic' }], xMax: 19, width: 760, caption: 'c' });
  expect(f).toContain('18 done, 0 dangerous');
  expect(f).not.toContain('(tasks done, tasks without a dangerous change)');
  expect(f).not.toContain('(18, 19)');
});

test('takeaway: plain numbers first', () => {
  expect(takeaway([row('anthropic/claude-fable-5.2', 0, 18), row('anthropic/claude-opus-5.5', 0, 17)]))
    .toBe('claude-fable-5.2 and claude-opus-5.5 did 18 and 17 of 19 tasks per run. No dangerous change in any run.');
});

test('navigation: one line in the header, the rest in the footer, banner text in the footer', () => {
  const labels = [...header.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map(m => m[1]!);
  expect(labels).toEqual(['PGAIBench', 'results', 'answers', 'method', 'tasks', 'data', 'github', expect.stringMatching(/^v\d/)]);
  expect(labels.join(' ')).not.toMatch(/theme|compare|limits|releases/);
  expect(header).not.toContain('data-theme-set');
  expect(header).not.toMatch(/\(20\d\d-/);
  expect(home).not.toMatch(/<p class="banner"/);
  expect(home).not.toContain('role="status"');
  for (const w of ['compare models', 'limits', 'releases', 'Young project.', 'data-theme-set="dark"']) expect(footer).toContain(w);
});

test('home top: the question is the only h1, grey facts line under it', () => {
  expect([...home.matchAll(/<h1/g)].length).toBe(1);
  expect(text(/<h1[^>]*>[\s\S]*?<\/h1>/.exec(home)![0]).trim()).toBe('How safely do LLMs change a production Postgres database?');
  expect(home).toContain('<p class="meta facts">19 tasks. 5 runs per model. No tools. Each answer runs in a lab under load.</p>');
  expect(home).not.toContain('<pre class="title"');
  expect(css).toMatch(/h1\.plain \{[^}]*font-size: 1\.5rem/);
});

test('home: no duplicates, moved blocks live on method and results', () => {
  const t = text(home);
  expect(home.match(/class="example"/g)?.length ?? 0).toBeLessThanOrEqual(1);
  expect(home).not.toContain('id="status"');
  expect(home).not.toContain('id="read"');
  expect(home).not.toContain('id="outcomes"');
  expect(home).not.toContain('id="flow"');
  expect(home).not.toContain('pgaibench report');
  expect(home).not.toContain('id="what"');
  expect(home).not.toContain('rating-home');
  expect(t.match(/Words on this page/g)?.length ?? 0).toBeLessThanOrEqual(1);
  expect(t.match(/Up: fewer dangerous changes/g)?.length ?? 0).toBe(1);
  const m = site.get('method/index.html')!;
  for (const id of ['id="what"', 'id="outcomes"', 'id="flow"', 'pgaibench report']) expect(m).toContain(id);
  expect(site.get('leaderboard/index.html')!).toContain('id="rating"');
  expect(home).toMatch(/<h2 id="results">Results<\/h2>/);
});

test('polish: figure margin, regular captions, named more links, tap targets, ink ledes, column words', () => {
  expect(css).toMatch(/figure\.svg-chart \{ margin: var\(--lh\) 0; \}/);
  expect(css).not.toMatch(/figure\.svg-chart figcaption \{ font-style: italic/);
  expect(home).not.toMatch(/>more<\/a>/);
  expect(css).toMatch(/min-height: 44px/);
  expect(css).not.toMatch(/\.dim, \.meta, \.lede,/);
  expect(WORDS.map(w => w[0])).toContain('dangerous per run');
});
