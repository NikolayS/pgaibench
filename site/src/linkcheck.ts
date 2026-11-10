// Checks internal links and anchors in the built site. External links are
// only syntax-checked; tests make no network calls.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ids = (doc: string) => new Set([...doc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]!));

function target(files: Map<string, string>, path: string): string | null {
  const p = path;
  for (const c of p === '' ? ['index.html'] : p.endsWith('/') ? [p + 'index.html'] : [p, p + '/index.html', p + '.html'])
    if (files.has(c)) return c;
  return null;
}

/** Resolves a relative link against the directory of a file (or the root for a base element). */
export function resolveRel(dir: string, path: string): string {
  const out = dir ? dir.split('/') : [];
  const parts = path.split('/');
  parts.forEach((p, i) => { if (p === '..') out.pop(); else if (p !== '.' && (p !== '' || i === parts.length - 1)) out.push(p); });
  return out.join('/');
}

export function checkLinks(files: Map<string, string>, base: string): string[] {
  const errors: string[] = [];
  for (const [file, doc] of files) {
    if (!file.endsWith('.html')) continue;
    const hasBase = /<base href="([^"]*)">/.exec(doc);
    if (hasBase && hasBase[1] !== base) errors.push(`${file}: base element ${hasBase[1]} differs from ${base}`);
    const dir = hasBase ? '' : file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    for (const m of doc.replace(/<base href="[^"]*">/, '').matchAll(/\b(href|src)="([^"]*)"/g)) {
      const url = m[2]!.replace(/&amp;/g, '&');
      const where = `${file}: ${url}`;
      if (/^(https?:|mailto:)/i.test(url)) {
        try { const u = new URL(url); if (!u.hostname && !url.startsWith('mailto:')) errors.push(`${where}: no host`); }
        catch { errors.push(`${where}: invalid URL`); }
        continue;
      }
      if (/\s/.test(url)) { errors.push(`${where}: whitespace in link`); continue; }
      if (url.startsWith('/')) { errors.push(`${where}: absolute path, links must be relative`); continue; }
      const [path, anchor] = url.split('#') as [string, string | undefined];
      let dest = file;
      if (path !== '') {
        const t = target(files, resolveRel(dir, path));
        if (!t) { errors.push(`${where}: missing target`); continue; }
        dest = t;
      }
      if (anchor && !ids(files.get(dest)!).has(anchor)) errors.push(`${where}: missing anchor #${anchor}`);
    }
  }
  return errors;
}

export function readDist(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split('\\').join('/'), /\.(html|css|js|svg|txt)$/.test(n) ? readFileSync(p, 'utf8') : '');
    }
  };
  walk(dir);
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, '..', 'dist');
  const base = process.env.BASE ?? readFileSync(join(dir, '.base'), 'utf8').trim();
  const errs = checkLinks(readDist(dir), base);
  for (const e of errs) console.error(e);
  console.log(errs.length ? `${errs.length} broken links` : 'links ok');
  process.exit(errs.length ? 1 : 0);
}
