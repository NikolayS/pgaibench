// Plain-text twin of a page: the same tables as aligned columns, charts
// verbatim, prose wrapped at 78 columns. No markup in the output.
import { barsToText } from './bars';
import { kvWrap } from './about';
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&middot;/g, '-').replace(/&amp;/g, '&');
const flat = (s: string) => unesc(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function wrap(s: string, width = 78, indent = ''): string {
  const out: string[] = []; let line = '';
  for (const w of s.split(' ')) {
    if (line && (line + ' ' + w).length > width - indent.length) { out.push(indent + line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

export function textTable(rows: string[][], header = true): string {
  const n = Math.max(...rows.map(r => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd();
  const out = rows.map(line);
  if (header && rows.length > 1) out.splice(1, 0, w.map(x => '-'.repeat(x)).join('  '));
  return out.join('\n');
}

export function toText(doc: string): string {
  const title = flat(/<title>([\s\S]*?)<\/title>/.exec(doc)?.[1] ?? '');
  const banner = /<p class="banner"[^>]*>([\s\S]*?)<\/p>/.exec(doc);
  const canary = /<p class="canary">([\s\S]*?)<\/p>/.exec(doc);
  // ASCII only: a configuration label "model · effort" becomes "model, effort X".
  let main = (/<main[^>]*>([\s\S]*?)<\/main>/.exec(doc)?.[1] ?? '').replace(/ · (xhigh|high|medium|low|minimal|default)\b/g, ', effort $1');
  main = main.replace(/<svg\b[\s\S]*?<\/svg>/g, '').replace(/<!--narrow-->[\s\S]*?<!--\/narrow-->/g, '').replace(/<p class="sr"[\s\S]*?<\/p>/g, '').replace(/<caption>[\s\S]*?<\/caption>/g, '');
  const blocks: string[] = [];
  const re = /<dl class="[^"]*kv-grid([^"]*)"[^>]*>([\s\S]*?)<\/dl>|<pre[^>]*>([\s\S]*?)<\/pre>|<table[^>]*>([\s\S]*?)<\/table>|<h([1-4])[^>]*>([\s\S]*?)<\/h\5>|<(p|li|dt|dd|summary|figcaption)[^>]*>([\s\S]*?)<\/\7>/g;
  for (const m of main.matchAll(re)) {
    if (m[2] !== undefined) {
      const kv = [...m[2].matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(x => [flat(x[1]!), flat(x[2]!)] as [string, string]);
      blocks.push(kvWrap(kv, 78, !/nocolon/.test(m[1]!)));
    } else if (m[3] !== undefined) blocks.push(unesc(barsToText(m[3]).replace(/<[^>]*>/g, '')));
    else if (m[4] !== undefined) {
      const rows = [...m[4].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => flat(c[1]!)));
      blocks.push(textTable(rows));
    } else if (m[5]) { const h = flat(m[6]!); blocks.push(`${m[5] === '1' ? h.toUpperCase() : h}\n${(m[5] === '1' ? '=' : '-').repeat(h.length)}`); }
    else if (m[8] !== undefined && flat(m[8])) blocks.push(wrap(flat(m[8]), 78, m[7] === 'li' ? '  - ' : m[7] === 'dd' ? '    ' : ''));
  }
  return [title, banner ? flat(banner[1]!) : '', ...blocks, canary ? flat(canary[1]!) : ''].filter(Boolean).join('\n\n') + '\n';
}
