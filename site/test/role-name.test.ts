// The role under test is the Analyst (renamed from "Analyzer" after v0.1.3). Frozen release pages and the changelog of
// released versions keep the old word; every other page uses the new one.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { AAA_DIAGRAM } from '../src/about';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const site = buildSite({ published: false, base: '/', cname: 'pgaibench.dev', resultsJson: JSON.parse(readFileSync(fx('results/results.json'), 'utf8')), cellsJson: JSON.parse(readFileSync(fx('results/cells.json'), 'utf8')), release: { ahead: 0 }, frozenPath: fx('frozen.example.json') } as never);

test('live pages name the role Analyst, never Analyzer', () => {
  for (const [p, h] of site) {
    if (p.startsWith('releases/v') || p.startsWith('changelog/') || !p.endsWith('.html')) continue;
    expect(h, p).not.toContain('Analyzer');
  }
  expect(site.get('auditor/index.html')).toContain('PGAIBench-Analyst');
});

test('the role diagram keeps its columns', () => {
  const [, , a, b] = AAA_DIAGRAM.split('\n');
  expect(a!.indexOf('Auditor')).toBe(b!.indexOf('pre-op'));
  expect(a).toMatch(/^Analyst +-> +Auditor/);
});
