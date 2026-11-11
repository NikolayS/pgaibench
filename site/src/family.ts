// Vendor family of a configuration, from models.json fields `open_weights` and `vendor` (the harness schema
// takes no extra keys), and its point shape in scatter plots.
// Shape carries the meaning alone; a colour per family (CSS variables --fam-*) is added on top.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond' | 'triangle-down';
export const FAMILIES: Record<string, { shape: Shape; label: string }> = {
  anthropic: { shape: 'circle', label: 'Anthropic' },
  openai: { shape: 'square', label: 'OpenAI' },
  google: { shape: 'triangle', label: 'Google' },
  open: { shape: 'diamond', label: 'open-weight' },
  other: { shape: 'triangle-down', label: 'other' },
};

const VENDOR: Record<string, string> = { Anthropic: 'anthropic', OpenAI: 'openai', Google: 'google' };
export const familyFrom = (m: { vendor: string; open_weights: boolean }) => (m.open_weights ? 'open' : VENDOR[m.vendor] ?? 'other');
let cache: Map<string, string> | null = null;
export function familyOf(modelId: string): string {
  if (!cache) {
    const m = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'models.json'), 'utf8')) as { id: string; vendor: string; open_weights: boolean }[];
    cache = new Map(m.map(x => [x.id, familyFrom(x)]));
  }
  return cache.get(modelId) ?? 'other';
}

// Equal area: a circle of radius R; square side, diamond and equilateral triangle sized to the same area.
const R = 5.5, AREA = Math.PI * R * R;
const SQ = Math.sqrt(AREA) / 2; // half side
const TA = Math.sqrt((4 * AREA) / Math.sqrt(3)), TH = (TA * Math.sqrt(3)) / 2; // side, height
export const SHAPE_HALF = 8; // the largest extent from the centre (triangle apex 2/3 of its height), rounded up
const r1 = (v: number) => String(Math.round(v * 10) / 10);
export function shapeArea(s: Shape): number {
  if (s === 'circle') return AREA;
  if (s === 'square' || s === 'diamond') return (2 * SQ) ** 2;
  return (TA * TH) / 2;
}
export function shapeSvg(s: Shape, cx: number, cy: number, cls: string): string {
  if (s === 'circle') return `<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${R}"/>`;
  if (s === 'square') return `<rect class="${cls}" x="${r1(cx - SQ)}" y="${r1(cy - SQ)}" width="${r1(2 * SQ)}" height="${r1(2 * SQ)}"/>`;
  if (s === 'diamond') { const d = SQ * Math.SQRT2; return `<path class="${cls}" d="M${r1(cx)} ${r1(cy - d)}L${r1(cx + d)} ${r1(cy)}L${r1(cx)} ${r1(cy + d)}L${r1(cx - d)} ${r1(cy)}Z"/>`; }
  const up = s === 'triangle' ? 1 : -1, apex = cy - up * (2 * TH) / 3, base = cy + up * TH / 3;
  return `<path class="${cls}" d="M${r1(cx)} ${r1(apex)}L${r1(cx + TA / 2)} ${r1(base)}L${r1(cx - TA / 2)} ${r1(base)}Z"/>`;
}
/** Inline SVG swatch for HTML (legend, key): the same shape and colour class as the plot. */
export function swatch(family: string | 'baseline'): string {
  const inner = family === 'baseline' ? `<circle class="q-base" cx="9" cy="9" r="${R}"/>` : shapeSvg((FAMILIES[family] ?? FAMILIES.other!).shape, 9, 9.5, `q-pt q-f-${family}`);
  return `<svg class="fsw fsw-${family}" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">${inner}</svg>`;
}
export function familyLegend(families: string[], baselines: boolean): string {
  const order = Object.keys(FAMILIES).filter(f => families.includes(f));
  const items = order.map(f => `<span class="qleg">${swatch(f)} ${FAMILIES[f]!.label}</span>`);
  if (baselines) items.push(`<span class="qleg">${swatch('baseline')} baseline</span>`);
  return `<p class="qlegend">${items.join(' ')}</p>`;
}
