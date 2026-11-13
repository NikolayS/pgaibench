import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite, publicScenarios } from '../src/build';
import { BANNER_PENDING } from '../src/html';

const ROOT = join(import.meta.dir, '..', '..');
const site = buildSite({ published: false, pending: true, base: '/', cname: 'pgaibench.dev' });
const text = (doc: string) => doc.replace(/<[^>]*>/g, ' ');

test('pending: every page has the pending banner and no fixture wording', () => {
  expect(BANNER_PENDING).toBe('Preview: v0.1 results are not published yet');
  for (const [p, doc] of site) if (p.endsWith('.html')) {
    expect(doc, p).toContain(BANNER_PENDING);
    expect(doc, p).not.toMatch(/fixture/i);
  }
  for (const [p, doc] of site) expect(doc, p).not.toMatch(/fixture\/model|model-[a-d]\b/);
});

test('pending: the results page says results are pending, with no chart and a prereg link', () => {
  const lb = site.get('leaderboard/index.html')!;
  expect(text(lb)).toContain('Results are pending: the first lab run of v0.1 is in progress.');
  expect(lb).not.toContain('<pre');
  expect(lb).toContain('docs/prereg-v0.1.md');
  expect(site.get('leaderboard/index.txt')).toContain('Results are pending');
});

test('pending: the testing policy lists every model under its track', () => {
  const models = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8')) as { id: string; access: string }[];
  const tracks = JSON.parse(readFileSync(join(ROOT, 'src', 'analysis', 'tracks.json'), 'utf8')).tracks as { name: string; access: string[] }[];
  const doc = site.get('testing-policy/index.html')!;
  for (const t of tracks) expect(doc).toContain(t.name);
  for (const m of models.filter(x => !/:|-(low|medium|high|xhigh)@/.test(x.id))) expect(doc, m.id).toContain(m.id); // effort-level rows are configurations of a listed model
});

test('pending: method links the preregistration; each public scenario has a page with its task', () => {
  expect(site.get('method/index.html')).toContain('docs/prereg-v0.1.md');
  for (const s of publicScenarios()) expect(site.get(`scenarios/${s.id}/index.html`), s.id).toContain(String(s.task).slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));
  for (const f of ['index.html', '404.html', '.nojekyll', 'CNAME']) expect(site.has(f), f).toBe(true);
});

test('pending: results data is refused', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'results', 'results.json'), 'utf8'));
  expect(() => buildSite({ published: false, pending: true, base: '/', resultsJson: fixture })).toThrow('pending');
  expect(() => buildSite({ published: true, pending: true, base: '/', resultsJson: fixture })).toThrow('pending');
});

test('pending: the home header shows the frozen public set, the model list and the tracks, not preview zeros', () => {
  const home = text(site.get('index.html')!);
  expect(home).toContain('19 in the set');
  expect(home).toMatch(/models +19 listed, results pending/);
  expect(home).toMatch(/tracks +3 by access path /);
  expect(home).not.toMatch(/set not frozen|0 shown in the preview|none yet/);
  expect(text(site.get('leaderboard/index.html')!).match(/Results are pending/g)?.length).toBe(1);
});
