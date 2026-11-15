// Roadmap page (three stages) and the AAA line on the home page.
import { expect, test } from 'bun:test';
import { site5 as site, text } from './five-runs.test';

test('roadmap page: three stages in order, the gate addendum as the first data point of the third, no dates', () => {
  const r = site.get('roadmap/index.html')!;
  const t = text(/<ol class="roadmap">[\s\S]*?<\/ul>/.exec(r)![0]);
  const a = t.indexOf('The model alone'), b = t.indexOf('The model with tools on a clone'), c = t.indexOf('The same models inside the AAA harness');
  expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b);
  expect(t).toContain('Done: v0.1.');
  expect(r).toMatch(/href="(\.\.\/)*addendum\/v0\.1\.3-gate-rerun\/(index\.html)?"/);
  expect(site.has('addendum/v0.1.3-gate-rerun/index.html')).toBe(true);
  for (const w of ['PGAIBench-Auditor', 'Agent track', 'Twin scenarios', 'Outside submissions']) expect(t).toContain(w);
  expect(t).not.toMatch(/\b20\d\d\b|soon|will show|;/);
});

test('home: one line names AAA and links the method section; a link to the roadmap', () => {
  const h = site.get('index.html')!;
  expect(h).toMatch(/AAA roles: Analyst \(tested now\), Auditor, Actor/);
  expect(h).toMatch(/href="[^"]*method\/(index\.html)?#about"/);
  expect(h).toMatch(/href="[^"]*roadmap\/(index\.html)?"/);
});
