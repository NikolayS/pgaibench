// Dry run of the release step on a temporary copy: one bump call adds the next release, the build then
// shows it on live pages, keeps every earlier frozen page, and says "provisional" nowhere.
import { afterAll, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE, RELEASE_LIST } from '../src/release';

const ROOT = join(import.meta.dir, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'pgaibench-bump-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const [ma, mi, pa] = RELEASE.version.split('.').map(Number);
const next = `${ma}.${mi}.${pa! + 1}`;

test('bump on a temp copy: every release page built, live pages show the new release, no "provisional"', () => {
  for (const d of ['site', 'src', 'scenarios', 'prompts']) cpSync(join(ROOT, d), join(tmp, d), { recursive: true });
  for (const f of ['package.json', 'models.json']) cpSync(join(ROOT, f), join(tmp, f));
  symlinkSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'));
  // the public tree keeps CHANGELOG.md at the root
  const changelog = readFileSync(['CHANGELOG.md', 'public-overlay/CHANGELOG.md'].map(f => join(ROOT, f)).find(existsSync)!, 'utf8');
  writeFileSync(join(tmp, 'CHANGELOG.md'), changelog);
  // the live table of the next release: the newest snapshot with one changed score
  const live = JSON.parse(readFileSync(join(ROOT, 'site', 'content', RELEASE.snapshot), 'utf8'));
  live.rows[0].score -= 1;
  writeFileSync(join(tmp, 'live-pooled.json'), JSON.stringify(live, null, 2));
  const date = '2099-01-01', cutoff = '2099-01-01T00:00:00Z';
  const b = Bun.spawnSync(['bun', 'run', 'site/src/bump.ts', next, date, 'live-pooled.json', cutoff], { cwd: tmp });
  expect(b.exitCode).toBe(0);
  writeFileSync(join(tmp, 'probe.ts'), `
import { buildSite } from './site/src/build';
import { buildOpts } from './site/test/fixtures/seo-site';
import { readFileSync } from 'node:fs';
const pooledJson = JSON.parse(readFileSync('live-pooled.json', 'utf8'));
const files = buildSite({ ...buildOpts, pooledJson, release: { ahead: 3 } });
const live = [...files].filter(([p]) => p.endsWith('.html') && !p.startsWith('releases/v') && p !== 'changelog/index.html');
console.log(JSON.stringify({
  pages: [...files.keys()].filter(p => /^releases\\/v[^/]+\\/index\\.html$/.test(p)).sort(),
  foot: /ver-foot"><small>([^<]*)/.exec(files.get('index.html')!)?.[1],
  top: /<p class="meta top-line">([\\s\\S]*?)<\\/p>/.exec(files.get('leaderboard/index.html')!)?.[1],
  provisional: live.filter(([, d]) => /provisional/i.test(d.replace(/<[^>]+>/g, ' ').replace(/first provisional (publication|results)|provisional\\.json/g, ''))).map(([p]) => p),
  release: (await import('./site/src/release')).RELEASE,
  pkg: JSON.parse(readFileSync('package.json', 'utf8')).version,
  changelog: readFileSync('CHANGELOG.md', 'utf8'),
}));`);
  const r = Bun.spawnSync(['bun', 'run', 'probe.ts'], { cwd: tmp });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const o = JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!);
  expect(o.pages).toEqual([...RELEASE_LIST.map(x => x.version), next].map(v => `releases/v${v}/index.html`).sort());
  const taskSet = JSON.parse(readFileSync(join(ROOT, 'site', 'data', 'frozen-v01.json'), 'utf8')).scenario_set;
  expect(o.release).toEqual({ version: next, date, runs: live.samplesPerArm[0].samples, snapshot: `record-v${next}-pooled.json`, cutoff, taskSet });
  expect(o.foot).toStartWith(`v${next}, ${date}`);
  expect(o.top).toContain(`Release v${next}.`);
  expect(o.top).not.toContain('Unreleased');
  expect(o.provisional).toEqual([]);
  expect(o.pkg).toBe(next);
  expect(o.changelog).toContain(`## [Unreleased]\n\n## [${next}] - ${date}`);
  expect(o.changelog).toContain(`[Unreleased]: https://github.com/NikolayS/pgaibench/compare/v${next}...HEAD\n[${next}]: https://github.com/NikolayS/pgaibench/releases/tag/v${next}`);
}, 60000);
