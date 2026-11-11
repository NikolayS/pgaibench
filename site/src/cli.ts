// bun run site:build  -> site/dist
// Env:
//   PUBLISHED=true|false  default false (preview banner on every page)
//   BASE=/pgaibench/      URL base path
//   RESULTS=<dir>         results directory: <dir>/results.json and <dir>/cells.json.
//                         Required with PUBLISHED=true. With PUBLISHED=false it is
//                         optional and must hold fixture data only.
//   FROZEN=<file>         frozen scenario list. Required with PUBLISHED=true.
//   OUT_OF_SET=<file>     scenarios out of the set (default site/data/out-of-v01.json)
//   PENDING=true          publication build before the first results: no RESULTS, pending results page
//   PROVISIONAL=true      lab run in progress: RESULTS=<dir> from site:data --live (results.json, cells.json,
//                         provisional.json); real data, provisional banner; never PUBLISHED
//   CNAME=<host>          custom domain for GitHub Pages (writes CNAME), e.g. pgaibench.dev with BASE=/
//   OUT=<dir>             output directory (default site/dist)
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildSite } from './build';
import { assertRealResults, parseResults } from './results';

const published = process.env.PUBLISHED === 'true';
const pending = process.env.PENDING === 'true';
const provisional = process.env.PROVISIONAL === 'true';
if (provisional && (published || pending || !process.env.RESULTS)) throw new Error('PROVISIONAL=true needs RESULTS=<dir> and neither PUBLISHED nor PENDING');
const base = process.env.BASE ?? '/pgaibench/';
const out = resolve(process.env.OUT ?? join(import.meta.dir, '..', 'dist'));
const dir = process.env.RESULTS ? resolve(process.env.RESULTS) : undefined;
if (dir && !statSync(dir).isDirectory()) throw new Error(`RESULTS must be a directory with results.json and cells.json: ${dir}`);
if (published && !dir) throw new Error('PUBLISHED=true needs RESULTS=<dir> with results.json and cells.json');
const resultsPath = dir ? join(dir, 'results.json') : undefined;
const cellsPath = dir ? join(dir, 'cells.json') : undefined;
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
if (published || provisional) assertRealResults(resultsPath!, parseResults(read(resultsPath!)));
const withheld: string[] = [];
const inputs = { pending, frozenPath: process.env.FROZEN, outOfSetPath: process.env.OUT_OF_SET, cname: process.env.CNAME || undefined };
const files = buildSite(provisional
  ? { published: false, base, ...inputs, resultsJson: read(resultsPath!), cellsJson: read(cellsPath!), provisionalJson: read(join(dir!, 'provisional.json')), withheld }
  : published
  ? { published, base, resultsPath, cellsPath, ...inputs }
  : { published, base, ...inputs,
      resultsJson: resultsPath ? read(resultsPath) : undefined,
      cellsJson: cellsPath && inputs.frozenPath && existsSync(cellsPath) ? read(cellsPath) : undefined });
rmSync(out, { recursive: true, force: true });
for (const [p, doc] of files) {
  const f = join(out, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, doc);
}
writeFileSync(join(out, '.base'), base);
const pages = [...files.keys()].filter(p => p.endsWith('.html')).length;
if (withheld.length) console.log(`answers withheld (publication scan): ${withheld.length}\n${withheld.map(w => `  ${w}`).join('\n')}`);
console.log(`built ${files.size} files (${pages} HTML pages) into ${out} (PUBLISHED=${published}${pending ? ', PENDING=true' : ''}${provisional ? ', PROVISIONAL=true' : ''}, BASE=${base})`);
