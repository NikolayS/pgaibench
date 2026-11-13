// The five-run table of v0.1.1 is frozen at the tag: its page reads only the snapshot file.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const f = join(import.meta.dir, '../content/record-v0.1.1-pooled.json');

test('v0.1.1 snapshot exists and holds the five-run table', () => {
  expect(existsSync(f)).toBe(true);
  const p = JSON.parse(readFileSync(f, 'utf8'));
  expect(p.samplesPerArm[0].samples).toBe(5);
  expect(p.rows.filter((r: { place: number | null }) => r.place !== null).length).toBe(17);
});

test('build reads the v0.1.1 page from the snapshot, not from live data', () => {
  const b = readFileSync(join(import.meta.dir, '../src/build.ts'), 'utf8');
  expect(b).toContain("'record-v0.1.1-pooled.json'");
});
