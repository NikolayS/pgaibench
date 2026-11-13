// "Models under test": per configuration, what we called and how, from models.json and the generation records.
import { z } from 'zod';
import { esc } from './html';
import { baseName, effortLabel, isLevelRow, pathWord, shortName } from './svg';
import { DEEPSEEK_ISSUE } from './statements';

const row = z.object({ id: z.string(), vendor: z.string(), called: z.string(), access: z.string(), effort: z.string(), pin: z.string(), runs: z.array(z.string()), /** the vendor default effort as recorded in models.json */ default: z.string().optional() });
export const modelsSchema = z.array(row);
export type ModelsTable = z.infer<typeof modelsSchema>;
export const parseModels = (x: unknown): ModelsTable => modelsSchema.parse(x);

const NR = 'not recorded';
const effort = (id: string, e: string) => (e ? effortLabel(id, e) : NR);

const isSet = (e: string) => !!e && e !== 'default';
/** A configuration in plain words without its effort: "claude-fable-5.2", "gemini-4-carbon CLI". */
const conf = (id: string) => `${baseName(id)}${pathWord(id)}`;
const isCli = (r: ModelsTable[number]) => r.access.startsWith('vendor CLI');
/** Levels present, highest first. */
const levelsOf = (m: ModelsTable) => [...new Set(m.filter(r => isSet(r.effort)).map(r => r.effort))].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b));
/** Models (by name) with a row at each of two or more levels, and the models with one level only. */
function levelCounts(m: ModelsTable) {
  const by = new Map<string, Set<string>>();
  for (const r of m) by.set(baseName(r.id), (by.get(baseName(r.id)) ?? new Set()).add(isSet(r.effort) ? r.effort : 'default'));
  const both = [...by.values()].filter(x => x.size > 1).length;
  return { both, one: by.size - both };
}
const count = (n: number) => NUM[n] ?? String(n);
/** The effort statement, generated from the same rows as the table, so the text cannot contradict it. */
export function effortSentence(m: ModelsTable): string {
  const parts: string[] = [];
  const first = m.filter(r => isCli(r) && isSet(r.effort) && !isLevelRow(r.id)), second = m.filter(r => isCli(r) && isLevelRow(r.id));
  if (first.length) {
    parts.push('We set the reasoning effort for every row that runs through a vendor command-line client.');
    const groups = levelsOf(first).map((lv, i) => `${i ? cap(lv) : lv} for ${names(first.filter(r => r.effort === lv).map(r => conf(r.id)))}.`);
    parts.push(`First level, the vendor default as we recorded it: ${groups.join(' ')}`);
  }
  if (second.length) {
    const models = new Set(second.map(r => baseName(r.id))), all = new Set(first.map(r => baseName(r.id)));
    parts.push([...all].every(x => models.has(x)) ? `Second level: the same ${count(models.size)} models at the other of the two levels.` : `Second level: ${names(second.map(r => `${conf(r.id)} at ${r.effort}`))}.`);
  }
  const routerSet = m.filter(r => !isCli(r) && isSet(r.effort)), unset = m.filter(r => !isSet(r.effort));
  for (const r of routerSet) parts.push(`${conf(r.id)} runs through the router at ${r.effort}.${r.default && r.default !== r.effort ? ` Its recorded default is ${r.default}.` : ''}`);
  if (unset.length) parts.push(`For ${routerSet.length ? 'the other' : 'the'} router rows we sent no effort setting: ${names(unset.map(r => conf(r.id)))}.`);
  parts.push('Effort names are not equal across vendors.');
  return parts.join(' ');
}

