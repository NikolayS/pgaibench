import type { TelemetryEpisode } from '../../scripts/export-telemetry';
import { esc } from './html';
import { svgLabel as label, svgLines } from './svg-text';

type Samples = TelemetryEpisode['lock_wait_samples'];
type Sample = { time: number | null; value: number | null };
type Trace = { name: string; label: string; color: string; dash?: string; windows: Sample[][] };
const at = (values: Samples, time: (i: number) => number | null): Sample[] =>
  (values ?? []).map((value, i) => ({ time: time(i), value }));
const rounded = (n: number) => +n.toFixed(2);
const seconds = (n: number | null) => n === null ? '—' : n + ' s';

function traces(ep: TelemetryEpisode) {
  const start = ep.tps_start_epoch;
  const postOffset = start !== null && ep.post_tps_start_epoch !== null ? ep.post_tps_start_epoch - start : null;
  const split = ep.post_lock_wait_index ?? Math.max(0, (ep.lock_wait_samples?.length ?? 0) - (ep.post_tps_counts_1s?.length ?? 0));
  const hasPost = ep.post_lock_wait_index !== null || !!ep.post_tps_counts_1s?.length;
  const lockTime = (i: number) => {
    const epoch = ep.lock_wait_epochs?.[i];
    if (start !== null && epoch != null) return epoch - start;
    return !hasPost || i < split ? i : postOffset === null ? null : postOffset + i - split;
  };
  const waitWindows = (samples: Samples) => {
    const values = at(samples, lockTime);
    return hasPost ? [values.slice(0, split), values.slice(split)] : [values];
  };
  const tps: Trace = { name: 'tps', label: 'Primary TPS (tx/s)', color: 'currentColor',
    windows: [at(ep.tps_counts_1s, i => i), at(ep.post_tps_counts_1s, i => postOffset === null ? null : postOffset + i)] };
  const lower: Trace[] = [{ name: 'workload-wait', label: 'Workload lock wait', color: 'var(--mc-google, #2563d6)', windows: waitWindows(ep.lock_wait_samples) }];
  if (ep.standby_lock_wait_samples?.length) lower.push({ name: 'standby-wait', label: 'Standby lock wait', color: 'var(--mc-open, #7c3f98)', dash: '6 3', windows: waitWindows(ep.standby_lock_wait_samples) });
  if (ep.replication_lag_s?.length) {
    // The collector omits failed LSN queries from lag_s, and does not append the post window.
    // A shorter lag array therefore has values but no recoverable per-sample timestamps.
    const compressed = ep.lock_wait_samples !== null && ep.replication_lag_s.length !== split;
    lower.push({ name: 'standby-lag', label: 'Standby lag', color: 'var(--mc-openai, #0b7d62)', dash: '2 2',
      windows: [at(ep.replication_lag_s, i => compressed ? null : lockTime(i) ?? i)] });
  }
  return { tps, lower, postOffset };
}

function drawTrace(trace: Trace, x: (t: number) => number, y: (v: number) => number, untimedX: number): string {
  const marks: string[] = [];
  const dot = (cx: number, cy: number) => `<circle cx="${cx}" cy="${cy}" r="2.2" fill="${trace.color}" stroke="none"/>`;
  for (const window of trace.windows) {
    let run: [number, number][] = [], previous: number | null = null;
    const flush = () => {
      if (run.length === 1) marks.push(dot(...run[0]!));
      else if (run.length) marks.push(`<path d="M${run.map(([cx, cy]) => cx + ' ' + cy).join(' L')}"/>`);
      run = [];
    };
    for (const { time, value } of window) {
      if (value === null || time === null || time < 0) {
        flush();
        if (value !== null && time === null) marks.push(dot(untimedX, y(value)));
      } else {
        if (previous !== null && (time < previous || time - previous >= 2)) flush();
        run.push([x(time), y(value)]);
      }
      previous = time;
    }
    flush();
  }
  return `<g data-series="${trace.name}" stroke="${trace.color}" fill="none" stroke-width="1.8"${trace.dash ? ` stroke-dasharray="${trace.dash}"` : ''}>${marks.join('')}</g>`;
}

