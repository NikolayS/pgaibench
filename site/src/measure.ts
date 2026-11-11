// Width measures for built pages, in characters (see site/test/widths.test.ts).
export const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
export const cellText = (s: string) => unesc(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export function tableWidth(table: string): number {
  const widths: number[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    let col = 0;
    for (const c of tr[1]!.matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const span = Number(/colspan="(\d+)"/.exec(c[2]!)?.[1] ?? 1);
      // Header cells, row headers and numbers do not wrap: full text. Other cells wrap at spaces:
      // their longest word, but at least 20 characters (or the whole text when shorter).
      const t = cellText(c[3]!), nowrap = c[1] === 'th' || /class="[^"]*num/.test(c[2]!);
      const w = nowrap ? t.length : Math.max(Math.min(t.length, 20), ...t.split(' ').map(x => x.length));
      if (span === 1) widths[col] = Math.max(widths[col] ?? 0, w);
      col += span;
    }
  }
  return widths.reduce((a, w) => a + w + 2, 0);
}
const WRAPPED = /class="(?:head|kv|answer|prompt|title)"/;
export function preLines(doc: string): string[] {
  return [...doc.matchAll(/<pre([^>]*)>([\s\S]*?)<\/pre>/g)].filter(m => !WRAPPED.test(m[1]!)).flatMap(m => unesc(m[2]!.replace(/<[^>]*>/g, '')).split('\n'));
}


if (import.meta.main) {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const dir = process.argv[2]!;
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const by = new Map<string, { pre: number; table: number }>();
  for (const f of walk(dir).filter(f => f.endsWith('.html'))) {
    const doc = readFileSync(f, 'utf8'), kind = relative(dir, f).split('/')[0]!;
    const pre = Math.max(0, ...preLines(doc).map(l => [...l].length)), table = Math.max(0, ...[...doc.matchAll(/<table[\s\S]*?<\/table>/g)].map(t => tableWidth(t[0])));
    const o = by.get(kind) ?? { pre: 0, table: 0 }; by.set(kind, { pre: Math.max(o.pre, pre), table: Math.max(o.table, table) });
  }
  for (const [k, v] of [...by].sort()) console.log(`${k.padEnd(16)} max pre line ${v.pre}, max table ${v.table}`);
}
