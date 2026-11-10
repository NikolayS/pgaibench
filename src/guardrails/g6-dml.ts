// G6 DML scope: expected row counts, predicate shape, lossy casts.
import type { GuardrailFinding, GuardrailRule } from './types';
import { crStatements, dmlParts, type Token } from './sql';

const LOSSY_TARGET = /^(timestamp(?!tz)(?! with time zone)|float[48]?|real|double precision|(?:varchar|character varying|char|character|bpchar) \( \d+ \))/;

/** Tokens of the top-level clause starting at keyword `from` until one of `until` at depth 0. */
function clause(tokens: Token[], start: string, until: string[]): Token[] | null {
  let depth = 0, i = -1;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.v === '(') depth++; else if (t.v === ')') depth--;
    else if (depth === 0 && t.kind === 'word' && t.v === start) { i = k + 1; break; }
  }
  if (i < 0) return null;
  const out: Token[] = [];
  depth = 0;
  for (let k = i; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.v === '(') depth++; else if (t.v === ')') depth--;
    if (depth === 0 && t.kind === 'word' && until.includes(t.v)) break;
    out.push(t);
  }
  return out;
}

export function mixedAndOr(where: Token[]): boolean {
  let depth = 0, and = false, or = false, between = false;
  for (const t of where) {
    if (t.v === '(') depth++; else if (t.v === ')') depth--;
    else if (depth === 0 && t.kind === 'word') {
      if (t.v === 'between') between = true;
      else if (t.v === 'and') { if (between) between = false; else and = true; }
      else if (t.v === 'or') or = true;
    }
  }
  return and && or;
}

export function tautology(where: Token[]): string | null {
  if (where.length === 1 && where[0].v === 'true') return 'true';
  for (let k = 0; k + 2 < where.length; k++) {
    const [a, op, b] = [where[k], where[k + 1], where[k + 2]];
    if (op.kind === 'punct' && ['=', '>=', '<='].includes(op.v) && a.kind === b.kind && a.v === b.v && ['word', 'num', 'str', 'qident'].includes(a.kind)) {
      const prev = where[k - 1], next = where[k + 3];
      if ((prev && (prev.v === '.' || prev.v === '::')) || (next && (next.v === '.' || next.v === '(' || next.v === '::'))) continue;
      return `${a.v} ${op.v} ${b.v}`;
    }
    if (op.v === 'or' && a.kind !== 'punct' && b.v === 'true' && (!where[k + 3] || where[k + 3].v === ')' || where[k + 3].v === 'or')) return 'or true';
  }
  return null;
}

export function lossyCasts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/:: ([a-z ]+?(?: \( \d+ \))?)(?= |$|,|\))/g)) if (LOSSY_TARGET.test(m[1].trim())) out.push(m[1].trim());
  for (const m of text.matchAll(/\bcast \(.*? as ([a-z ]+?(?: \( \d+ \))?) \)/g)) if (LOSSY_TARGET.test(m[1].trim())) out.push(m[1].trim());
  return out;
}

