import { expect, test } from 'bun:test';
import { renderTelemetryTimelineSvg } from '../src/telemetry-chart';
import { episode } from './fixtures/replay-episode';

const trace = (svg: string, name: string) => svg.match(new RegExp('<g data-series="' + name + '"[^>]*>(.*?)</g>'))?.[1] ?? '';
test('uses recorded coordinates, breaks paths at nulls and draws isolated observations', () => {
  const svg = renderTelemetryTimelineSvg(episode, { width: 600, height: 400 });
  const tps = trace(svg, 'tps');
  expect(tps.match(/<path /g)).toHaveLength(2); // change 0..1, post 10..11
  expect(tps.match(/<circle /g)).toHaveLength(1); // isolated second 3
  const positions = [...tps.matchAll(/d="M([\d.]+) [\d.]+ L([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const [[x0, x1], [post]] = positions;
  const oneSecond = x1 - x0;
  expect((post - x0) / oneSecond).toBeCloseTo(10, 1);
  const lockX = Number(trace(svg, 'workload-wait').match(/d="M([\d.]+)/)?.[1]);
  expect((lockX - x0) / oneSecond).toBeCloseTo(10.4, 1);
  const crX = Number(svg.match(/class="cr-start" x1="([\d.]+)/)?.[1]);
  expect((crX - x0) / oneSecond).toBeCloseTo(1.5, 1);
  const [, restartX, restartWidth] = svg.match(/class="restart" x="([\d.]+)" width="([\d.]+)"/)!;
  expect((Number(restartX) - x0) / oneSecond).toBeCloseTo(2.5, 1);
  expect(Number(restartWidth) / oneSecond).toBeCloseTo(1.5, 1);
  expect(trace(svg, 'standby-wait')).toContain('<path ');
  expect(trace(svg, 'standby-lag')).toContain('<path ');
});

test('caption, reference lines and observed zero values remain readable', () => {
  const svg = renderTelemetryTimelineSvg(episode);
  for (const label of ['5.0 s harmful', '3.5 s degraded', 'CR start', 'ticket &lt;A&gt;', 'test/model', 'high', 'trapped',
    'Max lock wait 6 s', 'Longest zero run 1 s', 'Stalled total 0 s', 'unexpected &lt;change&gt;']) expect(svg).toContain(label);
});

test('partial episodes never invent a post start, a CR marker or zero measurements', () => {
  const svg = renderTelemetryTimelineSvg({ ...episode, cr_start_epoch: null, post_tps_start_epoch: null,
    tps_counts_1s: [null], lock_wait_samples: null, lock_wait_epochs: null, standby_lock_wait_samples: null,
    replication_lag_s: null, max_lock_wait_s: null });
  expect(svg).not.toContain('class="cr-start"');
  expect(trace(svg, 'tps')).not.toContain('<path ');
  expect(svg).toContain('Post window timing unavailable');
  expect(svg).toContain('Max lock wait —');
  expect(svg).not.toMatch(/NaN|Infinity/);
});

test('untimed lag readings keep their values without claiming a synchronized position', () => {
  const svg = renderTelemetryTimelineSvg({ ...episode, replication_lag_s: [2.5] });
  const lag = trace(svg, 'standby-lag');
  expect(lag).toContain('<circle ');
  expect(lag).not.toContain('<path ');
  expect(svg).toContain('Dots at right have no recorded time.');
});

test('lock-only episodes break at missing seconds and use the post offset without individual epochs', () => {
  const svg = renderTelemetryTimelineSvg({ ...episode, tps_counts_1s: null, post_tps_counts_1s: null,
    lock_wait_samples: [0, 3, 6, 2], lock_wait_epochs: [100, 104, null, null] });
  const lock = trace(svg, 'workload-wait');
  expect(lock.match(/<circle /g)).toHaveLength(2);
  const [, from, to] = lock.match(/d="M([\d.]+) [\d.]+ L([\d.]+)/)!;
  const first = Number(lock.match(/cx="([\d.]+)"/)![1]);
  expect((Number(from) - first) / (Number(to) - Number(from))).toBeCloseTo(10, 1);
});
