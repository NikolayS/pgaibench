import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { BAR_WIDTH } from '../src/chart';

const fixturePath = join(import.meta.dir, 'fixtures', 'results', 'results.json');
const sites = [
  buildSite({ published: false, base: '/' }),
  buildSite({ published: false, base: '/', resultsJson: JSON.parse(readFileSync(fixturePath, 'utf8')) }),
  buildSite({ published: true, base: '/', resultsPath: fixturePath, frozenPath: join(import.meta.dir, 'fixtures', 'frozen.example.json') }),
];
const pres = (doc: string) => doc.match(/<pre class="chart"[\s\S]*?<\/pre>/g) ?? [];

describe('charts', () => {
  test('every chart has a linear, zero-based scale: + marks equally spaced, 0% at the bar start', () => {
    let n = 0;
    for (const s of sites) for (const [p, doc] of s) for (const pre of pres(doc)) {
      n++;
      const lines = pre.replace(/<[^>]*>/g, '').split('\n');
      const rule = lines.find(l => /^\s+\+-+\+/.test(l))!;
      const plus = [...rule].flatMap((ch, i) => (ch === '+' ? [i] : []));
      expect(plus.length, p).toBe(5);
      for (let i = 1; i < plus.length; i++) expect(plus[i]! - plus[i - 1]!, p).toBe(BAR_WIDTH / 4);
      const labels = lines[lines.indexOf(rule) + 1]!;
      expect(labels.indexOf('0%'), p).toBe(plus[0]);
      expect(labels.indexOf('50%') + 1, p).toBe(plus[2]);
      const bars = lines.filter(l => /\|[█▒░ ]+\|/.test(l));
      for (const l of bars) expect(l.indexOf('|'), p).toBe(plus[0]);
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