/** Configurations served from a quantized endpoint, as the provider pin shows. Empty when none. */
/** The quantized endpoints, for the short note. */
export function quantizedRows(m: ModelsTable): { name: string; kind: string; noReasoning: boolean }[] {
  return m.filter(r => /mxfp4|fp8|fp4|int8|int4|bf8/i.test(r.pin)).map(r => ({ name: baseName(r.id), kind: /(mxfp4|fp8|fp4|int8|int4|bf8)/i.exec(r.pin)![1]!.toLowerCase(), noReasoning: r.id.startsWith('deepseek/deepseek-v4-pro') }));
}
export function quantizedSentence(m: ModelsTable): string {
  const q = m.filter(r => /mxfp4|fp8|fp4|int8|int4|bf8/i.test(r.pin));
  if (!q.length) return '';
  const fmt = (r: ModelsTable[number]) => /(mxfp4|fp8|fp4|int8|int4|bf8)/i.exec(r.pin)![1]!.toLowerCase();
  return `${q.map(r => `${shortName(r.id)} ran on a quantized (${fmt(r)}) endpoint of its pinned provider`).join('. ')}. This breaks our own rule against quantized variants. ${q.length === 1 ? 'Its results' : 'Their results'} may be lower than the model gives at full precision.${q.some(r => r.id.startsWith('deepseek/deepseek-v4-pro')) ? ` ${DEEPSEEK_ISSUE}` : ''}`;
}

/** Rows for the given configurations, in that order; a configuration without a record shows "not recorded". */
export function modelsTable(m: ModelsTable, ids: string[], runs = 3): string {
  const idx = Array.from({ length: runs }, (_, i) => i);
  const trs = ids.map(id => {
    const r = m.find(x => x.id === id);
    const cells = r ? [r.vendor, r.called, r.access, effort(r.id, r.effort), r.pin, ...idx.map(i => r.runs[i] ?? NR)] : Array(5 + runs).fill(NR);
    return `<tr><th scope="row">${esc(shortName(id))}</th>${cells.map(v => `<td>${esc(v || NR)}</td>`).join('')}</tr>`;
  }).join('');
  const head = ['configuration', 'vendor', 'model id called', 'access', 'reasoning effort', 'provider pin', ...idx.map(i => `run ${i + 1} (UTC)`)].map(h => `<th scope="col">${h}</th>`).join('');
  return `<h3 id="models-under-test">Models under test</h3>
<p>Per configuration: the exact model id we called, the access path, the reasoning effort we set, the provider pin, and the UTC dates of the answers in each run. Values come from the model list and the answer records.</p>
<div class="table-scroll" tabindex="0" role="region" aria-label="Models under test"><table class="models compact"><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const RANK = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];
/** The effort levels of this release by vendor, in plain words, from the models table (owner: "not fair"). */
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const names = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
export function fairnessSentence(m: ModelsTable): string {
  const segs = levelsOf(m).map(lv => `At ${lv}: ${names(m.filter(r => isSet(r.effort) && r.effort === lv).map(r => conf(r.id)))}.`);
  const dflt = m.filter(r => !isSet(r.effort));
  if (dflt.length) segs.push(`At the provider default (router rows, no effort sent): ${names(dflt.map(r => (effortLabel(r.id, r.effort) === 'no thinking' ? `${conf(r.id)} (its endpoint returned no thinking)` : conf(r.id))))}.`);
  const k = levelCounts(m);
  if (k.both) segs.push(`${cap(count(k.both))} models have a row at ${levelsOf(m).join(' and a row at ')}. ${cap(count(k.one))} model${k.one === 1 ? ' has' : 's have'} one level only.`);
  return `The effort levels differ between rows in this release. ${segs.join(' ')} This is not an equal comparison.`;
}
/** "What we did not check": the effort levels not run, and how many models have more than one. */
export function levelsSentence(m: ModelsTable): string {
  const k = levelCounts(m);
  return `Reasoning-effort settings other than ${names(levelsOf(m))}.${k.both ? ` ${cap(count(k.both))} models have rows at both levels. ${cap(count(k.one))} model${k.one === 1 ? ' has' : 's have'} one level only.` : ''}`;
}
/** Next to the ranking: what a row is, what "default" means (only when a row has it), and the fairness statement. */
export function effortNotes(m: ModelsTable, row: string): string {
  const dflt = m.some(r => !isSet(r.effort)) ? ' Provider default. We sent no effort setting. The models table records this.' : '';
  return `${row}${dflt} ${fairnessSentence(m)}`;
}
