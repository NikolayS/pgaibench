// The main chart of home and results. Vertical: tasks done, 0 to the task count, up is better. Horizontal:
// dangerous changes per run, 0 at the left. Both linear from 0, one unbroken scale each.
// Rows with 0 dangerous changes sit on the vertical axis, named in the left margin like a ranked list.
// The horizontal axis runs to the largest value rounded up to an even number: every row is an ordinary point.
// Vendor: colour and shape. Effort: fill. Intervals show on hover, tap or focus (CSS only); <title> per point.
import { esc } from './html';
import type { Pooled } from './pooled';
import { baseName, effortGroup, effortOf, pathWord } from './svg';
import { familyOf } from './family';
import { plottedRows, provisionalRows } from './safety';

export type CRow = { id: string; name: string; effort: string; family: string; done: number; dangerous: number; lo: number | null; hi: number | null; ranked: boolean };
type Box = { x0: number; y0: number; x1: number; y1: number };
const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const n1 = (v: number) => String(Math.round(v * 10) / 10);
const num = (v: number) => String(Math.round(v * 10) / 10);
const bx = (b: Box) => `${n1(b.x0)} ${n1(b.y0)} ${n1(b.x1)} ${n1(b.y1)}`;
/** Monospace advance per em: the site uses one monospace stack. */
const CH = 0.6;
const tw = (s: string, fs: number) => s.length * fs * CH;

// ---------- data ----------
/** One row per configuration: the rows with a place, then the shown rows without one (read, not excluded). */
export function chartRows(p: Pooled): CRow[] {
  const ci = (r: { twoLevel?: { doneLo: number; doneHi: number } | null; taskOnly?: { doneLo: number; doneHi: number } | null }) => r.twoLevel ?? r.taskOnly ?? null;
  const row = (id: string, done: number, dangerous: number, iv: { doneLo: number; doneHi: number } | null, ranked: boolean): CRow =>
    ({ id, name: `${baseName(id)}${pathWord(id)}`, effort: effortGroup(effortOf(id)), family: familyOf(id), done, dangerous, lo: iv?.doneLo ?? null, hi: iv?.doneHi ?? null, ranked });
  const seen = new Set(p.rows.map(r => r.id));
  return [...p.rows.filter(r => r.included).map(r => row(r.id, r.done, r.dangerous, ci(r), r.place != null)),
    ...plottedRows(provisionalRows(p)).filter(x => !seen.has(x.id)).map(x => row(x.id, x.done, x.dangerous, ci(x as never), false))];
}

/** Horizontal axis end: the largest value rounded up to an even number, at least 2. */
export function axisMax(ds: number[]): number {
  const top = Math.max(0, ...ds);
  return Math.max(2, Math.ceil(top / 2 - 1e-9) * 2);
}

// ---------- colours (verified in the tests: WCAG contrast on the page background) ----------
export const MC_COLORS = {
  light: { anthropic: '#b4512c', openai: '#0b7d62', google: '#2563d6', open: '#7c3f98', other: '#141414' },
  dark: { anthropic: '#e8906c', openai: '#3dc79e', google: '#7baaf7', open: '#cf9fe6', other: '#e6e6e1' },
};
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

