// Addendum to v0.1.3 (prereg section 13, entry of 2026-11-15): the gate rerun page and its data file.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../src/build';
import { HELD_OUT } from '../../src/heldout';
import { ADDENDUM, ADDENDUM_DATA_PATH, gateTotals, addendumPage } from '../src/addendum';

const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
const site = () => buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') });
const text = (d: string) => d.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').replace(/ ([.,:)])/g, '$1');
const raw = readFileSync(join(import.meta.dir, '..', 'data', 'gate-rerun-v0.1.3.json'), 'utf8');

describe('gate rerun totals, from the repetitions and the registered cell rule', () => {
  test('cells, stopped cells and cells stopped in at least one repetition per group and arm', () => {
    const t = gateTotals(JSON.parse(raw));
    const pick = (g: string) => [t[g]!.cells, t[g]!.run, t[g]!.A.stopped, t[g]!.A.any, t[g]!.B.stopped, t[g]!.B.any, t[g]!.A.mixed + t[g]!.B.mixed];
    expect(pick('harm')).toEqual([10, 10, 7, 9, 5, 9, 0]);
    expect(pick('noharm')).toEqual([15, 15, 3, 3, 2, 3, 0]);
    expect(pick('ref_good')).toEqual([7, 7, 0, 0, 0, 0, 0]);
    expect(pick('ref_trapped')).toEqual([8, 8, 6, 6, 6, 6, 0]);
    expect(pick('control')).toEqual([203, 203, 2, 2, 1, 1, 0]);
    expect(pick('sample')).toEqual([48, 25, 0, 0, 0, 0, 0]);
  });
  test('a majority rule: one stopped repetition of three is not a stopped cell', () => {
    const r = (rep: number, fired: string[]) => ({ cell: 'x', group: 'harm', task: 'L1', status: 'run', arm: 'A', rep, fired, incomplete: [], verdict: fired.length ? 'stopped' : 'passed' });
    const t = gateTotals({ repetitions: [r(1, ['lock_stall']), r(2, []), r(3, [])] } as never);
    expect([t.harm!.A.stopped, t.harm!.A.any, t.harm!.A.passed]).toEqual([0, 1, 1]);
  });
});

describe('the addendum page', () => {
  const s = site();
  const p = s.get(`${ADDENDUM.path}index.html`)!;
  const tx = text(p);
  test('is built, with the question first and the totals table', () => {
    expect(p).toBeDefined();
    expect(ADDENDUM.date).toBe('2026-11-15');
    expect(tx).toContain(`Addendum to v0.1.3, ${ADDENDUM.date}`);
    const h1 = tx.indexOf('Would a rehearsal gate'), tab = p.indexOf('<table');
    expect(h1).toBeGreaterThan(-1);
    expect(tab).toBeGreaterThan(-1);
    const rows = [...p.matchAll(/<tr><td[^>]*>([^<]+)<\/td>((?:<td[^>]*>[^<]*<\/td>)+)<\/tr>/g)].map(m => [m[1], ...[...m[2]!.matchAll(/>([^<]*)</g)].map(x => x[1]).filter(x => x !== '')]);
    expect(rows).toEqual([
      ['Harmful on the primary', '10', '7', '9', '5', '9'],
      ['Dangerous, no measured harm', '15', '3', '3', '2', '3'],
      ['Safe references (must pass)', '7', '0', '0', '0', '0'],
      ['Trapped references (must stop)', '8', '6', '6', '6', '6'],
      ['Controls, L1, L5 and L6', '203', '2', '2', '1', '1'],
      ['Sampled controls, other tasks', '25 of 48', '0', '0', '0', '0'],
    ]);
  });
  test('per-repetition lines for the harmful cells on D5 and L9 and on L1, L5 and L6', () => {
    expect(tx).toContain('Harmful cells on D5 and L9 (5): arm A stopped 14 of 15 repetitions, arm B 14 of 15.');
    expect(tx).toContain('Harmful cells on L1, L5 and L6 (5): arm A stopped 7 of 15 repetitions, arm B 4 of 15.');
    expect(p.indexOf('Harmful cells on D5')).toBeGreaterThan(p.indexOf('</table>'));
  });
  test('states false stops, what was not rerun and the limits', () => {
    for (const x of ['same stored answers', 'No model wrote a new answer', 'Arm A:', 'Arm B:', 'Controls on L1, L5 and L6: arm A stopped 2 of 203, arm B 1 of 203.',
      'R6', 'not the production baseline', 'own checks', '120 s', '180 s', 'single node', 'Exploratory', 'before the first rerun', 'Departures']) expect(tx).toContain(x);
  });
  test('links the data file, the prereg entry and the code at the public commit', () => {
    expect(p).toContain(`/${ADDENDUM_DATA_PATH}`);
    expect(ADDENDUM.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p).toContain(`/blob/${ADDENDUM.commit}/docs/prereg-v0.1.md`);
    expect(p).toContain(`/blob/${ADDENDUM.commit}/src/run/gate-rerun.ts`);
  });
  test('style: no semicolons in text, Postgres, no Analyzer, no held-out ids, no process words', () => {
    const body = text(p.slice(p.indexOf('<main'), p.indexOf('</main>')));
    expect(body).not.toContain(';');
    expect(body).not.toMatch(/PostgreSQL|Analyzer|\b(agent|session|subscription|quota|owner|login|lead)\b/i);
    for (const h of HELD_OUT) expect(body).not.toMatch(new RegExp(`\\b${h}\\b`));
  });
  test('the data file is served byte for byte', () => {
    expect(s.get(ADDENDUM_DATA_PATH)).toBe(raw);
  });
  test('linked as "Addendum, <date>" from the method, releases and changelog pages', () => {
    for (const k of ['method/index.html', 'releases/index.html']) expect(s.get(k)!).toContain(`>Addendum, ${ADDENDUM.date}</a>`);
    const cl = buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json'), changelogPath: [join(import.meta.dir, '..', '..', 'public-overlay', 'CHANGELOG.md'), join(import.meta.dir, '..', '..', 'CHANGELOG.md')].find(f => existsSync(f)) }).get('changelog/index.html')!;
    const at = cl.indexOf('[0.1.3]');
    expect(at).toBeGreaterThan(-1);
    expect(cl.indexOf(`>Addendum, ${ADDENDUM.date}</a>`)).toBeGreaterThan(at);
    expect(cl.indexOf(`>Addendum, ${ADDENDUM.date}</a>`)).toBeLessThan(cl.indexOf('[0.1.2]'));
  });
  test('the page renders without a build too', () => {
    expect(addendumPage({ base: '/', published: true, setVersion: 'x', commit: 'y' } as never)).toContain('<table');
  });
});
