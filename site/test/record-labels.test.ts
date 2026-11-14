// Frozen tables of releases after v0.1.2 use the row labels of the live charts; older frozen pages keep theirs.
import { expect, test } from 'bun:test';
import { recordName, frozenName, shortName } from '../src/svg';

test('v0.1.0 to v0.1.2 keep the printed names', () => {
  for (const v of ['0.1.0', '0.1.1', '0.1.2']) for (const id of ['deepseek/deepseek-v4-pro-0813', 'google/gemini-4-carbon@agy']) expect(recordName(v, id)).toBe(frozenName(id));
});
test('later releases: "no thinking" for the deepseek row, "CLI" for the agy path', () => {
  expect(recordName('0.1.3', 'deepseek/deepseek-v4-pro-0813')).toBe(shortName('deepseek/deepseek-v4-pro-0813'));
  expect(recordName('0.1.3', 'deepseek/deepseek-v4-pro-0813')).toContain('no thinking');
  expect(recordName('0.1.3', 'google/gemini-4-carbon@agy')).toContain(' CLI · ');
  expect(recordName('0.1.3', 'google/gemini-4-carbon@agy')).not.toContain('(agy)');
});