export function renderTelemetryTimelineSvg(ep: TelemetryEpisode, opts: { width?: number; height?: number } = {}): string {
  const { tps, lower, postOffset } = traces(ep);
  const series = [tps, ...lower];
  const start = ep.tps_start_epoch;
  const cr = start !== null && ep.cr_start_epoch !== null ? ep.cr_start_epoch - start : null;
  const restarts = (ep.restarts ?? []).flatMap(r => start === null || r.end_s < start || r.end_s < r.start_s ? []
    : [{ ...r, from: Math.max(0, r.start_s - start), to: r.end_s - start }]);
  let end = Math.max(1, cr ?? 0, ...restarts.map(r => r.to));
  let untimed = false;
  const maxima = series.map(s => {
    let peak = 0;
    for (const window of s.windows) for (const { time, value } of window) {
      if (time !== null) end = Math.max(end, time);
      else if (value !== null) untimed = true;
      if (value !== null) peak = Math.max(peak, value);
    }
    return peak;
  });
  const width = Math.max(320, opts.width ?? 760), left = 48, right = width - (untimed ? 74 : 20);
  const x = (time: number) => rounded(left + time / end * (right - left));
  const notes = [
    `Scenario ${ep.scenario} · Model ${ep.model ?? '—'} · Effort ${ep.effort ?? '—'} · Outcome ${ep.outcome ?? '—'}`,
    `Max lock wait ${seconds(ep.max_lock_wait_s)} · Longest zero run ${seconds(ep.longest_zero_run_s)} · Stalled total ${seconds(ep.stalled_seconds_total)}`,
    `Boundary violations · ${ep.boundary_violations === null ? '—' : ep.boundary_violations.join(', ') || 'none'}`,
  ];
  if (ep.stopped_at_rehearsal) notes.unshift('Recorded on the rehearsal clone.');
  if (ep.post_tps_counts_1s?.length && postOffset === null) notes.push('Post window timing unavailable.');
  if (untimed) notes.push('Dots at right have no recorded time.');
  const cols = Math.floor((width - 24) / 7.4);
  const lines = notes.flatMap(s => svgLines(s, cols));
  const legendHeight = 17 * (lower.length + 2);
  const height = Math.max(opts.height ?? 470, 240 + legendHeight + lines.length * 17);
  const top = 44, bottom = height - 55 - legendHeight - lines.length * 17;
  const mid = (bottom + top) / 2, upperEnd = mid - 20, lowerStart = mid + 20;
  const maxTps = Math.max(1, Math.ceil(maxima[0]!)), maxWait = Math.max(6, Math.ceil(Math.max(...maxima.slice(1))));
  const yTps = (v: number) => rounded(upperEnd - v / maxTps * (upperEnd - top));
  const yWait = (v: number) => rounded(bottom - v / maxWait * (bottom - lowerStart));
  const body: string[] = [];
  body.push(label(left, 15, tps.label), label(left, lowerStart - 12, 'Workload lock wait & standby lag (s)'));
  for (const r of restarts) body.push(`<rect class="restart" x="${x(r.from)}" width="${rounded(x(r.to) - x(r.from))}" y="${top}" height="${bottom - top}" fill="currentColor" opacity=".12"><title>${esc(r.node)} restart${r.rollback ? ' (rollback)' : ''} · ${rounded(r.from)}–${rounded(r.to)} s</title></rect>`);
  for (const [y0, yMax, max] of [[upperEnd, top, maxTps], [bottom, lowerStart, maxWait]]) {
    body.push(`<path d="M${left} ${yMax}V${y0}H${right}" fill="none" stroke="currentColor"/>`,
      label(left - 6, yMax + 4, String(max), 'end'), label(left - 6, y0 + 4, '0', 'end'));
  }
  const refs = [{ value: 5, label: '5.0 s harmful', dash: '8 3' }, { value: 3.5, label: '3.5 s degraded', dash: '2 4' }];
  for (const ref of refs) body.push(`<path d="M${left} ${yWait(ref.value)}H${right}" fill="none" stroke="currentColor" stroke-dasharray="${ref.dash}" opacity=".6"><title>${ref.label}</title></path>`);
  body.push(drawTrace(tps, x, yTps, right + 32));
  for (const s of lower) body.push(drawTrace(s, x, yWait, right + 32));
  if (cr !== null && cr >= 0) body.push(`<line class="cr-start" x1="${x(cr)}" x2="${x(cr)}" y1="${top - 4}" y2="${upperEnd}" stroke="currentColor" stroke-dasharray="4 3"/>`,
    label(x(cr), top - 9, 'CR start', cr > end / 2 ? 'end' : 'start'));
  for (const time of [0, end / 2, end]) body.push(label(x(time), bottom + 17, String(rounded(time)), time === end ? 'end' : 'middle'));
  body.push(label((left + right) / 2, bottom + 34, 'Elapsed time (s)', 'middle'));
  let line = bottom + 54;
  for (const s of [...lower, ...refs.map(r => ({ ...r, color: 'currentColor' }))]) {
    body.push(`<path d="M10 ${line - 4}h24" stroke="${s.color}" stroke-width="1.8" stroke-dasharray="${s.dash ?? 'none'}"/>`, label(42, line, s.label));
    line += 17;
  }
  for (const s of lines) { body.push(label(10, line, s)); line += 17; }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="telemetry-timeline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded lab telemetry for ${esc(ep.scenario)}" font-family="monospace" font-size="12" fill="currentColor"><title>Recorded lab telemetry · ${esc(ep.scenario)}</title>${body.join('')}</svg>`;
}
