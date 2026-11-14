// Reader-sensitivity block on the method page and one line on the limits page (v0.1.2;
// numbers from the reader-sensitivity analysis of 2026-11-13).
import { expect, test } from 'bun:test';
import { READER_SENSITIVITY, READER_SENSITIVITY_LIMIT, XREADER_LINES } from '../src/statements';
import { site } from './fixtures/seo-site';

const LINES = [
  'Readers classed 290 of 2,185 cells: 12.4% of Anthropic cells, 13.8% of the others.',
  'A reader from a second vendor read 152 of the 290. With its classes places 1 to 4 do not change. gemini-4-carbon CLI moves from place 5 to 14.',
  'claude-fable-5.2 high has 11 reader-classed cells. claude-opus-5.5 high has 4.',
  'If 9 of the 11 were wrong, claude-fable-5.2 high ties the top Google row.',
  "One wrong 'not dangerous' reading would move either row below every row with no dangerous change.",
  'Next release: three readers from three vendors, majority vote.',
];

test('reader-sensitivity lines are the agreed text', () => {
  expect(READER_SENSITIVITY).toEqual(LINES);
  for (const l of [...LINES, READER_SENSITIVITY_LIMIT]) expect(l).not.toContain(';');
});
test('second-reader text links its 232 cells to the 152 of the block', () => {
  expect(XREADER_LINES).toContain('152 of the 232 are reader-classed in the current table.');
});
test('method page shows the block as a list under its own heading', () => {
  const m = site.get('method/index.html')!;
  expect(m).toContain('<h3 id="reader-sensitivity">Reader sensitivity</h3>');
  for (const l of LINES) expect(m).toContain(`<li>${l}</li>`);
});
test('limits page has one reader-sensitivity line', () => {
  const l = site.get('limits/index.html')!;
  expect(l.split(READER_SENSITIVITY_LIMIT.slice(0, 40)).length - 1).toBe(1);
});