// ---------- marks ----------
const VENDOR_LABEL: Record<string, string> = { anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', open: 'open weights', other: 'other' };
const SHAPE: Record<string, string> = { anthropic: 'circle', google: 'triangle', openai: 'square', open: 'diamond', other: 'triangle-down' };
const EFFORT_RANK = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'provider default', 'no thinking'];
type Fill = 'full' | 'none' | 'dot' | 'bar' | 'half';
const fillOf = (e: string): Fill => (['max', 'xhigh', 'high'].includes(e) ? 'full' : e === 'provider default' ? 'dot' : e === 'no thinking' ? 'bar' : 'none');
function shapePath(fam: string, cx: number, cy: number, r: number): string {
  const s = SHAPE[fam] ?? 'circle';
  if (s === 'circle') return `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}"`;
  if (s === 'square') { const h = r * 0.89; return `<rect x="${n1(cx - h)}" y="${n1(cy - h)}" width="${n1(2 * h)}" height="${n1(2 * h)}"`; }
  if (s === 'diamond') { const d = r * 1.25; return `<path d="M${n1(cx)} ${n1(cy - d)}L${n1(cx + d)} ${n1(cy)}L${n1(cx)} ${n1(cy + d)}L${n1(cx - d)} ${n1(cy)}Z"`; }
  const u = s === 'triangle' ? 1 : -1;
  return `<path d="M${n1(cx)} ${n1(cy - u * r * 1.2)}L${n1(cx + r * 1.15)} ${n1(cy + u * r * 0.75)}L${n1(cx - r * 1.15)} ${n1(cy + u * r * 0.75)}Z"`;
}
/** A mark: shape by vendor, fill by effort. `uid` names the clip path of a half-filled mark. */
export function markSvg(fam: string, fill: Fill, cx: number, cy: number, r: number, uid: string): string {
  const c = `mc-v-${SHAPE[fam] ? fam : 'other'}`;
  let s = `${shapePath(fam, cx, cy, r)} class="mc-m ${c}${fill === 'full' ? ' mc-full' : ''}"/>`;
  const dy = fam === 'google' ? r * 0.2 : 0;
  if (fill === 'dot') s += `<circle class="mc-in ${c}" cx="${n1(cx)}" cy="${n1(cy + dy)}" r="${n1(r * 0.32)}"/>`;
  if (fill === 'bar') s += `<rect class="mc-in ${c}" x="${n1(cx - r * 0.55)}" y="${n1(cy + dy - 0.9)}" width="${n1(r * 1.1)}" height="1.8"/>`;
  if (fill === 'half') s += `<clipPath id="${uid}"><rect x="${n1(cx - r * 2)}" y="${n1(cy - r * 2)}" width="${n1(r * 2)}" height="${n1(r * 4)}"/></clipPath>${shapePath(fam, cx, cy, r)} class="mc-m mc-full mc-half ${c}" clip-path="url(#${uid})"/>`;
  return s;
}

// ---------- layout helpers ----------
type Pt = { rows: CRow[]; name: string; eff: string; family: string; fill: Fill; done: number; d: number; ranked: boolean };
const same = (a: CRow, b: CRow) => Math.abs(a.done - b.done) < 0.05 && Math.abs(a.dangerous - b.dangerous) < 0.05;
function points(rows: CRow[]): Pt[] {
  const out: Pt[] = [], used = new Set<CRow>();
  for (const r of rows) {
    if (used.has(r)) continue;
    const twin = rows.find(q => q !== r && !used.has(q) && q.name === r.name && q.effort !== r.effort && same(q, r));
    const grp = twin ? [r, twin].sort((a, b) => EFFORT_RANK.indexOf(a.effort) - EFFORT_RANK.indexOf(b.effort)) : [r];
    grp.forEach(g => used.add(g));
    out.push({ rows: grp, name: r.name, eff: grp.map(g => g.effort).join(' = '), family: r.family, fill: twin ? 'half' : fillOf(r.effort), done: r.done, d: r.dangerous, ranked: grp.some(g => g.ranked) });
  }
  return out;
}
/** 1-D spacing: labels sorted by wanted baseline, each at least its height below the one above; least squares
 *  shift inside each touching block (pool adjacent violators); never above `minY`. */
export function spaceLabels(want: number[], heights: number[], minY: number): number[] {
  const idx = want.map((_, i) => i).sort((a, b) => want[a]! - want[b]!);
  type Blk = { items: number[]; start: number; h: number };
  const blocks: Blk[] = [];
  for (const i of idx) {
    let b: Blk = { items: [i], start: want[i]!, h: heights[i]! };
    while (blocks.length) {
      const p = blocks[blocks.length - 1]!;
      if (p.start + p.h <= b.start) break;
      blocks.pop();
      const items = [...p.items, ...b.items];
      let off = 0, sum = 0;
      for (const k of items) { sum += want[k]! - off; off += heights[k]!; }
      b = { items, start: sum / items.length, h: off };
    }
    blocks.push(b);
  }
  const out = new Array<number>(want.length);
  let floor = minY;
  for (const b of blocks) {
    let y = Math.max(b.start, floor);
    for (const k of b.items) { out[k] = y; y += heights[k]!; }
    floor = y;
  }
  return out;
}

