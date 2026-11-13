// Footer: the release mark while the shown results are the released table; "unreleased" only when they differ.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { footVersion, releaseLine } from '../src/release';
import { sameResults } from '../src/pooled';

const snap = JSON.parse(readFileSync(join(import.meta.dir, '../content/record-v0.1.1-pooled.json'), 'utf8'));

test('code-only changes after the tag: footer keeps the release mark and the build stamp', () => {
  expect(footVersion({ ahead: 2, released: true }, 'abc1234')).toBe('v0.1.1, 2026-11-13, build abc1234');
  expect(footVersion({ ahead: 0 }, 'abc1234')).toBe('v0.1.1, 2026-11-13, build abc1234');
  expect(releaseLine({ ahead: 2, released: true })).not.toContain('unreleased');
});

test('shown results differ from the frozen table: "unreleased, after v0.1.1"', () => {
  expect(footVersion({ ahead: 2, released: false }, 'abc1234')).toBe('unreleased, after v0.1.1');
  expect(releaseLine({ ahead: 2, released: false })).toContain('(unreleased)');
});

test('sameResults: equal to the snapshot; a changed score, place or row is not', () => {
  expect(sameResults(structuredClone(snap), snap)).toBe(true);
  const t = structuredClone(snap); t.data_at = 'later'; expect(sameResults(t, snap)).toBe(true);
  const a = structuredClone(snap); a.rows[0].score += 0.5; expect(sameResults(a, snap)).toBe(false);
  const b = structuredClone(snap); b.rows[1].place = 99; expect(sameResults(b, snap)).toBe(false);
  const c = structuredClone(snap); c.rows.pop(); expect(sameResults(c, snap)).toBe(false);
});

test('build passes released = sameResults(live, v0.1.1 snapshot) to the footer', () => {
  const b = readFileSync(join(import.meta.dir, '../src/build.ts'), 'utf8');
  expect(b).toMatch(/released: [^,}]*sameResults\(/);
});

test('build: live data equal to the snapshot keeps the release mark in the footer; changed data says unreleased', async () => {
  const { buildSite } = await import('../src/build');
  const fx = await import('./fixtures/seo-site');
  const same = buildSite({ ...fx.buildOpts, pooledJson: snap, release: { ahead: 2 } }).get('index.html')!;
  expect(/ver-foot"><small>([^<]*)/.exec(same)![1]).toMatch(/^v0\.1\.1, 2026-11-13, build /);
  const moved = structuredClone(snap); moved.rows[0].score -= 1;
  const diff = buildSite({ ...fx.buildOpts, pooledJson: moved, release: { ahead: 2 } }).get('index.html')!;
  expect(/ver-foot"><small>([^<]*)/.exec(diff)![1]).toBe('unreleased, after v0.1.1');
});
