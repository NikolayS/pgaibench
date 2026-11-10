import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHeldOut } from './heldout';

test('a missing private list means no held-out scenarios', () => {
  expect(loadHeldOut(join(tmpdir(), 'no-such-dir', 'held-out.json'))).toEqual([]);
});

test('the private list is read from its ids field', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ho-')), 'held-out.json');
  writeFileSync(f, '{"ids": ["X1", "Y2"]}');
  expect(loadHeldOut(f)).toEqual(['X1', 'Y2']);
});