type Cand = { x: number; y: number; a: 'start' | 'end' | 'middle'; lines: 1 | 2; box: Box; lead: boolean; dist: number };
/** A label to place: anchor point (a mark, or the middle of a join line), its own marks, one-line width and two-line widths. */
type Item = { cx: number; cy: number; r: number; own: { cx: number; cy: number }[]; w1: number; w2: [number, number] | null };
type Opt = { fs: number; frame: Box; block: Box[]; reach: number };
/** Greedy placement in many orders (crowded points first, then seeded shuffles); the order with the least total cost wins. */
function placeOff(items: Item[], o: Opt): (Cand | null)[] {
  const crowd = (i: number) => items.filter(q => Math.abs(q.cx - items[i]!.cx) < 80 && Math.abs(q.cy - items[i]!.cy) < 30).length;
  const first = items.map((_, i) => i).sort((a, b) => crowd(b) - crowd(a) || items[a]!.cy - items[b]!.cy);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let best = placeOrder(items, o, first);
  for (let t = 0; t < 300; t++) {
    const ord = [...first];
    for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j]!, ord[i]!]; }
    const r = placeOrder(items, o, ord);
    if (r.cost < best.cost) best = r;
  }
  return best.res;
}
const gap = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
function placeOrder(items: Item[], o: Opt, order: number[]): { res: (Cand | null)[]; cost: number } {
  const { fs, frame } = o, lh = fs + 2, taken: Box[] = [...o.block];
  const res: (Cand | null)[] = new Array(items.length).fill(null);
  let total = 0;
  // leaders already drawn: no later label may cover one, and no leader may run through a box
  const leads: [number, number, number, number][] = [];
  const leadOf = (box: Box, p: Item): [number, number, number, number] => {
    const src = [{ cx: p.cx, cy: p.cy }, ...p.own].sort((a, b) => gap(box, a.cx, a.cy) - gap(box, b.cx, b.cy))[0]!;
    return [src.cx, src.cy, Math.min(Math.max(src.cx, box.x0 - 1), box.x1 + 1), Math.min(Math.max(src.cy, box.y0), box.y1)];
  };
  const through = (l: [number, number, number, number], b: Box, skip: number) => {
    const L = Math.hypot(l[2] - l[0], l[3] - l[1]);
    for (let t = skip; t <= L - 3; t += 1) { const x = l[0] + ((l[2] - l[0]) * t) / L, y = l[1] + ((l[3] - l[1]) * t) / L; if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return true; }
    return false;
  };
  const inside = (b: Box) => b.x0 >= frame.x0 && b.x1 <= frame.x1 && b.y0 >= frame.y0 && b.y1 <= frame.y1;
  for (const i of order) {
    const p = items[i]!;
    let best: { c: Cand; cost: number } | null = null;
    for (let d = 0; d <= o.reach + 16; d += 2) {
      for (const lines of (p.w2 ? [1, 2] : [1]) as (1 | 2)[]) {
        const w = lines === 1 ? p.w1 : Math.max(...p.w2!), h = (lines - 1) * lh;
        const g = p.r + 3 + d;
        const cands: [number, number, Cand['a']][] = [
          [p.cx + g, p.cy + fs * 0.35 - h / 2, 'start'], [p.cx - g, p.cy + fs * 0.35 - h / 2, 'end'],
          [p.cx, p.cy - g - h - 1, 'middle'], [p.cx, p.cy + g + fs * 0.75, 'middle'],
          [p.cx + g * 0.7, p.cy - g * 0.7 - h, 'start'], [p.cx - g * 0.7, p.cy - g * 0.7 - h, 'end'],
          [p.cx + g * 0.7, p.cy + g * 0.7 + fs * 0.6, 'start'], [p.cx - g * 0.7, p.cy + g * 0.7 + fs * 0.6, 'end'],
          ...[-0.5, 0.5].flatMap(k => [[p.cx + k * 40, p.cy - g - h - 1, 'middle'], [p.cx + k * 40, p.cy + g + fs * 0.75, 'middle']] as [number, number, Cand['a']][])];
        for (const [x, y, a] of cands) {
          const x0 = a === 'start' ? x : a === 'end' ? x - w : x - w / 2;
          const box = { x0, x1: x0 + w, y0: y - fs * 0.8, y1: y + h + fs * 0.25 };
          if (!inside(box) || taken.some(t => hit(t, box)) || leads.some(l => through(l, box, 0))) continue;
          // distance from the nearest own mark (or the anchor) to the nearest point of the label
          const dist = Math.min(gap(box, p.cx, p.cy), ...p.own.map(m => gap(box, m.cx, m.cy)));
          if (dist > o.reach) continue;
          if (dist > p.r + 6) { const l = leadOf(box, p); if (taken.slice(o.block.length).some(t => through(l, t, p.r + 4))) continue; }
          // a label nearer to another mark than to its own reads as that mark's label
          const near = items.some((q, k) => k !== i && q.own.some(m => gap(box, m.cx, m.cy) < dist - 2));
          const cost = dist * 10 + (near ? 500 : 0) + (lines - 1) * 45 + (a === 'start' ? 0 : a === 'end' ? 4 : 8);
          if (!best || cost < best.cost) best = { c: { x, y, a, lines, box, lead: dist > p.r + 6, dist }, cost };
        }
      }
      if (best && best.cost <= (p.r + 3 + d) * 10) break;
    }
    if (best) { res[i] = best.c; total += best.cost; if (best.c.lead) leads.push(leadOf(best.c.box, p)); taken.push({ x0: best.c.box.x0 - fs, y0: best.c.box.y0 - 1, x1: best.c.box.x1 + fs, y1: best.c.box.y1 + 1 }); } else total += 1e6;
  }
  return { res, cost: total };
}

