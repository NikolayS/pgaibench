// Outcome profile: one stacked bar per model over all scored tasks (public
// and held-out), from lab outcomes only. Segments in a fixed order, best to
// worst, then unknown; each class has its own fill character, so colour is
// never needed. No composite score, no ordering by any class: models are in
// alphabetical order inside a track, tracks are not compared.
import { PROFILE_CLASSES, PROFILE_GROUP, PROFILE_LABEL, profileClass, type ProfileClass } from '../../src/analysis/outcome-map';
import { harmOf, type Cell } from './cells';
import { esc } from './html';
import { labelOf, type Results } from './results';
import type { Provisional } from './provisional';

/** Fill characters: distinct without colour. Harm is '!'; unknown classes look empty or dotted. */
export const PROFILE_CHAR: Record<ProfileClass, string> = {
  right: '█', correct_refusal: '▓', over_cautious: '▒', ineffective: '░', stopped_at_rehearsal: '=', risky_pattern: '-', harmful_lab: '!',
  pending_review: '?', invalid_answer: 'x', unscorable: '_', rerun: '·', under_review: ':', not_run: '.',
};
export const PER_TASK = 2;
export const profileNote = (tasks: number) => `Each bar is one model's ${tasks} tasks. We do not combine these classes into one score: the classes differ in cost, and at this sample size models are not separated.`;

export type ProfileRow = { model_id: string; counts: Record<ProfileClass, number> };
export type ProfileTrack = { name: string; rows: ProfileRow[] };

const zero = () => Object.fromEntries(PROFILE_CLASSES.map(k => [k, 0])) as Record<ProfileClass, number>;

/** Profiles per track. Provisional: from provisional.json (lab status per public cell). Final: from the lab cell records. */
export function profiles(res: Results, cells: Cell[] | null, prov: Provisional | null): { tasks: number; tracks: ProfileTrack[] } {
  const tasks = res.public_tasks + res.heldout_tasks;
  const tracks = res.tracks.map(t => {
    const labRows = t.lab?.rows ?? [];
    const models = [...new Set((prov ? [...(t.text?.rows ?? []), ...labRows] : labRows).map(r => r.model_id))].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    const rows = models.map(m => {
      const counts = zero();
      let pub = 0;
      if (prov) for (const x of prov.cells.filter(c => c.model_id === m)) {
        const st = x.lab?.status ?? 'not_run';
        counts[st === 'scored' && x.lab?.outcome ? profileClass(x.lab.outcome, x.lab.harm) : st === 'rerun' ? 'rerun' : st === 'under_review' ? 'under_review' : 'not_run']++; pub++;
      }
      else for (const c of (cells ?? []).filter(c => c.model_id === m && c.scored_by === 'lab' && c.sample === 1)) { counts[profileClass(c.outcome, harmOf(c))]++; pub++; }
      counts.not_run += Math.max(0, res.public_tasks - pub);
      const h = labRows.find(r => r.model_id === m)?.heldout;
      const prof = h && h.tasks === res.heldout_tasks && h.profile ? h.profile : null;
      if (prof) for (const [k, v] of Object.entries(prof)) counts[k as ProfileClass] += v!;
      else counts.not_run += res.heldout_tasks;
      return { model_id: m, counts };
    });
    return { name: t.name, rows };
  }).filter(t => t.rows.length);
  return { tasks, tracks };
}

export function profileBar(counts: Record<ProfileClass, number>): string {
  return PROFILE_CLASSES.map(k => PROFILE_CHAR[k].repeat(counts[k] * PER_TASK)).join('');
}
const countsText = (counts: Record<ProfileClass, number>) => PROFILE_CLASSES.filter(k => counts[k]).map(k => `${PROFILE_CHAR[k]}${counts[k]}`).join(' ');

/** The chart (aria-hidden <pre>), a text alternative, and a table with the same numbers. */
const SHORT: Record<ProfileClass, string> = {
  right: 'right', correct_refusal: 'refu', over_cautious: 'esc', ineffective: 'inef', stopped_at_rehearsal: 'stop', risky_pattern: 'risk', harmful_lab: 'harm',
  invalid_answer: 'inv', unscorable: 'n/a', pending_review: 'rev', rerun: 'rerun', under_review: 'urev', not_run: 'notrun',
};
const MARK = { good: '+', bad: '-', 'not known yet': '.' } as const;
const DIRW = { good: 'higher is better', bad: 'lower is better', 'not known yet': 'not a quality measure' } as const;
export const PROFILE_GROUPS = ['good', 'bad', 'not known yet'] as const;

