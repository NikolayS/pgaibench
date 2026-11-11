// Build-time SVG charts. No script, no external files, no colour literals:
// every colour comes from CSS classes that read the theme variables
// (style.css, "SVG charts"), so light, dark and system themes work.
// Linear scale only, 0 to 100 from the left; values and intervals below 0
// are clipped at 0 with a small mark (the number is in the table).
import { esc } from './html';

export type HBarRow = { label: string; value: number; lo?: number; hi?: number };
export type HBarSpec = { id: string; title: string; desc: string; aria: string; rows: HBarRow[]; baselines?: HBarRow[]; notes?: string[]; unit?: string; /** value labels with one decimal (averages) */ decimals?: 1 };

/** Short model name: no vendor, no access path, no effort, no date suffix. */
export function shortName(id: string): string {
  let s = id.split('/').pop() ?? id;
  s = s.replace(/^claude-/, '').replace(/^gemini-[\d.]+-/, '').replace(/-\d{4}$/, '');
  return s;
}

const F = 14, CW = 8.5, ROW = 30, TOP = 4, NOTE = 22, VAL = 40;
const n1 = (v: number) => String(Math.round(v * 10) / 10);
const fmt = (v: number) => String(Math.round(v));

/** One horizontal bar chart, `width` user units wide; height a whole number of 20-unit lines. */
export function hbarSvg(s: HBarSpec & { width: number; line?: number }): string {
  const W = s.width, base = s.baselines ?? [], notes = s.notes ?? [];
  const lw = Math.ceil(Math.max(...[...s.rows, ...base].map(r => r.label.length)) * CW + 10);
  const x0 = lw, x1 = W - VAL, X = (v: number) => x0 + (Math.max(0, Math.min(100, v)) / 100) * (x1 - x0);
  const out: string[] = [];
  let y = TOP;
  const row = (r: HBarRow, outline: boolean) => {
    const cy = y + ROW / 2;
    out.push(`<text class="ch-lbl" x="${lw - 8}" y="${n1(cy + 5)}" text-anchor="end"${outline ? '' : ' font-weight="800"'}>${esc(r.label)}</text>`);
    if (r.value > 0) out.push(`<rect class="${outline ? 'ch-base' : 'ch-bar'}" x="${n1(x0)}" y="${cy - 8}" width="${n1(X(r.value) - x0)}" height="16"/>`);
    const lo = r.lo ?? r.value, hi = r.hi ?? r.value;
    let end = X(r.value);
    if (Math.round(lo) !== Math.round(hi) && hi > 0) {
      const a = X(lo), b = X(hi);
      out.push(`<line class="ch-ci" x1="${n1(a)}" y1="${cy}" x2="${n1(b)}" y2="${cy}"/>`);
      if (lo >= 0) out.push(`<line class="ch-ci" x1="${n1(a)}" y1="${cy - 5}" x2="${n1(a)}" y2="${cy + 5}"/>`);
      out.push(`<line class="ch-ci" x1="${n1(b)}" y1="${cy - 5}" x2="${n1(b)}" y2="${cy + 5}"/>`);
      end = Math.max(end, b);
    }
    if (lo < 0 || r.value < 0) { out.push(`<path class="ch-clip" d="M${n1(x0 + 1)} ${cy}l6 -5v10z"/>`); end = Math.max(end, x0 + 8); }
    out.push(`<text class="ch-v" x="${n1(end + 5)}" y="${n1(cy + 5)}" font-weight="800">${s.decimals ? n1(r.value) : fmt(r.value)}${s.unit ?? ''}</text>`);
    y += ROW;
  };
  for (const r of s.rows) row(r, false);
  if (base.length) {
    out.push(`<rect class="ch-bg" x="0" y="${y + 6}" width="${Math.ceil(20 * CW + 4)}" height="${ROW - 12}"/><text class="ch-group" x="0" y="${y + ROW / 2 + 5}">baselines</text>`); y += ROW;
    for (const r of base) row(r, true);
  }
  const axisY = y + 4;
  const grid = [0, 25, 50, 75, 100].map(t => `<line class="${t === 0 ? 'ch-zero' : 'ch-grid'}" x1="${n1(X(t))}" y1="${TOP}" x2="${n1(X(t))}" y2="${axisY}"/><text class="ch-tick" x="${n1(X(t))}" y="${axisY + 16}" text-anchor="middle">${t}${s.unit ?? ''}</text>`);
  y = axisY + 22;
  for (const n of notes) { out.push(`<text class="ch-note" x="0" y="${y + 15}">${esc(n)}</text>`); y += NOTE; }
  const H = Math.ceil((y + 4) / 20) * 20;
  const k = Math.ceil(H / (s.line ?? 20));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.aria)}" data-chart="${esc(s.id)}" data-x0="${n1(x0)}" font-family="inherit" font-size="${F}" style="--h: ${k}" preserveAspectRatio="xMinYMin meet"><title>${esc(s.title)}</title><desc>${esc(s.desc)}</desc>${grid.join('')}${out.join('')}</svg>`;
}

