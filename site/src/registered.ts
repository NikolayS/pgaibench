// Scores under the registered pending-review bullet (prereg section 13): only run 1 has reader
// classes; a pending cell of a later run scores 0, not done. The published averages use reader
// classes in every run. This table puts both side by side; the published values do not change.
import { esc } from './html';
import { fmtDiff, fmtScore, type Pooled } from './pooled';
import { labelOf } from './results';

const place = (p: number | null) => (p === null ? 'no place' : String(p));
const num2 = (v: number) => String(Math.round(v * 100) / 100);

export const REGISTERED_LEDE = 'Scores under the registered rule for pending cells. Before runs 2 and 3, section 13 of the preregistration said that only run 1 has reader classes and that a pending cell of a later run scores 0 points and is not done. A later bullet says the reader classes apply to every run, and the published averages use them. The table shows both. The published numbers are the left columns; which one is the headline is open for the next release.';

/** Which rows have no value under the registered rule, by name, from the two tables. */
export function dashLine(pub: Pooled, by: Map<string, unknown>): string {
  const dash = pub.rows.filter(r => !by.has(r.id)).map(r => labelOf(r.id));
  const list = dash.length > 1 ? `${dash.slice(0, -1).join(', ')} and ${dash.at(-1)}` : dash[0] ?? '';
  return dash.length ? `A dash: not computed under this rule. ${dash.length === 1 ? 'One row' : `${dash.length} rows`}: ${list}.` : '';
}

export function registeredTable(pub: Pooled, reg: Pooled): string {
  const by = new Map(reg.rows.map(r => [r.id, r]));
  const rows = [...pub.rows].sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.score - a.score).map(r => {
    const g = by.get(r.id);
    return `<tr><th scope="row">${esc(labelOf(r.id))}</th><td class="num">${fmtScore(r.score)}</td><td class="num">${place(r.place)}</td><td class="num">${num2(r.done)}</td><td class="num">${g ? fmtScore(g.score) : '-'}</td><td class="num">${g ? place(g.place) : '-'}</td><td class="num">${g ? num2(g.done) : '-'}</td></tr>`;
  }).join('');
  const eff = pub.effort.flatMap(a => a.rows).map(r => {
    const g = reg.effort.flatMap(a => a.rows).find(x => x.id === r.id);
    return r.paired && g?.paired ? `<li>${esc(labelOf(r.id))}: difference to the ranked row of the same model ${fmtDiff(r.paired.diff)} published, ${fmtDiff(g.paired.diff)} [${fmtDiff(g.paired.lo)} to ${fmtDiff(g.paired.hi)}] under the registered rule.</li>` : '';
  }).join('');
  return `<h3 id="registered-rule">Scores under the registered rule for pending cells</h3><p>${esc(REGISTERED_LEDE)}</p>
<p>${esc(dashLine(pub, by))} Places on the right count only the rows with values, so they are not comparable with the places on the left.</p>
<div class="table-scroll" tabindex="0" role="region" aria-label="Registered rule"><table><thead><tr><th scope="col">configuration</th><th scope="col" class="num">score</th><th scope="col" class="num">place</th><th scope="col" class="num">done</th><th scope="col" class="num">score, registered</th><th scope="col" class="num">place, registered</th><th scope="col" class="num">done, registered</th></tr></thead><tbody>${rows}</tbody></table></div>${eff ? `<ul class="notes">${eff}</ul>` : ''}`;
}
