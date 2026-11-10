// Plain-text twin of a page: the same tables as aligned columns, charts
// verbatim, prose wrapped at 78 columns. No markup in the output.
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
  let main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(doc)?.[1] ?? '';
  main = main.replace(/<p class="sr"[\s\S]*?<\/p>/g, '').replace(/<caption>[\s\S]*?<\/caption>/g, '');
  const blocks: string[] = [];
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>|<table[^>]*>([\s\S]*?)<\/table>|<h([1-4])[^>]*>([\s\S]*?)<\/h\3>|<(p|li|dt|dd|summary|figcaption)[^>]*>([\s\S]*?)<\/\5>/g;
  for (const m of main.matchAll(re)) {
    if (m[1] !== undefined) blocks.push(unesc(m[1].replace(/<[^>]*>/g, '')));
    else if (m[2] !== undefined) {
      const rows = [...m[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => flat(c[1]!)));
      blocks.push(textTable(rows));
    } else if (m[3]) { const h = flat(m[4]!); blocks.push(`${m[3] === '1' ? h.toUpperCase() : h}\n${(m[3] === '1' ? '=' : '-').repeat(h.length)}`); }
    else if (m[6] !== undefined && flat(m[6])) blocks.push(wrap(flat(m[6]), 78, m[5] === 'li' ? '  - ' : m[5] === 'dd' ? '    ' : ''));
  }
  return [title, banner ? flat(banner[1]!) : '', ...blocks, canary ? flat(canary[1]!) : ''].filter(Boolean).join('\n\n') + '\n';
}
