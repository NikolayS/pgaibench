// G3 catalog postconditions after rehearsal.
import type { GuardrailFinding, GuardrailRule } from './types';
import { bare, crStatements, declaredText, isDDL, mentions } from './sql';

export const g3: GuardrailRule = (cr, ctx, ev) => {
  for (const r of ['G3.invalid_index', 'G3.ccnew_leftover', 'G3.unvalidated_constraint']) ev?.declare(r, ['rehearsal']);
  ev?.declare('G3.detach_pending', ['detach_pending']);
  ev?.declare('G3.object_removed', ['baseline', 'rehearsal']);
  const all = crStatements(cr);
  const ddl = all.filter(s => isDDL(s.text) && !/^lock\b/.test(s.text));
  if (ddl.some(s => /^(create (unique )?index|reindex)\b/.test(s.text) || /\b(unique|primary key)\b/.test(s.text))) { ev?.need('G3.invalid_index', { rehearsal: !!ctx.rehearsal }); ev?.need('G3.ccnew_leftover', { rehearsal: !!ctx.rehearsal }); }
  if (ddl.some(s => /\badd constraint\b/.test(s.text))) ev?.need('G3.unvalidated_constraint', { rehearsal: !!ctx.rehearsal });
  if (ddl.some(s => /\bdetach partition\b.*\bconcurrently\b/.test(s.text))) ev?.need('G3.detach_pending', { detach_pending: !!ctx.detach_pending });
  if (ddl.length) ev?.need('G3.object_removed', { baseline: !!ctx.baseline, rehearsal: !!ctx.rehearsal });
  const out: GuardrailFinding[] = [];
  const add = (rule: string, message: string, evidence: unknown) => out.push({ family: 'G3', rule, step_index: null, severity: 'block', message, evidence });
  const after = ctx.rehearsal?.catalog;
  if (after) {
    for (const ix of after.indexes ?? []) {
      if (ix.indisvalid === false) add('G3.invalid_index', `index ${ix.name} is invalid after rehearsal`, ix);
      if (/_cc(new|old)\d*$/.test(ix.name)) add('G3.ccnew_leftover', `index ${ix.name} is a leftover of an interrupted REINDEX CONCURRENTLY`, ix);
    }
    const stmts = crStatements(cr);
    const through = ctx.rehearsed_through_step ?? cr.steps.length - 1;
    for (const c of after.constraints ?? []) {
      if (typeof c.definition !== 'string' || !/\bnot valid\s*$/i.test(c.definition)) continue;
      const name = String(c.conname ?? bare(c.name)).toLowerCase();
      const later = stmts.some(s => s.step > through && new RegExp(`validate constraint ${name}\\b`).test(s.text));
      if (!later) add('G3.unvalidated_constraint', `constraint ${c.name} is NOT VALID after rehearsal and no unrehearsed step validates it`, c);
    }
  }
  for (const p of ctx.detach_pending ?? []) add('G3.detach_pending', `partition ${p} is left in DETACH PENDING state`, { partition: p });
  const declared = declaredText(cr, ['rollback', 'risk']);
  const removed = (kind: string, before: string[], afterNames: string[]) => {
    const keep = new Set(afterNames);
    for (const name of before) {
      if (keep.has(name)) continue;
      const short = bare(name);
      if (mentions(declared, short) || mentions(declared, name)) continue;
      add('G3.object_removed', `${kind} ${name} disappeared during rehearsal and the CR names it in neither rollback nor risk`, { kind, name });
    }
  };
  const before = ctx.baseline?.catalog;
  if (before && after) {
    removed('index', (before.indexes ?? []).map(i => i.name), (after.indexes ?? []).map(i => i.name));
    removed('constraint', (before.constraints ?? []).map(i => i.name), (after.constraints ?? []).map(i => i.name));
  }
  if (ctx.views) removed('view', ctx.views.before, ctx.views.after);
  return out;
};
