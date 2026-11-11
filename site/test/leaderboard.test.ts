import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildSite } from '../src/build';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const site = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const lb = site.get('leaderboard/index.html')!;
const tables = [...lb.matchAll(/<table class="lb[\s\S]*?<\/table>/g)].map(m => m[0]);
const text = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('results page', () => {
  test('per track: a counted-outcomes table for text and for lab, never one pooled table, plus run settings', () => {
    const outcome = tables.filter(t => t.includes('right</abbr>+'));
    expect(outcome).toHaveLength(2);
    expect(lb).toContain('Track: Router (fixture)');
    expect(lb).toMatch(/<h3[^>]*>Text-scored<\/h3>[\s\S]*<h3[^>]*>Lab-executed<\/h3>/);
    expect(text(lb)).toContain('never pooled');
    expect(lb).toContain('<h4>Run settings</h4>');
  });
  test('short headers with a direction mark and a title; legend above the first table', () => {
    for (const t of tables) for (const h of t.matchAll(/<th scope="col"( class="num[^"]*")? title="([^"]*)"><abbr title="[^"]*">([^<]*)<\/abbr>([+.-])<\/th>/g)) {
      expect(h[3]!.length).toBeLessThanOrEqual(6);
      expect(h[2]).toMatch(/\((higher is better|lower is better|not a quality measure)\)$/);
    }
    const first = lb.indexOf('<table class="lb');
    expect(lb.lastIndexOf('Marks after a short header: + higher is better, - lower is better, . not a quality measure.', first)).toBeGreaterThan(0);
    expect(tables[0]).toMatch(/>\d+-\d+</); // Wilson interval column
  });
  test('H-C: a text-scored table has no lab harm column; the text chart plots risky patterns, the lab chart measured harm', () => {
    const [txt, labT] = tables.filter(t => t.includes('right</abbr>+'));
    expect(txt).not.toContain('>harm</abbr>');
    expect(labT).toContain('>harm</abbr>-');
    expect(lb).toContain('Risky pattern, no harm measured, share of all tasks (lower is better)');
    expect(lb).toContain('Harmful (measured in the lab), share of all tasks (lower is better)');
  });
  test('baselines: plain labels on their own row, in the outcome tables and every chart, explained once', () => {
    for (const t of tables.filter(t => t.includes('right</abbr>+'))) for (const b of ['always escalate', 'always our safe reference change', 'always our trapped reference change']) expect(t).toContain(`Baseline (no model): ${b}`);
    expect(text(lb)).toContain('Baselines are fixed policies with no model, scored on the same tasks.');
    for (const t of tables.filter(t => t.includes('<h4>') || t.includes('eff</abbr>'))) expect(t).not.toContain('Baseline (no model)');
  });
  test('no tiers; default group is not separated; paired tests stay', () => {
    expect(lb).not.toMatch(/class="num tier"|>Tier</);
    expect(text(lb)).toContain('not separated at this sample size');
    expect(lb).toContain('Holm p');
  });
  test('confirmed effort null shows as n/c; served model null as n/r, both explained', () => {
    const st = tables.find(t => t.includes('eff</abbr>'))!;
    expect(text(st)).toContain('n/c');
    expect(text(lb)).toContain('n/c: not confirmed');
  });
  test('incomplete and dropped models are listed with a reason and get no rate', () => {
    const ex = lb.slice(lb.indexOf('id="excluded"'), lb.indexOf('id="confusion"'));
    expect(text(ex)).toContain('incomplete: 1 of 8 cells generated');
    expect(text(ex)).toContain('not evaluated (fixture cost rule)');
    for (const t of tables) expect(t).not.toMatch(/model-c|model-d/);
  });
  test('held-out results are counts only', () => {
    expect(text(lb)).toContain('Counts only; no rate.');
    expect(text(lb)).toMatch(/model-a · default: right change 2/);
  });
  test('the text-by-lab confusion matrix is shown', () => {
    const cf = lb.slice(lb.indexOf('id="confusion"'));
    expect(text(cf)).toMatch(/Text class Lab class Cells/);
    expect(text(cf)).toMatch(/right change harmful 0|pending review right change 1/);
  });
});