/** Figure in the style of The Monospace Web: a phone-size and a wide SVG (CSS shows one), an italic caption, then the table with the numbers. */
export function chartFigure(s: HBarSpec & { caption: string; table: string }): string {
  // Phones: the root font is 15px (line 18.75px) and the chart is about 367px wide for 360 units.
  const narrow = hbarSvg({ ...s, width: 360, line: 18.4 }).replace('<svg ', '<svg class="chart-narrow" ');
  const wide = hbarSvg({ ...s, width: 760 }).replace('<svg ', '<svg class="chart-wide" ');
  return `<figure class="svg-chart" id="${esc(s.id)}">${narrow}${wide}<figcaption>${s.caption}</figcaption></figure>\n${s.table}`;
}

export type StackRow = { label: string; key: string; segs: { cls: string; n: number }[] };
/** Stacked horizontal bars, one per row, linear from 0 to `total`; segment fills come from CSS classes `pf-<class>`. A count sits inside each segment wide enough for it. */
export function stackedSvg(s: { id: string; title: string; desc: string; aria: string; groups: { name: string; rows: StackRow[] }[]; total: number; legend: { name: string; items: { cls: string; label: string }[] }[]; width: number; line?: number }): string {
  const W = s.width, all = s.groups.flatMap(g => g.rows);
  const lw = Math.ceil(Math.max(...all.map(r => r.label.length)) * CW + 10), x0 = lw, x1 = W - 12;
  const X = (v: number) => x0 + (v / s.total) * (x1 - x0);
  const out: string[] = [];
  let y = TOP;
  for (const g of s.groups) {
    if (s.groups.length > 1) { out.push(`<text class="ch-group" x="0" y="${y + 17}">${esc(g.name.slice(0, 24))}</text>`); y += 24; }
    for (const r of g.rows) {
      const cy = y + ROW / 2;
      out.push(`<g class="pf-row" data-model="${esc(r.key)}"><text class="ch-lbl" x="${lw - 8}" y="${n1(cy + 5)}" text-anchor="end" font-weight="800">${esc(r.label)}</text>`);
      let at = 0;
      for (const sg of r.segs.filter(z => z.n > 0)) {
        const a = X(at), b = X(at + sg.n);
        out.push(`<rect class="pf pf-${sg.cls}" data-class="${sg.cls}" data-n="${sg.n}" x="${n1(a)}" y="${cy - 9}" width="${n1(b - a)}" height="18"/>`);
        if (b - a >= 16) out.push(`<text class="pf-n" x="${n1((a + b) / 2)}" y="${n1(cy + 4.5)}" text-anchor="middle" font-size="12">${sg.n}</text>`);
        at += sg.n;
      }
      out.push('</g>'); y += ROW;
    }
  }
  const axisY = y + 4;
  const ticks = [...new Set([...Array.from({ length: Math.floor(s.total / 5) + 1 }, (_, i) => i * 5).filter(t => s.total - t >= 3 || t === s.total), s.total])];
  const grid = ticks.map(t => `<line class="${t === 0 ? 'ch-zero' : 'ch-grid'}" x1="${n1(X(t))}" y1="${TOP}" x2="${n1(X(t))}" y2="${axisY}"/><text class="ch-tick" x="${n1(X(t))}" y="${axisY + 16}" text-anchor="middle">${t}${s.unit ?? ''}</text>`);
  y = axisY + 22;
  const H = Math.ceil((y + 6) / 20) * 20, k = Math.ceil(H / (s.line ?? 20));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.aria)}" data-chart="${esc(s.id)}" font-family="inherit" font-size="${F}" style="--h: ${k}" preserveAspectRatio="xMinYMin meet"><title>${esc(s.title)}</title><desc>${esc(s.desc)}</desc>${grid.join('')}${out.join('')}</svg>`;
}

export function stackedFigure(s: Omit<Parameters<typeof stackedSvg>[0], 'width' | 'line'> & { caption: string }): string {
  const narrow = stackedSvg({ ...s, width: 360, line: 18.4 }).replace('<svg ', '<svg class="chart-narrow" ');
  const wide = stackedSvg({ ...s, width: 760 }).replace('<svg ', '<svg class="chart-wide" ');
  // Legend as HTML: a swatch per class (a tiny SVG would repeat the fills; a span with the same class name is enough).
  const legend = s.legend.map(g => `<li><span class="dim">${esc(g.name)}:</span> ${g.items.map(it => `<span class="sw pf-${it.cls}" aria-hidden="true"></span>${esc(it.label)}`).join('; ')}</li>`).join('');
  return `<figure class="svg-chart" id="${esc(s.id)}-fig">${narrow}${wide}<figcaption>${s.caption}</figcaption><ul class="pf-legend">${legend}</ul></figure>`;
}
