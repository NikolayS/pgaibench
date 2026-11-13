// The release step: one call adds a release. Usage (from the repository root):
//   bun run site/src/bump.ts <X.Y.Z> <YYYY-MM-DD> <data/pooled.json of the published build> <its data time>
// The data time is data_at in data/provisional.json of the same build (UTC).
// It writes the frozen table site/content/record-vX.Y.Z-pooled.json, appends the release to RELEASE_LIST
// (site/src/release.ts), sets the version in package.json and turns the
// Unreleased section of CHANGELOG.md into the release section with its link line.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'https://github.com/NikolayS/pgaibench';

export type Bump = { root: string; version: string; date: string; pooledPath: string; cutoff: string; changelog?: string };

export function bump(o: Bump): void {
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error(`version must be X.Y.Z: ${o.version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error(`date must be YYYY-MM-DD (UTC): ${o.date}`);
  const pooledRaw = readFileSync(o.pooledPath, 'utf8');
  const pooled = JSON.parse(pooledRaw);
  const runs: number = pooled.samplesPerArm?.[0]?.samples;
  const cutoff = o.cutoff;
  if (!Number.isInteger(runs) || runs < 1) throw new Error('pooled.json has no run count (samplesPerArm)');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cutoff ?? '')) throw new Error(`data time must be YYYY-MM-DDTHH:MM:SSZ: ${cutoff}`);
  const snapshot = `record-v${o.version}-pooled.json`;
  const snapPath = join(o.root, 'site', 'content', snapshot);
  if (existsSync(snapPath)) throw new Error(`release ${o.version} exists: ${snapshot}`);
  // 1. the frozen table
  writeFileSync(snapPath, pooledRaw);
  // 2. the release list
  const relPath = join(o.root, 'site', 'src', 'release.ts');
  const rel = readFileSync(relPath, 'utf8');
  const end = rel.indexOf('\n];', rel.indexOf('export const RELEASE_LIST'));
  if (end < 0) throw new Error('RELEASE_LIST not found in release.ts');
  const taskSet: string = JSON.parse(readFileSync(join(o.root, 'site', 'data', 'frozen-v01.json'), 'utf8')).scenario_set;
  const entry = `\n  { version: '${o.version}', date: '${o.date}', runs: ${runs}, snapshot: '${snapshot}', cutoff: '${cutoff}', taskSet: '${taskSet}' },`;
  writeFileSync(relPath, rel.slice(0, end) + entry + rel.slice(end));
  // 3. package.json
  const pkgPath = join(o.root, 'package.json');
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(/"version": "[^"]+"/, `"version": "${o.version}"`));
  // 4. CHANGELOG.md
  const clPath = o.changelog ?? join(o.root, 'CHANGELOG.md');
  let cl = readFileSync(clPath, 'utf8');
  if (!cl.includes('## [Unreleased]')) throw new Error('CHANGELOG.md has no Unreleased section');
  cl = cl.replace('## [Unreleased]', `## [Unreleased]\n\n## [${o.version}] - ${o.date}`);
  cl = cl.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${REPO}/compare/v${o.version}...HEAD\n[${o.version}]: ${REPO}/releases/tag/v${o.version}`);
  writeFileSync(clPath, cl);
}

if (import.meta.main) {
  const [version, date, pooledPath, cutoff] = process.argv.slice(2);
  if (!version || !date || !pooledPath || !cutoff) { console.error('usage: bun run site/src/bump.ts <X.Y.Z> <YYYY-MM-DD> <pooled.json> <data time, UTC>'); process.exit(2); }
  bump({ root: process.cwd(), version, date, pooledPath, cutoff: cutoff!, changelog: process.env.CHANGELOG });
  console.log(`release ${version}: snapshot, release list, package.json and CHANGELOG.md updated`);
}
