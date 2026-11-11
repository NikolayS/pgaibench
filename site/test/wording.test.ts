import { describe, expect, test } from 'bun:test';
import { buildSite } from '../src/build';

const site = buildSite({ published: false, base: '/' });
const text = (p: string) => site.get(p)!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('scoring wording', () => {
  test('no page claims that no model judges the score', () => {
    for (const [p, doc] of site) expect(doc, p).not.toMatch(/No model judges/i);
  });
  test('home and method say what decides the score', () => {
    for (const p of ['index.html', 'method/index.html']) {
      expect(text(p), p).toContain('Scoring is by fixed rules and lab measurements.');
      expect(text(p), p).toContain('A model takes no part in the score.');
      expect(text(p), p).toContain('Human readers label failure types only.');
    }
  });
  test('method does not describe model readers that decide a cell', () => {
    expect(text('method/index.html')).not.toMatch(/two readers from two vendors|stays out of the score/);
  });
});

describe('no ordering and no comparison claims in generated pages', () => {
  const { join } = require('node:path') as typeof import('node:path');
  const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
  const sites = [site, buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') })];
  const BANNED = /\bsafer\b|\bbetter than\b|\bworse than\b|\bbest model|\bworst model|\bwinner\b|\bmore reliable than\b|\branks?\b|\branked\b|\branking\b|\btiers?\b|\bbest\b|\bbeats?\b|\bmedals?\b|over-?cautious|right-thing rate|leaderboard position/i;
  // The one ordered element is the rating chart with its fixed wording; nothing else orders models.
  test('no page says one model is safer or better, and no page ranks or tiers models', () => {
    for (const s of sites) for (const [p, doc] of s) if (p.endsWith('.html')) expect(doc.replace(/<pre class="prompt"[\s\S]*?<\/pre>/g, '').replace(/<[^>]*>/g, ' '), p).not.toMatch(BANNED); // the frozen model input is quoted as is
  });
  test('the generated markdown report passes the same scan', async () => {
    const { buildModelReport, renderModelReport } = await import('../../src/analysis/model-report');
    const md = renderModelReport(buildModelReport({ scenarioSet: 's', publicIds: ['A1'], heldOutIds: [], mustRefuse: () => false, expected: [], generated: new Map(), cells: [], models: [], tracks: [], dropped: [], baselines: [] }));
    expect(md).not.toMatch(BANNED);
  });
});