export const g6: GuardrailRule = (cr, ctx, ev) => {
  for (const r of ['G6.expected_rows_missing', 'G6.no_where', 'G6.mixed_and_or', 'G6.tautology']) ev?.declare(r);
  ev?.declare('G6.rows_deviation', ['steps[i].rows_affected']);
  ev?.declare('G6.lossy_cast', [], false);
  const out: GuardrailFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, step: number, severity: 'block' | 'warn', message: string, evidence: unknown) => {
    const k = `${rule}@${step}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ family: 'G6', rule, step_index: step, severity, message, evidence });
  };
  for (const s of crStatements(cr)) {
    const step = cr.steps[s.step];
    const expected = 'expected_rows' in step ? step.expected_rows : undefined;
    for (const p of dmlParts(s.tokens)) {
      // Plain INSERT ... VALUES and ON CONFLICT DO NOTHING have no predicate and a known row count.
      if (p.verb === 'insert' && !p.insertSelect && !p.upsert) continue;
      for (const r of ['G6.expected_rows_missing', 'G6.no_where', 'G6.mixed_and_or', 'G6.tautology']) ev?.ran(r);
      const label = p.verb === 'insert' ? (p.upsert ? 'INSERT ... ON CONFLICT DO UPDATE' : 'INSERT ... SELECT') : p.verb.toUpperCase();
      if (expected === undefined) add('G6.expected_rows_missing', s.step, 'block', `${label} step has no expected_rows`, { statement: s.text });
      let pred: Token[] | null = null;
      if (p.verb === 'update' || p.verb === 'delete') {
        pred = clause(p.tokens, 'where', ['returning']);
        if (!pred || !pred.length) add('G6.no_where', s.step, 'block', `${label} without WHERE touches every row`, { statement: s.text });
      } else if (p.verb === 'merge') pred = clause(p.tokens, 'on', ['when']);
      else if (p.upsert) pred = clause(p.tokens.slice(p.tokens.findIndex(t => t.v === 'conflict')), 'where', ['returning']);
      if (pred && pred.length) {
        if (mixedAndOr(pred)) add('G6.mixed_and_or', s.step, 'block', `${label} predicate mixes AND and OR without parentheses`, { statement: s.text });
        const t = tautology(pred);
        if (t) add('G6.tautology', s.step, 'block', `${label} predicate contains a tautology: ${t}`, { statement: s.text, tautology: t });
      }
      if (expected !== undefined) {
        const actual = ctx.steps?.[s.step]?.rows_affected;
        if (ev?.need('G6.rows_deviation', { 'steps[i].rows_affected': actual !== undefined }) || actual !== undefined) {
          const dev = expected === 0 ? (actual === 0 ? 0 : Infinity) : Math.abs(actual! - expected) / expected;
          if (dev > 0.1) add('G6.rows_deviation', s.step, 'block', `rehearsal affected ${actual} rows, expected ${expected} (deviation above 10 percent)`, { expected, actual });
        }
      }
      if (p.verb === 'update') {
        const set = clause(p.tokens, 'set', ['where', 'from', 'returning']);
        const casts = set ? lossyCasts(set.map(t => t.v).join(' ')) : [];
        if (casts.length) add('G6.lossy_cast', s.step, 'warn', `UPDATE SET uses a lossy cast to ${casts.join(', ')}`, { statement: s.text, casts });
      }
    }
    if (/^alter table\b/.test(s.text)) {
      for (const m of s.text.matchAll(/alter column (\S+) (?:set data )?type ([a-z ]+?(?: \( \d+ \))?)(?= using| collate|,|$)/g)) {
        const table = /^alter table (?:if exists )?(?:only )?(\S+)/.exec(s.text)![1].split('.').pop()!;
        const source = ctx.column_types?.[`${table}.${m[1]}`]?.toLowerCase().replace(/\s+/g, ' ');
        const target = m[2].trim();
        if (!LOSSY_TARGET.test(target)) continue;
        if (source && !lossyFrom(source, target)) continue;
        add('G6.lossy_cast', s.step, 'warn', `ALTER COLUMN ${m[1]} TYPE ${target} may lose data${source ? ` (from ${source})` : ' (source type unknown)'}`, { statement: s.text, column: m[1], source: source ?? null, target });
      }
    }
  }
  return out;
};

function lossyFrom(source: string, target: string): boolean {
  if (/^timestamp/.test(target)) return /timestamptz|with time zone/.test(source);
  if (/^(float|real|double)/.test(target)) return /^(numeric|decimal|bigint|int8)/.test(source);
  const n = /\( (\d+) \)/.exec(target)?.[1];
  const sn = /\((\d+)\)|\( (\d+) \)/.exec(source);
  if (/^(text|varchar$|character varying$)/.test(source)) return true;
  return sn ? Number(n) < Number(sn[1] ?? sn[2]) : true;
}
