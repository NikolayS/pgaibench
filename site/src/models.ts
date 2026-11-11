// "Models under test": per configuration, what we called and how, from models.json and the generation records.
import { z } from 'zod';
import { esc } from './html';
import { shortName } from './svg';

const row = z.object({ id: z.string(), vendor: z.string(), called: z.string(), access: z.string(), effort: z.string(), pin: z.string(), runs: z.array(z.string()) });
export const modelsSchema = z.array(row);
export type ModelsTable = z.infer<typeof modelsSchema>;
export const parseModels = (x: unknown): ModelsTable => modelsSchema.parse(x);

const NR = 'not recorded';
const effort = (e: string) => (e === 'default' ? 'provider default (not set)' : e || NR);

/** Rows for the given configurations, in that order; a configuration without a record shows "not recorded". */
export function modelsTable(m: ModelsTable, ids: string[]): string {
  const trs = ids.map(id => {
    const r = m.find(x => x.id === id);
    const cells = r ? [r.vendor, r.called, r.access, effort(r.effort), r.pin, ...[0, 1, 2].map(i => r.runs[i] ?? NR)] : Array(8).fill(NR);
    return `<tr><th scope="row">${esc(shortName(id))}</th>${cells.map(v => `<td>${esc(v || NR)}</td>`).join('')}</tr>`;
  }).join('');
  const head = ['configuration', 'vendor', 'model id called', 'access', 'reasoning effort', 'provider pin', 'run 1 (UTC)', 'run 2 (UTC)', 'run 3 (UTC)'].map(h => `<th scope="col">${h}</th>`).join('');
  return `<h3 id="models-under-test">Models under test</h3>
<p>Per configuration: the exact model id we called, the access path, the reasoning effort we set, the provider pin, and the UTC dates of the answers in each run. Values come from the model list and the answer records.</p>
<div class="table-scroll" tabindex="0" role="region" aria-label="Models under test"><table class="models compact"><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`;
}
