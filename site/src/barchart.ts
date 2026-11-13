// The home bar chart. One row per configuration: tasks done per run as a bar on a linear axis from 0 to the
// task count, the value at the bar end, and dangerous changes per run in a right column. Fewest dangerous
// changes first, then most tasks done. Bars in the vendor colour of the main chart. A <title> per row.
import { esc } from './html';
import type { CRow } from './mainchart';

const n1 = (v: number) => String(Math.round(v * 10) / 10);
const tw = (s: string, fs: number) => s.length * fs * 0.6;
const FAMS = new Set(['anthropic', 'openai', 'google', 'open']);

/** Warning colour of the dangerous column, light and dark (also in style.css as --mc-warn). */
export const WARN_COLORS = { light: '#b3261e', dark: '#ff8a80' };
export const barCaption = (tasks: number, runs: number) => `${tasks} public tasks, mean of ${runs} runs, no tools. Neighbouring rows can differ by one answer in one run.`;
export const BAR_CAPTION = barCaption(19, 5);

export function barOrder(rows: CRow[]): CRow[] {
  return [...rows].sort((a, b) => a.dangerous - b.dangerous || b.done - a.done || a.name.localeCompare(b.name) || a.effort.localeCompare(b.effort));
}

export function barChartSvg(rows: CRow[], o: { id: string; width: number; tasks: number }): string {
  const W = o.width, phone = W < 500, n = o.tasks, fs = phone ? 11 : 13, lh = fs + 3, rh = phone ? 20 : 24;
  const ord = barOrder(rows);
  const places = new Map<CRow, number>();
  ord.filter(r => r.ranked).forEach((r, i) => places.set(r, i + 1));
  const pfs = fs * 0.85, PW = tw(String(Math.max(1, places.size)), pfs) + 6;
  const label = (r: CRow) => `${r.name} · ${r.effort}`;
  // label column: as narrow as the longest label; on a phone as narrow as the longest name (at most 55 percent),
  // a label wider than that puts its muted effort on a second line
  const cap = phone ? Math.min(W * 0.55 - PW, Math.max(...ord.map(r => tw(r.name, fs)))) : Infinity;
  const two = (r: CRow) => tw(label(r), fs) > cap;
  const LW = Math.min(cap, Math.max(...ord.map(r => (two(r) ? Math.max(tw(r.name, fs), tw(`· ${r.effort}`, fs)) : tw(label(r), fs)))));
  const head = phone ? ['dangerous', 'changes', 'per run'] : ['dangerous changes per run'];
  const DW = Math.max(...head.map(h => tw(h, fs))), TOP = head.length * lh + 6;
  const BX = PW + LW + 10, VR = tw(String(n), fs) + 8, BW = W - BX - VR - 14 - DW, X = (v: number) => BX + (v / n) * BW;
  const DX = W - DW / 2;
  const out: string[] = [], lb = (x0: number, y0: number, x1: number, y1: number) => ` data-lbox="${n1(x0)} ${n1(y0)} ${n1(x1)} ${n1(y1)}"`;
  head.forEach((h, i) => { const y = (i + 1) * lh - 2; out.push(`<text class="bc-head" x="${n1(DX)}" y="${y}" text-anchor="middle"${lb(DX - tw(h, fs) / 2, y - fs * 0.8, DX + tw(h, fs) / 2, y + fs * 0.25)}>${esc(h)}</text>`); });
  let y = TOP;
  const rowsSvg: string[] = [];
  for (const r of ord) {
    const t2 = two(r), h = t2 ? rh + lh - 4 : rh, cy = y + h / 2, ty = cy + fs * 0.35, bh = phone ? 10 : 12;
    const iv = r.lo != null && r.hi != null ? ` (95% interval ${n1(r.lo)} to ${n1(r.hi)})` : '';
    const d = n1(r.dangerous), title = `${label(r)}: ${n1(r.done)} of ${n} tasks done${iv}, ${d} dangerous ${d === '1' ? 'change' : 'changes'} per run${r.ranked ? `, place ${places.get(r)}` : ', no place'}`;
    const fam = FAMS.has(r.family) ? r.family : 'other', pl = places.get(r);
    const lx = PW + LW;
    const lab = t2
      ? `<text class="bc-lab" x="${n1(lx)}" y="${n1(ty - lh / 2)}" text-anchor="end"${lb(lx - tw(r.name, fs), ty - lh / 2 - fs * 0.8, lx, ty + lh / 2 + fs * 0.25)}>${esc(r.name)}<tspan class="bc-eff" x="${n1(lx)}" dy="${lh}">· ${esc(r.effort)}</tspan></text>`
      : `<text class="bc-lab" x="${n1(lx)}" y="${n1(ty)}" text-anchor="end"${lb(lx - tw(label(r), fs), ty - fs * 0.8, lx, ty + fs * 0.25)}>${esc(r.name)} <tspan class="bc-eff">· ${esc(r.effort)}</tspan></text>`;
    const bw = X(r.done) - BX, vx = X(r.done) + 4, v = n1(r.done);
    rowsSvg.push(`<g class="bc-row${r.ranked ? '' : ' bc-noplace'}" data-id="${esc(r.id)}" data-done="${v}" data-dangerous="${d}" tabindex="0"><title>${esc(title)}</title>`
      + (pl ? `<text class="bc-pl" x="0" y="${n1(ty)}" font-size="${n1(pfs)}"${lb(0, ty - pfs * 0.8, tw(String(pl), pfs), ty + pfs * 0.25)}>${pl}</text>` : '')
      + lab
      + `<rect class="bc-bar mc-v-${fam}" x="${n1(BX)}" y="${n1(cy - bh / 2)}" width="${n1(bw)}" height="${bh}" data-v="${v}"/>`
      + `<text class="bc-val" x="${n1(vx)}" y="${n1(ty)}"${lb(vx, ty - fs * 0.8, vx + tw(v, fs), ty + fs * 0.25)}>${v}</text>`
      + `<text class="${r.dangerous === 0 ? 'bc-d0' : 'bc-dw'}" x="${n1(DX)}" y="${n1(ty)}" text-anchor="middle"${lb(DX - tw(d, fs) / 2, ty - fs * 0.8, DX + tw(d, fs) / 2, ty + fs * 0.25)}>${d}</text></g>`);
    y += h;
  }
  const Y0 = y + 4;
  // on a phone the end label sits too close to 15: the axis line ends at the task count without it
  for (const t of [0, 5, 10, 15, ...(phone ? [] : [n])].filter((t, i, a) => t <= n && a.indexOf(t) === i)) {
    const x = X(t), ty = Y0 + fs + 4, w = tw(String(t), fs);
    out.push(`<line class="${t ? 'bc-grid' : 'bc-axis'}" x1="${n1(x)}" y1="${TOP - 2}" x2="${n1(x)}" y2="${n1(Y0)}"/>`);
    out.push(`<text class="bc-tick" x="${n1(x)}" y="${n1(ty)}" text-anchor="middle" data-xtick="${t} ${n1(x)}"${lb(x - w / 2, ty - fs * 0.8, x + w / 2, ty + fs * 0.25)}>${t}</text>`);
  }
  out.push(`<line class="bc-axis" x1="${n1(BX)}" y1="${n1(Y0)}" x2="${n1(X(n))}" y2="${n1(Y0)}"/>`);
  const at = `tasks done per run, of ${n}`, atw = tw(at, fs), ax = Math.max(0, Math.min(BX + BW / 2 - atw / 2, W - atw)), ay = Y0 + 2 * fs + 12;
  out.push(`<text class="bc-atitle" x="${n1(ax)}" y="${n1(ay)}"${lb(ax, ay - fs * 0.8, ax + atw, ay + fs * 0.25)}>${esc(at)}</text>`);
  const H = Math.ceil(ay + 6);
  const aria = `Tasks done per run, 0 to ${n}, and dangerous changes per run, one row per configuration, fewest dangerous changes first.`;
  return `<svg class="bc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" data-chart="${esc(o.id)}" data-bar-x="${n1(BX)}" font-family="inherit" font-size="${fs}" preserveAspectRatio="xMinYMin meet">${out.join('')}${rowsSvg.join('')}</svg>`;
}

export function barChartFigure(rows: CRow[], o: { id: string; tasks: number; runs?: number; full: string }): string {
  const wide = barChartSvg(rows, { id: o.id, width: 1400, tasks: o.tasks }).replace('<svg class="bc"', '<svg class="bc bc-wide"');
  const narrow = barChartSvg(rows, { id: o.id, width: 340, tasks: o.tasks }).replace('<svg class="bc"', '<svg class="bc bc-narrow"');
  return `<figure class="svg-chart bc-fig" id="${esc(o.id)}">${narrow}${wide}<figcaption>${esc(barCaption(o.tasks, o.runs ?? 5))} <a href="${esc(o.full)}">full table</a></figcaption></figure>`;
}
