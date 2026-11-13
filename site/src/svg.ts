// Build-time SVG charts. No script, no external files, no colour literals:
// every colour comes from CSS classes that read the theme variables
// (style.css, "SVG charts"), so light, dark and system themes work.
// Linear scale only, 0 to 100 from the left; values and intervals below 0
// are clipped at 0 with a small mark (the number is in the table).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from './html';

export type HBarRow = { label: string; value: number; lo?: number; hi?: number };
export type HBarSpec = { id: string; title: string; desc: string; aria: string; rows: HBarRow[]; baselines?: HBarRow[]; notes?: string[]; unit?: string; /** value labels with one decimal (averages) */ decimals?: 1 };

/** The model part of a name: the full name with its family word (claude-, gpt-, gemini-), no vendor
 *  or access path, no trailing date/build suffix (deepseek-v4-pro-0813 -> deepseek-v4-pro), no effort. */
export function baseName(id: string): string {
  return (id.replace(EFFORT_ARM, '').replace(LEVEL, '').replace(PATH_LEVEL, '').replace(PATH_TAG, '').split('/').pop() ?? id).replace(/-\d{4}$/, '');
}
/** An effort level of an access-path row: "google/gemini-4-carbon-high@agy" (the CLI model name carries the level). */
const PATH_LEVEL = /-(minimal|low|medium|high|xhigh|max)(?=@[a-z]+$)/;
/** A configuration that is one more effort level of a listed model (":high", or "-high@agy"). */
export const isLevelRow = (id: string) => LEVEL.test(id) || PATH_LEVEL.test(id);
/** The listed model of a row: the id without its effort level. */
export const levelBase = (id: string) => id.replace(LEVEL, '').replace(PATH_LEVEL, '');
/** An access path other than the usual one for the vendor: "google/gemini-4-carbon@agy" (Antigravity CLI). */
const PATH_TAG = /@([a-z]+)$/;
/** "@or" marks the usual router path of a model that also has an access-path row: no tag in the label. */
const pathTag = (id: string) => { const t = PATH_TAG.exec(id)?.[1]; return t === 'or' ? undefined : t; };
/** An effort arm of the pooled data: "openai/gpt-6.1-terra (effort high)". */
const EFFORT_ARM = / \(effort ([a-z]+)\)$/;
/** An effort level as its own configuration: "openai/gpt-6-astra:high" (pooled level arm ":high"). */
const LEVEL = /:([a-z]+)$/;
let EFFORTS = new Map<string, string>();
let FALLBACK: Map<string, string> | null = null;
/** The site build sets the efforts from the models table ("Models under test"), the one source. */
export function setEfforts(rows: { id: string; effort: string }[]): void { EFFORTS = new Map(rows.map(r => [r.id, r.effort || 'default'])); }
function fallback(): Map<string, string> {
  if (!FALLBACK) {
    try {
      const m = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'models.json'), 'utf8')) as { id: string; effort?: string; reasoning?: { effort?: string } | null }[];
      FALLBACK = new Map(m.map(x => [x.id, x.effort || x.reasoning?.effort || 'default'])); // router rows: the effort in the request
    } catch { FALLBACK = new Map(); }
  }
  return FALLBACK;
}
/** Reasoning effort of a configuration: the arm suffix, else the models table, else models.json; "default" when we set none. */
export function rawEffortOf(id: string): string {
  const arm = EFFORT_ARM.exec(id)?.[1] ?? LEVEL.exec(id)?.[1] ?? PATH_LEVEL.exec(id)?.[1];
  if (arm) return arm;
  return EFFORTS.get(id) ?? fallback().get(id) ?? 'default';
}
/** Rows that sent no effort setting, by what the stored answers show (reasoning tokens per answer, effort study
 *  2026-11-13): thinking on for these, none at all for deepseek-v4-pro on its pinned endpoint. */
const SERVED: Record<string, string> = {
  'google/gemini-3.8-flash': 'provider default (thinking on)', 'google/gemini-4-argon': 'provider default (thinking on)',
  'qwen/qwen3.8-27b': 'provider default (thinking on)', 'deepseek/deepseek-v4-pro-0813': 'no thinking',
};
/** The effort label of a configuration: the level we set, else what the provider default did. */
export const effortLabel = (id: string, raw: string) => (raw === 'default' || !raw ? SERVED[id] ?? 'provider default' : raw);
export function effortOf(id: string): string { return effortLabel(id, rawEffortOf(id)); }
/** Filter group of an effort label: "provider default (thinking on)" filters with "provider default". */
export const effortGroup = (e: string) => (e.startsWith('provider default') ? 'provider default' : e);
/** The one reader-facing configuration name: model and reasoning effort, "claude-fable-5.2 · high". */
export function shortName(id: string): string {
  return `${baseName(id)}${pathWord(id)} · ${effortOf(id)}`;
}
/** The access path in plain words, for a model shown through two paths: "CLI" (Antigravity CLI), "API" (router). */
const PATH_WORD: Record<string, string> = { agy: 'CLI', or: 'API' };
export const pathWord = (id: string) => { const t = PATH_TAG.exec(id)?.[1]; return t && PATH_WORD[t] ? ` ${PATH_WORD[t]}` : ''; };
/** The name as the tagged releases v0.1.0 and v0.1.1 printed it: frozen pages keep it. */
export function frozenName(id: string): string {
  const t = pathTag(id);
  return `${baseName(id)} · ${rawEffortOf(id)}${t ? ` (${t})` : ''}`;
}
export const modelLabel = shortName;
/** Chart text: the label with the effort group only ("provider default"), short enough for a chart row. */
export const chartName = (id: string) => `${baseName(id)}${pathWord(id)} · ${effortGroup(effortOf(id))}`;
/** URL path segment of a model (compare pages); unchanged so that old links keep working. A further effort level of
 *  the same model gets "-<effort>" (fable-5.2-medium); the main effort of a model keeps the bare slug. */
export function urlSlug(id: string): string {
  const arm = EFFORT_ARM.exec(id)?.[1] ?? LEVEL.exec(id)?.[1] ?? PATH_LEVEL.exec(id)?.[1];
  return baseName(id).replace(/^claude-/, '').replace(/^gemini-[\d.]+-/, '') + (arm ? `-${arm}` : '') + (pathTag(id) ? `-${pathTag(id)}` : '');
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
