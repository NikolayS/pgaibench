import { esc } from './html';
import { wrap } from './text';

export const svgLabel = (x: number, y: number, s: string, anchor: 'start' | 'middle' | 'end' = 'start') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`;

/** The existing word wrapper preserves whole words. Break long identifiers to fit an SVG viewport. */
export function svgLines(s: string, columns: number): string[] {
  return wrap(s.replace(/\s+/gu, ' '), columns).split('\n')
    .flatMap(line => line.match(new RegExp('.{1,' + columns + '}', 'gu')) ?? []);
}
