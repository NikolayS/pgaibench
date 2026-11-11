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
