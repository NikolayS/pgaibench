import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryBundle } from '../../scripts/export-telemetry';
import { buildControlReport } from '../../src/control/report';
import { buildControlItems } from '../../src/control/items';
import { buildSite } from '../src/build';
import { renderControlParetoSvg } from '../src/control-pareto';
import { LAB_REPLAY_CSS, type LabReplayInput } from '../src/lab-replay';
import { checkLinks, readDist } from '../src/linkcheck';
import { renderTelemetryTimelineSvg } from '../src/telemetry-chart';
import type { BenchmarkCardData } from '../src/v02-pages';
import { episode } from './fixtures/replay-episode';

const options = { published: false, base: '/pgaibench/' };
const { pareto } = buildControlReport(buildControlItems().slice(0, 2), [], [0, 0.01, 0.05]);
const bundle: TelemetryBundle = { schema_version: 'pgaibench-telemetry-v0.2', exported_at: '2026-11-20T00:00:00Z',
  source_dir: 'public-runs', episode_count: 2, heldout_included: false,
  episodes: [episode, { ...episode, scenario: 'D1', episode_id: 'another', tps_counts_1s: [3, 4, 5] }] };
const replays: LabReplayInput[] = bundle.episodes.map(episode => ({ episode, task: `Ticket ${episode.episode_id}`,
  context_summary: 'Catalog snapshot', steps: [{ sql: 'SELECT 1' }], review: null, harm_checks: null }));
const card: BenchmarkCardData = { version: 'v0.2', preregPath: 'docs/prereg-v0.2.md', freezeCommit: 'def456a',
  publicTasks: 19, heldoutTasks: 3, controlPairs: 10, mainModels: 7, ablationModels: 2,
  cloneTopology: 'Two-node primary + standby', hygieneChecks: ['Isolated <HOME>'], cliVersions: ['test-cli 1.2.3'],
  spotCheckAgreement: '9 of 10' };

test('optional pages render the 1% comparison, each recorded replay, downloads and benchmark card', () => {
  const files = buildSite({ ...options, v02: { controlPareto: pareto, telemetryBundle: bundle, replays, benchmarkCard: card } });
  const control = files.get('control/index.html')!;
  expect(control).toContain(renderControlParetoSvg(pareto, { budget: 0.01 }));
  for (const text of ['SAMO / AAA', 'Protocol comparison', '<table', '0%, 1%, 5%', '../data/control-pareto.json']) expect(control).toContain(text);
  expect(JSON.parse(files.get('data/control-pareto.json')!)).toEqual(pareto);
  const replay = files.get('replay/index.html')!;
  expect(replay).toContain(`<style>${LAB_REPLAY_CSS}</style>`);
  expect(replay.match(/type="radio"/g)).toHaveLength(6);
  for (const item of replays) {
    expect(replay).toContain(item.task);
    expect(replay).toContain(renderTelemetryTimelineSvg(item.episode));
  }
  expect(replay).toContain('../data/telemetry-bundle.json');
  expect(JSON.parse(files.get('data/telemetry-bundle.json')!)).toEqual(bundle);
  const method = files.get('method/index.html')!;
  for (const text of ['<section id="benchmark-card">', card.version, `${card.freezeCommit}/${card.preregPath}`, '19 public tasks', '3 held-out tasks',
    '10 control pairs', '7 main models', '2 ablation models', card.cloneTopology, 'Isolated &lt;HOME&gt;', 'test-cli 1.2.3', '9 of 10']) expect(method).toContain(text);
  expect(files.get('data/index.html')).toContain('../control/index.html');
  expect(files.get('data/index.html')).toContain('../replay/index.html');
  expect(checkLinks(files, options.base)).toEqual([]);
  expect([...files].filter(([path, html]) => path.endsWith('.html') && html.includes('Analyzer')).map(([path]) => path)).toEqual([]);
});

test('no v0.2 inputs or no featured episodes leave the legacy build unchanged', () => {
  const legacy = buildSite(options);
  expect(buildSite({ ...options, v02: {} })).toEqual(legacy);
  expect(buildSite({ ...options, v02: { replays: [], telemetryBundle: bundle } })).toEqual(legacy);
  for (const path of ['control/index.html', 'replay/index.html', 'data/control-pareto.json', 'data/telemetry-bundle.json']) expect(legacy.has(path)).toBe(false);
  expect(legacy.get('method/index.html')).not.toContain('benchmark-card');
  expect(checkLinks(legacy, options.base)).toEqual([]);
});

test('replays without a bundle have no download link; private exports cannot be published', () => {
  const files = buildSite({ ...options, base: '/', v02: { replays } });
  expect(files.get('replay/index.html')).not.toContain('telemetry-bundle.json');
  expect(files.has('data/telemetry-bundle.json')).toBe(false);
  expect(checkLinks(files, '/')).toEqual([]);
  expect(() => buildSite({ ...options, v02: { replays, telemetryBundle: { ...bundle, heldout_included: true } } })).toThrow('held-out');
});

test('site:build accepts live export flags without requiring prejoined review records', () => {
  const temp = mkdtempSync(join(tmpdir(), 'v02-site-'));
  try {
    const out = join(temp, 'dist');
    const args = ['run', 'site:build'];
    for (const [flag, data] of [['control-pareto', pareto], ['telemetry-bundle', bundle], ['benchmark-card', card]] as const) {
      const path = join(temp, `${flag}.json`);
      writeFileSync(path, JSON.stringify(data));
      args.push(`--${flag}`, path);
    }
    execFileSync(process.execPath, args, { cwd: join(import.meta.dir, '../..'), env: { PATH: process.env.PATH, OUT: out, BASE: '/' }, stdio: 'pipe' });
    const files = readDist(out);
    expect(JSON.parse(readFileSync(join(out, 'data/telemetry-bundle.json'), 'utf8'))).toEqual(bundle);
    expect(files.get('control/index.html')).toContain('Protocol comparison');
    expect(files.get('method/index.html')).toContain('id="benchmark-card"');
    const html = files.get('replay/index.html')!;
    for (const item of bundle.episodes) expect(html).toContain(renderTelemetryTimelineSvg(item));
    for (const text of ['Customer 4242', 'Ticket text unavailable', 'Proposed steps unavailable', 'No Auditor verdict recorded', 'Harm checks unavailable']) expect(html).toContain(text);
    expect(checkLinks(files, '/')).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