export function profileChart(p: { tasks: number; tracks: ProfileTrack[] }, o: { id: string; table: boolean; lede: string }): string {
  const W = Math.min(22, Math.max(8, ...p.tracks.flatMap(t => t.rows.map(r => labelOf(r.model_id).length))));
  const lines: string[] = [];
  for (const t of p.tracks) {
    lines.push(`-- Track: ${t.name} --`);
    for (const r of t.rows) lines.push(`${labelOf(r.model_id).slice(0, W).padEnd(W)} |${profileBar(r.counts)}|`, `${' '.repeat(W + 2)}${countsText(r.counts)}`);
    lines.push('');
  }
  const scale = `${' '.repeat(W + 2)}${Array.from({ length: p.tasks }, (_, i) => (i % 5 === 0 ? '+' : '-') + '-'.repeat(PER_TASK - 1)).join('')}+`;
  let ticks = ' '.repeat(W + 2);
  for (let i = 0; i <= p.tasks; i += 5) ticks = ticks.padEnd(W + 2 + i * PER_TASK) + String(i);
  const legendText = PROFILE_GROUPS.map(g => `${g}:\n${PROFILE_CLASSES.filter(k => PROFILE_GROUP[k] === g).map(k => `  ${PROFILE_CHAR[k]} ${PROFILE_LABEL[k]}`).join('\n')}`).join('\n');
  const title = `Outcome profile: what happened to each of the ${p.tasks} tasks (neither is better: context)`;
  const alt = p.tracks.map(t => `Track ${t.name}: ${t.rows.map(r => `${labelOf(r.model_id)}: ${PROFILE_CLASSES.filter(k => r.counts[k]).map(k => `${PROFILE_LABEL[k]} ${r.counts[k]}`).join(', ')}`).join('; ')}.`).join(' ');
  const part = (classes: ProfileClass[], label: string) => {
    const head = classes.map((k, i) => `<th scope="col" class="num${i > 0 && PROFILE_GROUP[k] !== PROFILE_GROUP[classes[i - 1]!] ? ' sep' : ''}" title="${esc(`${PROFILE_LABEL[k]} (${DIRW[PROFILE_GROUP[k]]})`)}"><abbr title="${esc(PROFILE_LABEL[k])}">${esc(SHORT[k])}</abbr>${MARK[PROFILE_GROUP[k]]}</th>`).join('');
    const body = p.tracks.map(t => `<tr><th scope="rowgroup" colspan="${classes.length + 1}">Track: ${esc(t.name)}</th></tr>${t.rows.map(r => `<tr><th scope="row">${esc(labelOf(r.model_id))}</th>${classes.map((k, i) => `<td class="num${i > 0 && PROFILE_GROUP[k] !== PROFILE_GROUP[classes[i - 1]!] ? ' sep' : ''}" data-class="${k}">${r.counts[k]}</td>`).join('')}</tr>`).join('')}`).join('');
    return `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(title)}, ${label}"><p class="scroll-hint">(wide table: scroll sideways)</p><table class="profile" data-chart-for="${o.id}"><thead><tr><th scope="col">model</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  const leg = `<ul class="legend">${PROFILE_CLASSES.map(k => `<li><code>${esc(SHORT[k])}${MARK[PROFILE_GROUP[k]]}</code> ${esc(PROFILE_LABEL[k])} (${PROFILE_GROUP[k]}: ${DIRW[PROFILE_GROUP[k]]})</li>`).join('')}</ul>`;
  const table = o.table ? `${leg}${part(PROFILE_CLASSES.filter(k => PROFILE_GROUP[k] !== 'not known yet'), 'counted')}${part(PROFILE_CLASSES.filter(k => PROFILE_GROUP[k] === 'not known yet'), 'not known yet')}` : '';
  return `<figure class="profile" id="${o.id}"><figcaption><b>${esc(title)}</b></figcaption><p>${o.lede}</p>
<pre class="profile-chart" aria-hidden="true">${esc(lines.join('\n'))}${esc(scale)}\n${esc(ticks)}\n${' '.repeat(W + 2)}tasks, linear from zero, ${PER_TASK} characters per task\n\n${esc(legendText)}</pre>
<p class="sr">${esc(title)}. ${esc(alt)}</p>
<p>${esc(profileNote(p.tasks))}</p>${table}</figure>`;
}
