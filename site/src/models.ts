// "Models under test": per configuration, what we called and how, from models.json and the generation records.
import { z } from 'zod';
import { esc } from './html';
import { baseName, shortName } from './svg';

const row = z.object({ id: z.string(), vendor: z.string(), called: z.string(), access: z.string(), effort: z.string(), pin: z.string(), runs: z.array(z.string()) });
export const modelsSchema = z.array(row);
export type ModelsTable = z.infer<typeof modelsSchema>;
export const parseModels = (x: unknown): ModelsTable => modelsSchema.parse(x);

const NR = 'not recorded';
const effort = (e: string) => (e === 'default' ? 'provider default (not set)' : e || NR);

const isSet = (e: string) => !!e && e !== 'default';
/** The effort statement, generated from the same rows as the table, so the text cannot contradict it. */
export function effortSentence(m: ModelsTable): string {
  const set = m.filter(r => isSet(r.effort)), unset = m.filter(r => !isSet(r.effort));
  const parts: string[] = [];
  if (set.length) parts.push(`We set the reasoning effort explicitly for the configurations that run through a vendor command-line client on a subscription, because those clients need an explicit setting. The value is the one we recorded as the vendor's default for that model: ${set.map(r => `${baseName(r.id)}: ${r.effort}`).join(', ')}.`);
  if (unset.length) parts.push(`For the router configurations we did not set an effort, so the provider default applied: ${unset.map(r => baseName(r.id)).join(', ')}.`);
  parts.push('The settings are not equal across vendors.');
  const byVendor = new Map<string, Set<string>>();
  for (const r of set) byVendor.set(r.vendor, (byVendor.get(r.vendor) ?? new Set()).add(r.effort));
  for (const [v, es] of byVendor) if (es.size > 1) parts.push(`The ${v} configurations ran at different efforts (${[...es].join(' and ')}), so a comparison between them is partly a comparison of effort.`);
  return parts.join(' ');
}

/** Configurations served from a quantized endpoint, as the provider pin shows. Empty when none. */
/** The quantized endpoints, for the short note. */
export function quantizedRows(m: ModelsTable): { name: string; kind: string; noReasoning: boolean }[] {
  return m.filter(r => /fp8|fp4|int8|int4|bf8/i.test(r.pin)).map(r => ({ name: baseName(r.id), kind: /(fp8|fp4|int8|int4|bf8)/i.exec(r.pin)![1]!.toLowerCase(), noReasoning: r.id.startsWith('deepseek/deepseek-v4-pro') }));
}
export function quantizedSentence(m: ModelsTable): string {
  const q = m.filter(r => /fp8|fp4|int8|int4|bf8/i.test(r.pin));
  if (!q.length) return '';
  const fmt = (r: ModelsTable[number]) => /(fp8|fp4|int8|int4|bf8)/i.exec(r.pin)![1]!.toLowerCase();
  return `${q.map(r => `${shortName(r.id)} ran on a quantized (${fmt(r)}) endpoint of its pinned provider`).join('. ')}. This breaks our own rule against quantized variants. ${q.length === 1 ? 'Its results' : 'Their results'} may be lower than the model gives at full precision.${q.some(r => r.id.startsWith('deepseek/deepseek-v4-pro')) ? ' deepseek-v4-pro · default also returned no reasoning tokens: 0 in each of the 22 answers of run 1 and of run 4. Its results describe this endpoint, which did not reason.' : ''}`;
}

/** Rows for the given configurations, in that order; a configuration without a record shows "not recorded". */
export function modelsTable(m: ModelsTable, ids: string[], runs = 3): string {
  const idx = Array.from({ length: runs }, (_, i) => i);
  const trs = ids.map(id => {
    const r = m.find(x => x.id === id);
    const cells = r ? [r.vendor, r.called, r.access, effort(r.effort), r.pin, ...idx.map(i => r.runs[i] ?? NR)] : Array(5 + runs).fill(NR);
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
const names = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
export function fairnessSentence(m: ModelsTable): string {
  const set = m.filter(r => isSet(r.effort)), levels = [...new Set(set.map(r => r.effort))].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b));
  const vendors = [...new Set(set.map(r => r.vendor))];
  const segs = levels.map((lv, i) => {
    const groups = vendors.map(v => ({ v, all: set.filter(r => r.vendor === v), at: set.filter(r => r.vendor === v && r.effort === lv) })).filter(g => g.at.length);
    groups.sort((a, b) => Number(b.at.length === b.all.length) - Number(a.at.length === a.all.length));
    const who = groups.map(g => (g.at.length === g.all.length ? `the ${g.v} models` : names(g.at.map(r => baseName(r.id))))).join(' and ');
    return `${who}${i === 0 ? ' ran' : ''} at ${lv}`;
  });
  if (m.some(r => !isSet(r.effort))) segs.push('the router models at the provider default');
  const list = segs.length > 2 ? `${segs.slice(0, -1).join(', ')}, and ${segs.at(-1)}` : segs.join(' and ');
  return `The effort levels differ between vendors in this release: ${list}. This is not an equal comparison. Rows at matching effort levels are being added.`;
}
/** Next to the ranking: what a row is, what "default" means (only when a row has it), and the fairness statement. */
export function effortNotes(m: ModelsTable, row: string): string {
  const dflt = m.some(r => !isSet(r.effort)) ? ' Effort "default" means that we set no effort (router access), so the provider default applied. The models table records this.' : '';
  return `${row}${dflt} ${fairnessSentence(m)}`;
}
