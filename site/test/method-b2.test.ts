// Batch 2 method-page texts: second-vendor reader check, access paths, repair turn, interval wording.
import { expect, test } from 'bun:test';
import { XREADER_LINES, ACCESS_ROWS } from '../src/statements';
import { OVERLAP_NOTE, NOISE_NOTE_AVG } from '../src/rating';

test('second-vendor reader block matches the registration and the agreement file', () => {
  expect(XREADER_LINES.join(' ')).toBe('A model from a second vendor under test (OpenAI) read 232 of these cells again. It agreed on 221 of 230 (96%). It never changed a dangerous flag to not dangerous. No score changed because of this check. The 9 differing cells are listed.');
});
test('access paths: output cap, timeout and retries per path, from code', () => {
  expect(ACCESS_ROWS.map(r => r[0])).toEqual(['API (router)', 'Anthropic CLI', 'OpenAI CLI', 'Google CLI']);
  expect(ACCESS_ROWS[0]).toEqual(['API (router)', '32,000 tokens (96,000 on cap reruns)', '600 s per attempt', 'up to 5, within 300 s of waits', 'one']);
});
test('overlap wording does not claim overlap means not separated', () => {
  for (const s of [OVERLAP_NOTE, NOISE_NOTE_AVG]) expect(s).not.toMatch(/overlap, the two configurations are not separated|overlap for most pairs/);
});
