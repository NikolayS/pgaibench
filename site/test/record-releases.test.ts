// Every release has a frozen table: its page reads only the snapshot file named in RELEASE_LIST.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_LIST, releaseOf } from '../src/release';

test('each release has its snapshot with its run count', () => {
  for (const r of RELEASE_LIST) {
    const f = join(import.meta.dir, '../content', r.snapshot);
    expect(existsSync(f)).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8')).samplesPerArm[0].samples).toBe(r.runs);
  }
});

test('releases are in order: versions, dates and cutoffs grow', () => {
  for (let i = 1; i < RELEASE_LIST.length; i++) {
    expect(RELEASE_LIST[i]!.date >= RELEASE_LIST[i - 1]!.date).toBe(true);
    expect(RELEASE_LIST[i]!.cutoff > RELEASE_LIST[i - 1]!.cutoff).toBe(true);
    expect(Bun.semver.order(RELEASE_LIST[i]!.version, RELEASE_LIST[i - 1]!.version)).toBe(1);
  }
});

test('a refresh belongs to the first release whose cutoff is at or after it', () => {
  for (const r of RELEASE_LIST) expect(releaseOf(r.cutoff)).toBe(r);
  expect(releaseOf('9999-01-01T00:00:00Z')).toBeNull();
});

test('build reads release tables from RELEASE_LIST snapshots, not from live data', () => {
  const b = readFileSync(join(import.meta.dir, '../src/build.ts'), 'utf8');
  expect(b).toContain('RELEASE_LIST');
  expect(b).not.toMatch(/record-v\d/);
});

test('each frozen page shows the task-set label of its release', async () => {
  const { buildSite } = await import('../src/build');
  const fx = await import('./fixtures/seo-site');
  const snap = JSON.parse(readFileSync(join(import.meta.dir, '../content', RELEASE_LIST.at(-1)!.snapshot), 'utf8'));
  const files = buildSite({ ...fx.buildOpts, pooledJson: snap });
  for (const r of RELEASE_LIST) {
    const doc = files.get(`releases/v${r.version}/index.html`)!;
    expect(/Version<\/th><td class="width-min">([^<]*)</.exec(doc)![1]).toBe(r.taskSet);
  }
});
