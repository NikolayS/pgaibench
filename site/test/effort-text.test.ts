// Effort statements built from the rows of the models table (check before v0.1.2, items 3, 4 and 7): no typed lists.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effortSentence, fairnessSentence, levelsSentence, parseModels } from '../src/models';

// the configurations of the five-run table (data/models.json of the build, without the rows that never ran five runs)
const all = parseModels(JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/models-table.json'), 'utf8')));
const rows = all.filter(r => !/grok|glm/.test(r.id));

test('effort sentence: first level = recorded vendor default, second level, router rows with and without a setting', () => {
  expect(effortSentence(rows)).toBe('We set the reasoning effort for every row that runs through a vendor command-line client. First level, the vendor default as we recorded it: high for claude-fable-5.2, claude-opus-5.5 and claude-sonnet-5.5. Medium for gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna, claude-haiku-5.5 and gemini-4-carbon CLI. Second level: the same nine models at the other of the two levels. kimi-k3.1-pro runs through the router at high. Its recorded default is max. For the other router rows we sent no effort setting: gemini-3.8-flash, gemini-4-argon, deepseek-v4-pro, qwen3.8-27b and gemini-4-carbon API. Effort names are not equal across vendors.');
});

test('fairness: every level by name, the no-thinking row, how many models have both levels', () => {
  expect(fairnessSentence(rows)).toBe('The effort levels differ between rows in this release. At high: claude-fable-5.2, claude-opus-5.5, claude-sonnet-5.5, kimi-k3.1-pro, claude-haiku-5.5, gemini-4-carbon CLI, gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra and gpt-6-luna. At medium: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna, claude-haiku-5.5, gemini-4-carbon CLI, claude-sonnet-5.5, claude-opus-5.5 and claude-fable-5.2. At the provider default (router rows, no effort sent): gemini-3.8-flash, gemini-4-argon, deepseek-v4-pro (its endpoint returned no thinking), qwen3.8-27b and gemini-4-carbon API. Nine models have a row at high and a row at medium. Five models have one level only. This is not an equal comparison.');
  expect(fairnessSentence(rows)).not.toMatch(/the [A-Z][a-z]+ (AI )?models|being added|are running/);
});

test('levels sentence (limits, not checked): from the levels present', () => {
  expect(levelsSentence(rows)).toBe('Reasoning-effort settings other than high and medium. Nine models have rows at both levels. Five models have one level only.');
});

test('README carries the same two sentences as the site, from the same table', () => {
  const root = join(import.meta.dir, '..', '..');
  const f = ['public-overlay/README.md', 'README.md'].map(x => join(root, x)).find(x => { try { readFileSync(x); return true; } catch { return false; } })!;
  const readme = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
  expect(readme).toContain(fairnessSentence(rows));
  expect(readme).toContain(effortSentence(rows));
  expect(readme).toContain('290 of 2185 public cells');
});
