// Bar cells for the text charts. A bar is a string of ASCII codes, one code
// per cell. In HTML each run of a code becomes a <span> of spaces with a CSS
// pattern class, so the browser never has to draw a block or shade glyph and
// every cell keeps the width of one space. The .txt twin turns the spans back
// into the ASCII codes.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ASCII code -> CSS pattern name. Distinct patterns, so colour is never needed. */
export const PATTERN: Record<string, string> = {
  '#': 'solid', '=': 'hatch', '-': 'dots', '%': 'cross', '\\': 'back', '~': 'horiz', '!': 'check',
  '?': 'vert', x: 'grid', _: 'under', ',': 'sparse', ':': 'vdots', '.': 'empty', '$': 'ring', '^': 'diamond',
};
const CODE: Record<string, string> = Object.fromEntries(Object.entries(PATTERN).map(([c, n]) => [n, c]));

/** HTML of a bar: runs of pattern codes as spans of spaces; any other character (space, '|') as text. */
export function barHtml(codes: string): string {
  let out = '';
  for (const m of codes.matchAll(/(.)\1*/gs)) {
    const run = m[0], c = m[1]!;
    out += PATTERN[c] ? `<span class="bx bx-${PATTERN[c]}">${' '.repeat(run.length)}</span>` : esc(run);
  }
  return out;
}

/** One legend swatch: the code between bars, drawn as the same pattern. */
export const swatch = (code: string, cells = 2) => `|${barHtml(code.repeat(cells))}|`;

/** Plain text of chart HTML: pattern spans back to their ASCII codes. */
export const barsToText = (html: string) => html.replace(/<span class="bx bx-([a-z]+)">( *)<\/span>/g, (_, n: string, s: string) => (CODE[n] ?? ' ').repeat(s.length));

/** Escaped chart text: every |...| run of exactly `width` cells becomes a bar of pattern spans. */
export const spanBars = (escaped: string, width: number) =>
  escaped.replace(new RegExp(`\\|([^|\\n<>]{${width}})\\|`, 'g'), (_, c: string) => `|${barHtml(c)}|`);

/** Fluid bar for narrow screens: the same cells as a bar string, drawn as pattern blocks placed in percent of the
 *  available width (linear, same rounding as the wide chart). `zero`: the cell index of the zero line, if any. */
export function fluidBar(codes: string, zero?: number): string {
  const n = codes.length, pc = (i: number) => +(i / n * 100).toFixed(3);
  let out = '', i = 0;
  for (const m of codes.matchAll(/(.)\1*/gs)) {
    const c = m[1]!, len = m[0].length;
    if (PATTERN[c]) out += `<span class="bx bx-${PATTERN[c]}" style="left: ${pc(i)}%; width: ${pc(len)}%"></span>`;
    i += len;
  }
  return `<span class="fb">${out}${zero === undefined ? '' : `<span class="fb-zero" style="left: ${pc(zero)}%"></span>`}</span>`;
}

/** Axis for a fluid bar: tick labels at percent positions of the same linear scale. */
export function fluidAxis(ticks: { at: number; label: string }[]): string {
  return `<span class="fb fb-axis">${ticks.map(t => `<span class="fb-tick${t.at <= 0 ? ' first' : t.at >= 100 ? ' last' : ''}" style="left: ${+t.at.toFixed(3)}%">${esc(t.label)}</span>`).join('')}</span>`;
}

/** A narrow-screen variant: shown below the breakpoint only, and never in the .txt twin. */
export const narrow = (inner: string, hidden = true) => `<!--narrow--><div class="narrow-only"${hidden ? ' aria-hidden="true"' : ''}>${inner}</div><!--/narrow-->`;
