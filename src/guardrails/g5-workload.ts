// G5 workload dependency: dropped, renamed or retyped identifiers that
// workload queries, views, functions or pg_depend dependents still reference.
import type { GuardrailFinding, GuardrailRule } from './types';
import { bare, crStatements, lookup, mentions, normIdent } from './sql';

export type Ident = { name: string; table?: string; action: 'drop' | 'rename' | 'retype' };

export function changedIdents(text: string): Ident[] {
  const out: Ident[] = [];
  let m = /^drop (?:table|index|view|materialized view|function|procedure|type|domain|sequence) (?:concurrently )?(?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(text);
  if (m) {
    for (const n of m[1].replace(/\([^)]*\)/g, ' ').split(',')) { const w = n.trim().split(/\s+/)[0]; if (w) out.push({ name: bare(w), action: 'drop' }); }
    return out;
  }
  m = /^alter table (?:if exists )?(?:only )?(\S+) (.*)$/.exec(text);
  if (m) {
    const table = bare(m[1]);
    const rest = m[2];
    if (/^rename to \S+$/.test(rest)) return [{ name: table, action: 'rename' }];
    for (const x of rest.matchAll(/\bdrop column (?:if exists )?(\S+)/g)) out.push({ name: bare(x[1]), table, action: 'drop' });
    for (const x of rest.matchAll(/\brename (?:column )?(?!to\b|constraint\b)(\S+) to\b/g)) out.push({ name: bare(x[1]), table, action: 'rename' });
    for (const x of rest.matchAll(/\balter column (\S+) (?:set data )?type\b/g)) out.push({ name: bare(x[1]), table, action: 'retype' });
    return out;
  }
  m = /^alter (?:index|view|materialized view|function|procedure|type|sequence) (?:if exists )?(\S+)(?: \([^)]*\))? rename to\b/.exec(text);
  if (m) out.push({ name: bare(m[1]), action: 'rename' });
  return out;
}

/** True when a later statement re-creates the changed name (expand/contract: compat column, view or table). */
function recreated(id: Ident, at: number, texts: { text: string; order: number }[]): boolean {
  const n = id.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = id.table
    ? new RegExp(`^alter table (?:if exists )?(?:only )?\\S*\\b${id.table}\\b .*\\badd (?:column )?(?:if not exists )?${n}\\b`)
    : new RegExp(`^create (?:or replace )?(?:unique )?(?:materialized )?(?:view|table|index|function|procedure|type|domain|sequence) (?:concurrently )?(?:if not exists )?(?:\\S+\\.)?${n}\\b`);
  return texts.some(s => s.order > at && re.test(s.text));
}

export const g5: GuardrailRule = (cr, ctx, ev) => {
  ev?.declare('G5.workload_dependency', ['workload_texts', 'pgss_texts', 'dependents']);
  ev?.declare('G5.cascade_without_dependents');
  const out: GuardrailFinding[] = [];
  const stmts = crStatements(cr);
  const verifyQueries = cr.postconditions.filter(p => /^\s*(select|with)\b/i.test(p)).map(normIdent);
  for (const s of stmts) {
    if (/^drop .*\bcascade$/.test(s.text)) ev?.ran('G5.cascade_without_dependents');
    const idents = changedIdents(s.text);
    if (idents.length) ev?.need('G5.workload_dependency', { workload_texts: !!ctx.workload_texts, pgss_texts: !!ctx.pgss_texts, dependents: !!ctx.dependents });
    const otherSql = stmts.filter(x => x.order !== s.order).map(x => x.text);
    for (const id of idents) {
      const found = (text: string) => { const t = normIdent(text); return mentions(t, id.name) && (!id.table || mentions(t, id.table)); };
      const hits: { source: string; label: string }[] = [];
      for (const [shape, text] of Object.entries(ctx.workload_texts ?? {})) if (found(text)) hits.push({ source: 'workload', label: shape });
      if ((ctx.pgss_texts ?? []).some(found)) hits.push({ source: 'pg_stat_statements', label: 'pg_stat_statements' });
      for (const [name, def] of Object.entries(ctx.definitions ?? {})) if (bare(name) !== id.name && found(def)) hits.push({ source: 'definition', label: bare(name) });
      const deps = [...(lookup(ctx.dependents, id.name) ?? []), ...(id.table ? lookup(ctx.dependents, `${id.table}.${id.name}`) ?? [] : [])];
      for (const d of deps) hits.push({ source: 'pg_depend', label: bare(d) });
      if (!hits.length || recreated(id, s.order, stmts)) continue;
      // Mention is not acceptance: a dependent counts as handled only when a CR
      // step names it (dropped, recreated, migrated) or a postcondition query verifies it.
      const cascade = /^drop .*\bcascade$/.test(s.text);
      const handled = (h: { source: string; label: string }) => h.source !== 'workload' && h.source !== 'pg_stat_statements' && (cascade || otherSql.some(x => mentions(x, h.label)) || verifyQueries.some(q => mentions(q, h.label)));
      const open = hits.filter(h => !handled(h));
      if (open.length) out.push({ family: 'G5', rule: 'G5.workload_dependency', step_index: s.step, severity: 'block', message: `${id.action} of ${id.table ? `${id.table}.` : ''}${id.name} breaks ${open.map(h => `${h.source}:${h.label}`).join(', ')}; no CR step drops, recreates or migrates the dependent, no postcondition query verifies it, and the old name is not kept`, evidence: { ident: id, hits: open } });
    }
    if (/^drop .*\bcascade$/.test(s.text)) {
      const enumerated = cr.claims.some(c => /pg_depend/i.test(c.verify_sql) || /dependen/i.test(c.text));
      if (!enumerated) out.push({ family: 'G5', rule: 'G5.cascade_without_dependents', step_index: s.step, severity: 'block', message: 'DROP ... CASCADE without a claim that enumerates the pg_depend dependents', evidence: { statement: s.text } });
    }
  }
  return out;
};