// ---------- the chart ----------
const HM = new Set(['high', 'medium']);
export function mainChartSvg(rows: CRow[], o: { id: string; width: number; tasks: number }): string {
  const W = o.width, phone = W < 500, n = o.tasks;
  const fs = phone ? 11.5 : 13, tfs = phone ? 11 : 12, lh = fs + 2, U = phone ? 21 : 26, TOP = phone ? 26 : 16, RM = phone ? 8 : 12, r = phone ? 5.5 : 8;
  const xMax = axisMax(rows.map(x => x.dangerous));
  const pts = points(rows);
  const zero = pts.filter(p => p.d === 0), off = pts.filter(p => p.d > 0);
  const byName = new Map<string, Pt[]>();
  for (const p of pts) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  // a model with rows both on the zero line and off it: every row labelled on its own, with its effort word
  const split = (p: Pt) => { const ps = byName.get(p.name)!; return ps.some(q => q.d === 0) && ps.some(q => q.d > 0); };
  // margin groups: one line per model on the zero line, effort words in top-to-bottom order of the marks
  type MG = { name: string; pts: Pt[]; words: string; ranked: boolean };
  const groups: MG[] = [];
  for (const p of [...zero].sort((a, b) => b.done - a.done)) {
    const g = split(p) ? undefined : groups.find(x => x.name === p.name && !split(x.pts[0]!));
    if (g) g.pts.push(p); else groups.push({ name: p.name, pts: [p], words: '', ranked: false });
  }
  for (const g of groups) { g.words = phone && !split(g.pts[0]!) ? '' : g.pts.map(p => p.eff).join(' · '); g.ranked = g.pts.some(p => p.ranked); }
  const gfull = (g: MG) => g.words ? `${g.name} ${g.words}` : g.name;
  // left margin: desktop fits the longest full line; phone fits the longest name, the effort words go on a second line
  const cap = Math.max(...groups.map(g => tw(phone ? g.name : gfull(g), fs)), 40);
  const tickW = tw(String(n), tfs) + r + 8, YT = phone ? 0 : fs + 10, NX = Math.round(YT + 8 + cap), LM = NX + 8 + tickW, PW = W - LM - RM, PH = n * U;
  const X = (v: number) => LM + (Math.min(v, xMax) / xMax) * PW, Y = (v: number) => TOP + (n - v) * U, Y0 = Y(0);
  const out: string[] = [], labels: string[] = [], lboxes: Box[] = [], mboxes: Box[] = [];
  const lbox = (b: Box) => { lboxes.push(b); return ` data-lbox="${bx(b)}"`; };
  // grid, ticks, axes
  const step = xMax <= 2 ? 0.5 : xMax <= 10 && !phone ? 1 : 2;
  const xt = Array.from({ length: Math.round(xMax / step) + 1 }, (_, i) => i * step);
  const yt = [...new Set([0, ...Array.from({ length: Math.floor(n / 5) + 1 }, (_, i) => i * 5).filter(t => n - t >= 3), n])];
  for (const t of xt) {
    if (t) out.push(`<line class="mc-grid" x1="${n1(X(t))}" y1="${TOP}" x2="${n1(X(t))}" y2="${Y0}"/>`);
    for (const ty of [Y0 + tfs + 5]) { const w = tw(num(t), tfs); labels.push(`<text class="mc-tick" x="${n1(X(t))}" y="${n1(ty)}" text-anchor="middle"${ty > TOP ? ` data-xtick="${t} ${n1(X(t))}"` : ''}${lbox({ x0: X(t) - w / 2, y0: ty - tfs * 0.8, x1: X(t) + w / 2, y1: ty + tfs * 0.25 })}>${num(t)}</text>`); }
  }
  for (const t of yt) {
    if (t) out.push(`<line class="mc-grid" x1="${LM}" y1="${n1(Y(t))}" x2="${LM + PW}" y2="${n1(Y(t))}"/>`);
    const x = LM - r - 4, y = Y(t) + tfs * 0.35;
    labels.push(`<text class="mc-tick" x="${x}" y="${n1(y)}" text-anchor="end" data-ytick="${t} ${n1(Y(t))}"${lbox({ x0: x - tw(String(t), tfs), y0: y - tfs * 0.8, x1: x, y1: y + tfs * 0.25 })}>${t}</text>`);
  }
  out.push(`<line class="mc-axis" x1="${LM}" y1="${TOP}" x2="${LM}" y2="${Y0}"/><line class="mc-axis" x1="${LM}" y1="${Y0}" x2="${LM + PW}" y2="${Y0}"/>`);
  // axis titles, in the usual places: the horizontal one centred under its tick numbers; the vertical one
  // rotated at the far left on desktop (the one rotated text), a short title over the axis top on a phone
  const ta = phone ? 'tasks done' : `tasks done, of ${n}`, tb = 'dangerous changes per run', tby = Y0 + tfs + 5 + fs + 8;
  if (phone) {
    const tax = Math.max(2, LM - tw(ta, fs)), tay = TOP - 12;
    labels.push(`<text class="mc-atitle" x="${n1(tax)}" y="${tay}"${lbox({ x0: tax, y0: tay - fs * 0.8, x1: tax + tw(ta, fs), y1: tay + fs * 0.25 })}>${ta}</text>`);
  } else {
    const cy = (TOP + Y0) / 2, x = fs, w = tw(ta, fs);
    labels.push(`<text class="mc-atitle mc-ytitle" x="${x}" y="${n1(cy)}" text-anchor="middle" transform="rotate(-90 ${x} ${n1(cy)})"${lbox({ x0: x - fs * 0.8, y0: cy - w / 2, x1: x + fs * 0.25, y1: cy + w / 2 })}>${ta}</text>`);
  }
  const tbx = Math.min(Math.max(LM + PW / 2 - tw(tb, fs) / 2, LM), W - 2 - tw(tb, fs));
  labels.push(`<text class="mc-atitle" x="${n1(tbx)}" y="${tby}"${lbox({ x0: tbx, y0: tby - fs * 0.8, x1: tbx + tw(tb, fs), y1: tby + fs * 0.25 })}>${tb}</text>`);

  // marks, with the interval of each row (shown on hover, tap or focus) and a title
  const at = new Map<Pt, { cx: number; cy: number }>();
  for (const p of [...zero, ...off]) at.set(p, { cx: X(p.d), cy: Y(p.done) });
  // joins between the levels of one model
  const joinBoxes: Box[] = [];
  const pairs: { name: string; pts: Pt[] }[] = [];
  for (const [name, ps] of byName) if (ps.length > 1) {
    const s = [...ps].sort((a, b) => EFFORT_RANK.indexOf(a.rows[0]!.effort) - EFFORT_RANK.indexOf(b.rows[0]!.effort));
    for (let j = 1; j < s.length; j++) {
      const a = at.get(s[j - 1]!)!, b = at.get(s[j]!)!, jb = { x0: Math.min(a.cx, b.cx) - 1.5, y0: Math.min(a.cy, b.cy) - 1.5, x1: Math.max(a.cx, b.cx) + 1.5, y1: Math.max(a.cy, b.cy) + 1.5 };
      joinBoxes.push(jb); out.push(`<g data-jbox="${bx(jb)}"/>`);
    }
    out.push(`<polyline class="mc-join mc-v-${SHAPE[s[0]!.family] ? s[0]!.family : 'other'}" points="${s.map(p => { const c = at.get(p)!; return `${n1(c.cx)},${n1(c.cy)}`; }).join(' ')}"/>`);
    if (s.every(p => off.includes(p))) pairs.push({ name, pts: s });
  }
  const iv = (x: CRow) => (x.lo != null && x.hi != null ? `${num(x.lo)} to ${num(x.hi)}` : '');
  const per = (d: number) => `${num(d)} dangerous ${num(d) === '1' ? 'change' : 'changes'} per run`;
  const title = (p: Pt) => {
    const x = p.rows[0]!, ivs = p.rows.length > 1 ? p.rows.filter(iv).map(q => `${q.effort} ${iv(q)}`).join(', ') : iv(x);
    return `${p.name}, ${p.rows.length > 1 ? `${p.rows.map(q => q.effort).join(' and ')} (same result)` : p.eff}: ${num(x.done)} of ${n} tasks done${ivs ? ` (95% interval ${ivs})` : ''}, ${per(p.d)}${p.ranked ? '' : ', no place'}`;
  };
  // later rows first, so the higher rows are drawn on top where marks overlap
  const order = [...pts].sort((a, b) => a.done - b.done || b.d - a.d);
  for (const p of pts) {
    const { cx, cy } = at.get(p)!;
    mboxes.push({ x0: cx - r - 1, y0: cy - r - 1.5, x1: cx + r + 1, y1: cy + r + 1.5 });
  }
  for (const p of order) {
    const { cx, cy } = at.get(p)!, k = pts.indexOf(p);
    const ci = p.rows.map((x, j) => {
      if (x.lo == null || x.hi == null) return '';
      const xx = cx + (p.rows.length > 1 ? (j ? 2.5 : -2.5) : 0), y1 = Y(x.hi), y2 = Y(x.lo);
      const d = `M${n1(xx)} ${n1(y1)}V${n1(y2)}M${n1(xx - 5)} ${n1(y1)}h10M${n1(xx - 5)} ${n1(y2)}h10`;
      return `<g class="mc-ci"><path class="mc-ci-h" d="${d}"/><path class="mc-ci-l mc-v-${SHAPE[p.family] ? p.family : 'other'}" d="${d}"/></g>`;
    }).join('');
    const mk = markSvg(p.family, p.fill, cx, cy, r, `${o.id}-${W}-h${k}`);
    out.push(`<g class="mc-pt" tabindex="0"><title>${esc(title(p))}</title>${ci}${mk}</g>`);
  }
  for (const b of mboxes) out.push(`<g data-mbox="${bx(b)}"/>`);

  // names on the vertical axis: left margin, one line per model (two on a phone), spaced in one dimension
  const two = (g: MG) => phone && tw(gfull(g), fs) > cap + 0.5;
  const tgt = groups.map(g => g.pts.reduce((t, p) => t + Y(p.done), 0) / g.pts.length);
  const want = groups.map((g, i) => tgt[i]! + fs * 0.35 - (two(g) ? lh / 2 : 0));
  const ys = spaceLabels(want, groups.map(g => (two(g) ? 2 : 1) * lh), TOP - 6 + fs * 0.8);
  const zx = NX;
  const nameT = (s: string) => `<tspan class="mc-nm">${esc(s)}</tspan>`;
  const effT = (s: string) => `<tspan class="mc-eff">${esc(s)}</tspan>`;
  groups.forEach((g, i) => {
    const y = ys[i]!, t2 = two(g), w = t2 ? Math.max(tw(g.name, fs), tw(g.words, fs)) : tw(gfull(g), fs);
    const box = { x0: zx - w, y0: y - fs * 0.8, x1: zx, y1: y + (t2 ? lh : 0) + fs * 0.25 };
    const mid = y + (t2 ? lh / 2 : 0) - fs * 0.35;
    // leaders only where the name moved away from its marks
    // on a phone a short stub toward the height of the marks, so it stays clear of the tick numbers
    if (Math.abs(mid - tgt[i]!) > 6) for (const p of g.pts) out.push(`<line class="mc-lead" x1="${zx + 2}" y1="${n1(mid)}" x2="${n1(phone ? zx + 8 : LM - r - 2)}" y2="${n1(phone ? mid + Math.max(-9, Math.min(9, Y(p.done) - mid)) : Y(p.done))}"/>`);
    labels.push(`<text class="mc-mlab${g.ranked ? '' : ' mc-noplace'}" x="${zx}" y="${n1(y)}" text-anchor="end" data-dy="${n1(mid - tgt[i]!)}"${lbox(box)}>${t2 ? `${nameT(g.name)}<tspan class="mc-eff" x="${zx}" dy="${lh}">${esc(g.words)}</tspan>` : `${nameT(g.name)} ${effT(g.words)}`}</text>`);
  });

  // other rows: one name per joined pair beside its join line; a single row says its effort only when the fill does not
  type L = { cls: string; name: string; word: string; item: Item };
  const L: L[] = [];
  const inPair = new Set(pairs.flatMap(x => x.pts));
  for (const pr of pairs) {
    const a = at.get(pr.pts[0]!)!, b = at.get(pr.pts[pr.pts.length - 1]!)!;
    L.push({ cls: `mc-lab${pr.pts.some(p => p.ranked) ? '' : ' mc-noplace'}`, name: pr.name, word: '', item: { cx: a.cx, cy: a.cy, r: r + 1, own: pr.pts.map(p => at.get(p)!), w1: tw(pr.name, fs), w2: null } });
  }
  for (const p of off.filter(q => !inPair.has(q))) {
    const word = split(p) ? p.eff : phone ? '' : !(p.fill === 'half' || HM.has(p.eff)) ? p.eff : '';
    const c = at.get(p)!;
    L.push({ cls: `mc-lab${p.ranked ? '' : ' mc-noplace'}`, name: p.name, word, item: { cx: c.cx, cy: c.cy, r: r + 1, own: [c], w1: tw(word ? `${p.name} ${word}` : p.name, fs), w2: word ? [tw(p.name, fs), tw(word, fs)] : null } });
  }
  const frame = { x0: LM + 3, y0: TOP - 4, x1: W - 0.5, y1: Y0 - 3 };
  const axisBox = { x0: LM - 2, y0: TOP - 4, x1: LM + 2, y1: Y0 };
  // short leaders first; only when a label has no place at all, a longer reach
  const block = [...mboxes, ...joinBoxes, axisBox, ...lboxes.map(b => ({ x0: b.x0 - 3, y0: b.y0, x1: b.x1 + 3, y1: b.y1 }))];
  let placed: (Cand | null)[] = [];
  for (const reach of phone ? [12, 24, 40, 80, 140] : [46, 80, 140]) { placed = placeOff(L.map(l => l.item), { fs, frame, block, reach }); if (placed.every(Boolean)) break; }
  L.forEach((l, i) => {
    const c = placed[i], { cx, cy } = l.item;
    if (!c) throw new Error(`main chart: no place for the label of ${l.name}`);
    if (c.lead) {
      // the leader runs from the nearest own mark (or the anchor) to the label
      const src = [{ cx, cy }, ...l.item.own].sort((a, b) => gap(c.box, a.cx, a.cy) - gap(c.box, b.cx, b.cy))[0]!;
      const ex = Math.min(Math.max(src.cx, c.box.x0 - 1), c.box.x1 + 1), ey = Math.min(Math.max(src.cy, c.box.y0), c.box.y1);
      out.push(`<line class="mc-lead" x1="${n1(src.cx)}" y1="${n1(src.cy)}" x2="${n1(ex)}" y2="${n1(ey)}"/>`);
    }
    const body = c.lines === 1 ? `${nameT(l.name)}${l.word ? ` ${effT(l.word)}` : ''}` : `${nameT(l.name)}<tspan class="mc-eff" x="${n1(c.x)}" dy="${lh}">${esc(l.word)}</tspan>`;
    labels.push(`<text class="${l.cls}" x="${n1(c.x)}" y="${n1(c.y)}" text-anchor="${c.a}"${lbox(c.box)}>${body}</text>`);
  });

  let H = Y0 + tfs + 5 + fs + 14;
  H = Math.ceil(H);
  const nz = rows.filter(x => x.dangerous === 0).length;
  const aria = `Tasks done (up, 0 to ${n}) against dangerous changes per run (right, 0 to ${xMax}), one point per configuration, each named. ${nz} of ${rows.length} configurations wrote no dangerous change.`;
  // the top layer: assets/plot.js copies the interval of the point in focus here, above every mark
  return `<svg class="mc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" data-chart="${esc(o.id)}" data-xmin="0" data-xmax="${xMax}" data-ymin="0" data-ymax="${n}" data-plot-h="${PH}" data-axis-x="${LM}" data-plot-top="${TOP}" data-plot-y0="${Y0}" font-family="inherit" font-size="${fs}" preserveAspectRatio="xMinYMin meet"><desc>Scatter plot. Vertical: tasks done, linear from 0 to ${n}. Horizontal: dangerous changes per run, linear from 0 to ${xMax}.</desc>${out.join('')}${labels.join('')}<g class="mc-top"></g></svg>`;
}

