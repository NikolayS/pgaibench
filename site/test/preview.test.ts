import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { allRows, assertRealResults, parseResults } from '../src/results';

const fixturePath = join(import.meta.dir, 'fixtures', 'results', 'results.json');
const fixture = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const plain = buildSite({ published: false, base: '/' });
const withFixture = buildSite({ published: false, base: '/', resultsJson: fixture() });
const html = (m: Map<string, string>) => [...m].filter(([p]) => p.endsWith('.html'));

describe('preview state', () => {
  test('every page shows the preview banner', () => {
    for (const m of [plain, withFixture]) for (const [p, doc] of html(m)) expect(doc, p).toMatch(/<div class="banner"[^>]*>[\s\S]*Preview, not published\./);
  });
  test('a preview build can show fixture data and says so', () => {
    const lb = withFixture.get('leaderboard/index.html')!;
    expect(lb).toContain('model-a');
    expect(lb).toContain('Numbers on this page are fixture data, not results.');
    expect(plain.get('leaderboard/index.html')!).not.toContain('model-a');
  });
  test('a preview build refuses data that is not a fixture', () => {
    const f = fixture();
    const id = f.tracks[0].text.rows[0].model_id;
    f.tracks[0].text.rows[0].model_id = 'some-vendor/some-model';
    f.tracks[0].text.groups['some-vendor/some-model'] = f.tracks[0].text.groups[id];
    expect(() => buildSite({ published: false, base: '/', resultsJson: f })).toThrow(/fixture/);
  });
  test('a published build refuses fixture data', () => {
    expect(() => assertRealResults('/tmp/results.json', parseResults(fixture()))).toThrow(/fixture/);
  });
  test('fixture models have clearly fake names', () => {
    for (const r of allRows(parseResults(fixture()))) expect(r.model_id).toMatch(/^fixture\/model-[a-z]$/);
    for (const e of fixture().excluded) expect(e.model_id).toMatch(/^fixture\/model-[a-z]$/);
  });
  test('no real model names, person names or internal process words', () => {
    const bad = /\b(?:gpt-?\d|claude|gemini|llama|mistral|qwen|deepseek|grok|kimi|glm-|opus|sonnet|haiku)\b|\bround \d|\bdecision \d|\bwave\b|budget|subscription|codex|\bTODO\b|lead[ ]session|hand[o]ff/i;
    for (const m of [plain, withFixture]) for (const [p, doc] of m) expect(doc.replace(/<[^>]*>/g, ' '), p).not.toMatch(bad);
    expect(readFileSync(fixturePath, 'utf8')).not.toMatch(bad);
  });
});
