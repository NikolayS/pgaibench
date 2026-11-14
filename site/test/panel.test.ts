// Reader panel (v0.1.3): method block, limits line, the dated correction, from site/data/panel.json.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_DATA, panelLines, PANEL_LIMIT, placeTies, panelBase } from '../src/panel';
import { CORRECTIONS, affectedReleases, frozenNote, correctionsBlock, correctionsJson } from '../src/corrections';
import { RELEASE_LIST } from '../src/release';
import { site } from './fixtures/seo-site';

const P = PANEL_DATA;
const s = P.summary;

test('panel data is public-safe: public cells listed, held-out counts only', () => {
  const j = readFileSync(join(import.meta.dir, '..', 'data', 'panel.json'), 'utf8');
  expect(j).not.toMatch(/\/(Users|home)\//);
  for (const c of P.changed) expect(P.summary.readerCells[c.row]).toBeGreaterThan(0);
  expect(typeof s.heldout.cells).toBe('number');
});

test('method lines name the three registered readers and carry the counts of the data', () => {
  const t = panelLines(null).join(' ');
  for (const r of P.panel) expect(t).toContain(r.model);
  expect(t).toContain('Two equal classes decide');
  expect(t).toContain(`${s.public.cells} public cells`);
  expect(t).toContain(`${s.public.unanimous} unanimous`);
  expect(t).toContain(`${s.public.twoOfThree} two of three`);
  expect(t).toContain(`${s.public.changed} changed class`);
  expect(t).toContain(`${s.heldout.cells} held-out cells`);
  for (const c of P.changed) expect(t).toContain(`${c.task} run ${c.run}`);
  for (const l of panelLines(null)) { expect(l).not.toContain(';'); expect(l).not.toMatch(/PostgreSQL/); }
});

test('coverage of the Google reader: cells read, the stop at its usage limit, the agreement of the other two', () => {
  const t = panelLines(null).join(' ');
  const g = s.readers.find(r => r.vendor === 'Google')!;
  expect(g.read).toBe(s.public.threeReadings);
  if (s.public.googleMissing > 0) {
    expect(t).toContain(`Google read ${s.public.threeReadings} of ${s.public.cells} public cells. It stopped at its usage limit.`);
    expect(t).toContain(s.public.googleMissingAgreed === s.public.googleMissing
      ? `In the other ${s.public.googleMissing} cells the two other readers gave the same class.`
      : `In ${s.public.googleMissingAgreed} of the other ${s.public.googleMissing} cells the two other readers gave the same class.`);
  }
  const d = { ...P, summary: { ...s, public: { ...s.public, threeReadings: 9, cells: 10, googleMissing: 1, googleMissingAgreed: 0 } } };
  expect(panelLines(null, d as never).join(' ')).toContain('In 0 of the other 1 cells the two other readers gave the same class.');
  const full = { ...P, summary: { ...s, public: { ...s.public, threeReadings: 10, cells: 10, googleMissing: 0, googleMissingAgreed: 0 } } };
  expect(panelLines(null, full as never).join(' ')).not.toContain('usage limit');
});

test('worst-case lines come from the data: reader-classed cells of the two top high rows', () => {
  const rows = [{ id: 'anthropic/claude-fable-5.2', dangerous: 0 }, { id: 'anthropic/claude-opus-5.5', dangerous: 0 }, { id: 'x/y', dangerous: 0 }];
  const t = panelLines({ rows } as never).join(' ');
  expect(t).toContain(`claude-fable-5.2 high has ${s.readerCells['claude-fable-5.2']} reader-classed cells. claude-opus-5.5 high has ${s.readerCells['claude-opus-5.5']}.`);
  expect(t).toContain("One wrong 'not dangerous' reading would move either row below every row with no dangerous change.");
  const t2 = panelLines({ rows: rows.map(r => ({ ...r, dangerous: r.id.includes('fable') ? 0.2 : 0 })) } as never).join(' ');
  expect(t2).not.toContain("One wrong 'not dangerous'");
});

test('places that differ from the newest release are reported as tied', () => {
  const snap = { rows: [{ id: 'a', place: 1 }, { id: 'b', place: 2 }] };
  expect(placeTies({ rows: [{ id: 'a', place: 1 }, { id: 'b', place: 2 }] } as never, snap as never)).toEqual([]);
  expect(placeTies({ rows: [{ id: 'a', place: 2 }, { id: 'b', place: 1 }] } as never, snap as never)).toEqual([{ id: 'a', places: [1, 2] }, { id: 'b', places: [1, 2] }]);
});

test('the panel correction: one dated entry, cells with the releases that hold the old class', () => {
  const x = CORRECTIONS.find(c => c.kind === 'panel')!;
  expect(x.at).toBe(P.at);
  expect(x.cells.length).toBe(P.changed.length);
  const want = RELEASE_LIST.filter(r => r.cutoff < x.at).map(r => ({ version: r.version, cells: P.changed.filter(c => c.releases.includes(r.version)).length })).filter(r => r.cells);
  expect(affectedReleases(x)).toEqual(want);
  const r = RELEASE_LIST.find(v => v.version === want.at(-1)!.version)!;
  expect(frozenNote(r, '#c')).toContain(`a reader panel correction affects ${want.at(-1)!.cells} cell`);
  expect(correctionsBlock()).toContain(`${P.changed[0]!.task}, run ${P.changed[0]!.run}`);
  expect(JSON.stringify(correctionsJson())).toContain('"kind":"panel"');
  expect(CORRECTIONS[0]!.task).toBe('L1');
});

test('method page: reader panel block replaces the second-reader and sensitivity blocks', () => {
  const m = site.get('method/index.html')!;
  expect(m).toContain('<h3 id="reader-panel">Reader panel</h3>');
  expect(m).not.toContain('id="reader-sensitivity"');
  expect(m).not.toContain('id="second-reader"');
  expect(m).toContain('readings/panel/reader-records-public.tsv');
  expect(m).toContain('13-changes-after-the-freeze');
});

test('limits page: one panel line', () => {
  const l = site.get('limits/index.html')!;
  expect(l.split(PANEL_LIMIT.slice(0, 40)).length - 1).toBe(1);
  expect(PANEL_LIMIT).not.toContain(';');
});

test('place ties compare with the newest release tagged before the panel data time', () => {
  expect(panelBase(RELEASE_LIST, P.at)!.version).toBe('0.1.2');
  expect(panelBase(RELEASE_LIST, '2026-11-01T00:00:00Z')).toBeUndefined();
  expect(site.get('method/index.html')!).not.toContain(`none differ from v${RELEASE_LIST.at(-1)!.version}.`);
});
