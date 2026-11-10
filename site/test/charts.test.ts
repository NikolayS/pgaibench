import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';

const fixturePath = join(import.meta.dir, 'fixtures', 'results', 'results.json');
const sites = [
  buildSite({ published: false, base: '/' }),
  buildSite({ published: false, base: '/', resultsJson: JSON.parse(readFileSync(fixturePath, 'utf8')) }),
  buildSite({ published: true, base: '/', resultsPath: fixturePath, frozenPath: join(import.meta.dir, 'fixtures', 'frozen.example.json') }),
];
const svgs = (doc: string) => doc.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
const ticks = (svg: string, anchor: 'middle' | 'end') => [...svg.matchAll(new RegExp(`<text class="tick" x="([\\d.]+)" y="([\\d.]+)" text-anchor="${anchor}">(\\d+)%</text>`, 'g'))]
  .map(m => ({ pos: Number(anchor === 'middle' ? m[1] : m[2]), v: Number(m[3]) }));

describe('charts', () => {
  test('every chart has linear, zero-based axes', () => {
    let n = 0;
    for (const s of sites) for (const [p, doc] of s) for (const svg of svgs(doc)) {
      n++;
      for (const a of ['middle', 'end'] as const) {
        const t = ticks(svg, a);
        expect(t.length, p).toBeGreaterThanOrEqual(3);
        expect(t[0]!.v, p).toBe(0);
        const per = (t[1]!.pos - t[0]!.pos) / (t[1]!.v - t[0]!.v);
        for (const x of t) expect(Math.abs(x.pos - (t[0]!.pos + per * x.v)), `${p} ${a} ${x.v}`).toBeLessThan(0.2);
      }
    }
    expect(n).toBeGreaterThan(0);
  });
  test('no log scale anywhere in the output or the generator', () => {
    const bad = /log[\s_-]?scale|logarithm|scaleLog|symlog|Math\.log/i;
    for (const s of sites) for (const [p, doc] of s) expect(doc, p).not.toMatch(bad);
    for (const dir of ['src', 'assets']) for (const f of readdirSync(join(import.meta.dir, '..', dir)))
      expect(readFileSync(join(import.meta.dir, '..', dir, f), 'utf8'), f).not.toMatch(bad);
  });
  test('no emojis in any built file', () => {
    for (const s of sites) for (const [p, doc] of s) expect(doc, p).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  test('tables are in the HTML without JavaScript', () => {
    const lb = sites[1]!.get('leaderboard/index.html')!.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(lb).toMatch(/<table[\s\S]*<th scope="row"[^>]*>model-a[\s\S]*<\/table>/);
    for (const [p, doc] of sites[1]!) expect(doc, p).not.toMatch(/<table[^>]*\bhidden\b|display:\s*none[^"]*"[^>]*><table/);
  });
});