// ---------- figure ----------
const sw = (fam: string, fill: Fill, uid: string) => `<svg class="mc-sw" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">${markSvg(fam, fill, 9, 9.5, 5.5, uid)}</svg>`;
export function mainChartFigure(rows: CRow[], o: { id: string; tasks: number; words: string }): string {
  const wide = mainChartSvg(rows, { id: o.id, width: 1400, tasks: o.tasks }).replace('<svg class="mc"', '<svg class="mc mc-wide"');
  const narrow = mainChartSvg(rows, { id: o.id, width: 340, tasks: o.tasks }).replace('<svg class="mc"', '<svg class="mc mc-narrow"');
  const fams = Object.keys(VENDOR_LABEL).filter(f => rows.some(r => r.family === f)).sort((a, b) => Number(a === 'open') - Number(b === 'open') || Number(a === 'other') - Number(b === 'other') || VENDOR_LABEL[a]!.localeCompare(VENDOR_LABEL[b]!));
  const pts = points(rows);
  const effs = (['full', 'none', 'dot', 'bar'] as Fill[]).filter(f => pts.some(p => p.fill === f));
  const EW: Record<Fill, string> = { full: 'high', none: 'medium', dot: 'provider default', bar: 'no thinking', half: '' };
  const it = (s: string, l: string) => `<span class="mc-li">${s} ${esc(l)}</span>`;
  const noPlace = rows.some(r => !r.ranked) ? ' Italic: no place.' : '';
  const half = pts.some(p => p.fill === 'half') ? ` ${it(sw('neutral', 'half', `${o.id}-lg-half`), 'high = medium.')}` : '';
  return `<figure class="svg-chart mc-fig" id="${esc(o.id)}">${narrow}${wide}`
    + `<p class="mc-leg"><span class="dim">vendor</span> ${fams.map(f => it(sw(f, 'full', ''), VENDOR_LABEL[f]!)).join(' ')}</p>`
    + `<p class="mc-leg"><span class="dim">effort</span> ${effs.map(f => it(sw('neutral', f, `${o.id}-lg-${f}`), EW[f])).join(' ')}${half}</p>`
    + `<p class="mc-leg dim"><span><a href="${o.words}">tasks done</a> · <a href="${o.words}">dangerous changes</a>.${noPlace} Tap a point for its 95% interval.</span></p></figure>`;
}
