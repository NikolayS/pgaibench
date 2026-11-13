// Batch 3: rows at a second effort level. Takeaway names two models, the line after it is computed from the paired
// differences, and a compact high-against-medium table.
import { expect, test } from 'bun:test';
import { takeaway } from '../src/front';
import { takeawayNote, highMediumTable, TAKEAWAY_OLD, TAKEAWAY_PAIRS } from '../src/levels';
import type { SafetyRow } from '../src/safety';

const row = (id: string, dangerous: number, done: number) => ({ model_id: id, dangerous, done, tasks: 19 } as unknown as SafetyRow);
const P = (id: string, base: string, diff: number, lo: number, hi: number) => ({ id, base, paired: { diff, lo, hi, missing: [], without: null } });

test('takeaway: two different models, the best row of each', () => {
  expect(takeaway([row('a/claude-fable-5.2', 0, 18), row('a/claude-fable-5.2:medium', 0, 17), row('a/claude-opus-5.5', 0, 17)]))
    .toBe('claude-fable-5.2 and claude-opus-5.5 did 18 and 17 of 19 tasks per run. No dangerous change in any run.');
});

test('the line after the takeaway: the new sentence only when every pair interval holds 0 inside it', () => {
  expect(TAKEAWAY_PAIRS).toBe("Each model's rows at high and medium effort differ by less than their 95% intervals. Ranges of neighbouring rows overlap.");
  expect(takeawayNote([P('a:medium', 'a', -2, -8, 3), P('b:high', 'b', 4, -9, 18)])).toBe(TAKEAWAY_PAIRS);
  expect(takeawayNote([P('a:medium', 'a', -5.3, -11.6, 0)])).toBe(TAKEAWAY_OLD);
  expect(takeawayNote([])).toBe(TAKEAWAY_OLD);
});

test('high against medium: done at each level, score difference high minus medium with its interval', () => {
  const rows = [{ id: 'a/m', done: 18 }, { id: 'a/m:medium', done: 17 }, { id: 'o/g', done: 14 }, { id: 'o/g:high', done: 15 }];
  const eff = (id: string) => (id === 'a/m' || id.endsWith(':high') ? 'high' : 'medium');
  const t = highMediumTable(rows, [P('a/m:medium', 'a/m', -5.26, -11.58, 0), P('o/g:high', 'o/g', 5.79, -2.63, 16.6)], eff);
  const text = t.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|');
  expect(t).toContain('<table class="compact');
  expect(text).toContain('|m|18|17|+5.3 (0 to +11.6)|');
  expect(text).toContain('|g|15|14|+5.8 (-2.6 to +16.6)|');
  expect(highMediumTable(rows, [], eff)).toBe('');
});

test('llms.txt facts: two different models', async () => {
  const { headlineFacts } = await import('../src/seo');
  const r = (id: string, done: number) => ({ id, done, included: true, dangerous: 0, place: 1, score: 1, samples: 5, heldout: { tasks: 3 } });
  const f = headlineFacts({ publicIds: Array(19).fill('x'), rows: [r('a/claude-fable-5.2', 18), r('a/claude-fable-5.2:medium', 17), r('a/claude-opus-5.5', 17)], samplesPerArm: [{ id: '', samples: 5 }], effort: [] } as never);
  expect(f.takeaway).toContain('claude-fable-5.2 and claude-opus-5.5');
});
