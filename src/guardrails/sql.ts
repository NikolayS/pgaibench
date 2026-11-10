// Small SQL tokenizer for guardrails. It is not a parser: it removes comments,
// keeps quoted text intact, lowercases words, and splits on top-level
// semicolons.
import type { CR } from '../schema/types';

export type Token = { kind: 'word' | 'str' | 'qident' | 'num' | 'dollar' | 'punct'; v: string };
export type Statement = { tokens: Token[]; text: string };
export type CRStatement = Statement & { step: number; nested: boolean; order: number };

const OPS = ['::', '<=', '>=', '<>', '!=', '||', '=>'];

export function lex(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; }
      out.push({ kind: 'str', v: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (sql[j] === '"' && sql[j + 1] === '"') j += 2; else if (sql[j] === '"') break; else j++; }
      out.push({ kind: 'qident', v: sql.slice(i + 1, j).replace(/""/g, '"') }); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end + tag.length;
        out.push({ kind: 'dollar', v: sql.slice(i, stop) }); i = stop; continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?/i.exec(sql.slice(i))!;
      // "1..5" in plpgsql for-loops: stop the number before "..".
      const v = sql.slice(i).startsWith('..') ? '.' : m[0].replace(/\.$/, '');
      out.push({ kind: 'num', v }); i += Math.max(1, v.length); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]*"))*/.exec(sql.slice(i))!;
      out.push({ kind: 'word', v: m[0].toLowerCase().replace(/"/g, '') }); i += m[0].length; continue;
    }
    const op = OPS.find(o => sql.startsWith(o, i));
    if (op) { out.push({ kind: 'punct', v: op }); i += op.length; continue; }
    out.push({ kind: 'punct', v: c }); i++;
  }
  return mergeDotted(out);
}

const isIdent = (t: Token | undefined) => !!t && (t.kind === 'word' || t.kind === 'qident');
const identText = (t: Token) => t.kind === 'qident' ? t.v.toLowerCase() : t.v;

/** Join qualified names ("public"."orders", "public".orders, public . orders) into one lowercased word token. */
function mergeDotted(ts: Token[]): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    if (!isIdent(t) || !(ts[k + 1]?.kind === 'punct' && ts[k + 1].v === '.' && isIdent(ts[k + 2]))) { out.push(t); continue; }
    let v = identText(t);
    while (ts[k + 1]?.kind === 'punct' && ts[k + 1].v === '.' && isIdent(ts[k + 2])) { v += '.' + identText(ts[k + 2]); k += 2; }
    out.push({ kind: 'word', v });
  }
  return out;
}

/** Normalize an identifier or SQL text for name matching: lowercase, no double quotes. */
export const normIdent = (s: string) => s.replace(/"/g, '').toLowerCase();

function plain(tokens: Token[]): string {
  return tokens.map(t => t.kind === 'qident' ? t.v.toLowerCase() : t.v).join(' ');
}

export function splitStatements(tokens: Token[]): Statement[] {
  const out: Statement[] = [];
  let cur: Token[] = [];
  let depth = 0;
  const flush = () => { if (cur.length) out.push({ tokens: cur, text: plain(cur) }); cur = []; };
  for (const t of tokens) {
    if (t.kind === 'punct' && t.v === '(') depth++;
    if (t.kind === 'punct' && t.v === ')') depth = Math.max(0, depth - 1);
    if (t.kind === 'punct' && t.v === ';' && depth === 0) { flush(); continue; }
    cur.push(t);
  }
  flush();
  return out;
}

export function statements(sql: string): Statement[] {
  return splitStatements(lex(sql));
}

const NESTED_START = new Set(['alter', 'create', 'drop', 'reindex', 'cluster', 'vacuum', 'truncate', 'update', 'delete', 'insert', 'set', 'reset', 'perform', 'select', 'validate', 'with', 'copy', 'merge', 'lock']);

/** Body statements of a DO block, trimmed to start at a SQL keyword. */
function doBody(stmt: Statement): Statement[] {
  if (stmt.tokens[0]?.v !== 'do') return [];
  const body = stmt.tokens.find(t => t.kind === 'dollar');
  if (!body) return [];
  const tag = /^\$[A-Za-z0-9_]*\$/.exec(body.v)![0];
  const inner = body.v.slice(tag.length, body.v.endsWith(tag) && body.v.length >= 2 * tag.length ? body.v.length - tag.length : body.v.length);
  return statements(inner).flatMap(s => {
    const k = s.tokens.findIndex(t => t.kind === 'word' && NESTED_START.has(t.v));
    if (k < 0) return [];
    const tokens = s.tokens.slice(k);
    return [{ tokens, text: plain(tokens) }];
  });
}

/** All statements of SQL steps in execution order, with DO-block bodies expanded after their DO statement. */
export function crStatements(cr: Pick<CR, 'steps'>): CRStatement[] {
  const out: CRStatement[] = [];
  let order = 0;
  cr.steps.forEach((step, index) => {
    if (!('sql' in step)) return;
    for (const s of statements(step.sql)) {
      out.push({ ...s, step: index, nested: false, order: order++ });
      for (const b of doBody(s)) out.push({ ...b, step: index, nested: true, order: order++ });
    }
  });
  return out;
}

const unquote = (v: string) => v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'").trim();

/** Milliseconds from a GUC time literal; a bare number is milliseconds. */
export function parseDurationMs(raw: string): number | null {
  const m = /^(-?[0-9.]+)\s*(us|ms|s|min|h|d)?$/i.exec(unquote(raw));
  if (!m) return null;
  const mult: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
  return Number(m[1]) * mult[(m[2] ?? 'ms').toLowerCase()];
}

/** Bytes from a GUC memory literal. A bare number needs the pg_settings unit. */
export function parseBytes(raw: string, unit?: string): number | null {
  const m = /^([0-9.]+)\s*(b|kb|mb|gb|tb)?$/i.exec(unquote(raw));
  if (!m) return null;
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  if (m[2]) return Number(m[1]) * mult[m[2].toLowerCase()];
  if (!unit) return null;
  const u = /^([0-9]*)\s*(b|kb|mb|gb|tb)$/i.exec(unit);
  if (!u) return null;
  return Number(m[1]) * Number(u[1] || 1) * mult[u[2].toLowerCase()];
}

/** Strip a schema prefix and quotes from an identifier. */
export function bare(name: string): string {
  const parts = name.replace(/"/g, '').toLowerCase().split('.');
  return parts[parts.length - 1];
}

export function lookup<T>(map: Record<string, T> | undefined, name: string): T | undefined {
  if (!map) return undefined;
  const b = bare(name);
  return map[name] ?? map[name.toLowerCase()] ?? map[b] ?? map[`public.${b}`];
}

/** Word-boundary, case-insensitive identifier search. */
export function mentions(haystack: string, ident: string): boolean {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`, 'i').test(haystack);
}

export const DDL_RE = /^(lock |alter table|alter index|alter type|alter domain|alter materialized view|create (unique )?index|drop |reindex|cluster|truncate|vacuum\b.*\bfull\b)/;
export const DML_RE = /^(update|delete|merge|copy\b.*\bfrom\b|insert\b.*\b(select|do update)\b|with\b.*\b(update|delete|insert|merge)\b)/;
export const isDDL = (text: string) => DDL_RE.test(text);
export const isDML = (text: string) => DML_RE.test(text);

/** Tables created by the CR, with the step that creates them. */
export function createdTables(stmts: CRStatement[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of stmts) {
    const m = /^create (?:unlogged |temp |temporary )?table (?:if not exists )?(\S+)/.exec(s.text);
    if (m && !out.has(bare(m[1]))) out.set(bare(m[1]), s.step);
  }
  return out;
}

/** Target relation of a DDL statement, or null when not determinable. */
export function ddlTarget(text: string): string | null {
  let m = /^alter (?:table|index|materialized view) (?:if exists )?(?:only )?(\S+)/.exec(text);
  if (m) return bare(m[1]);
  m = /^create (?:unique )?index (?:concurrently )?(?:if not exists )?(?:\S+ )?on (?:only )?(\S+)/.exec(text);
  if (m) return bare(m[1]);
  if (/^vacuum\b/.test(text)) { const w = text.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(x => !['vacuum', 'full', 'verbose', 'analyze', 'freeze'].includes(x)); return w.length ? bare(w[0]) : null; }
  if (/^cluster\b/.test(text)) { const w = text.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(x => !['cluster', 'verbose'].includes(x)); return w.length ? bare(w[0]) : null; }
  m = /^lock (?:table )?(?:only )?(\S+)/.exec(text);
  if (m) return bare(m[1]);
  m = /^truncate (?:table )?(?:only )?(\S+)/.exec(text);
  if (m) return bare(m[1]);
  return null;
}

/** Text of the CR fields where an author declares risk and dependencies. */
export function declaredText(cr: CR, fields: ('risk' | 'postconditions' | 'claims' | 'rollback')[]): string {
  const parts: string[] = [];
  if (fields.includes('risk')) parts.push(cr.risk.class_guess, cr.risk.blast_radius);
  if (fields.includes('postconditions')) parts.push(...cr.postconditions);
  if (fields.includes('claims')) parts.push(...cr.claims.map(c => c.text));
  if (fields.includes('rollback')) parts.push(...cr.rollback);
  return parts.join('\n');
}

export type DmlVerb = 'update' | 'delete' | 'merge' | 'insert';
export type DmlPart = { verb: DmlVerb; tokens: Token[]; text: string; insertSelect: boolean; upsert: boolean };
const DML_VERBS = new Set(['update', 'delete', 'merge', 'insert']);

function part(tokens: Token[]): DmlPart | null {
  const verb = tokens[0]?.v;
  if (!verb || tokens[0].kind !== 'word' || !DML_VERBS.has(verb)) return null;
  const text = plain(tokens);
  return { verb: verb as DmlVerb, tokens, text, insertSelect: verb === 'insert' && /\bselect\b/.test(text), upsert: verb === 'insert' && /\bon conflict\b.*\bdo update\b/.test(text) };
}

/**
 * Data-modifying parts of a statement: a plain UPDATE/DELETE/MERGE/INSERT, or
 * for WITH the main statement and every data-modifying CTE body.
 */
export function dmlParts(tokens: Token[]): DmlPart[] {
  if (tokens[0]?.v !== 'with') { const p = part(tokens); return p ? [p] : []; }
  const out: DmlPart[] = [];
  let depth = 0, start = -1;
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'punct' && t.v === '(') { if (depth === 0) start = k + 1; depth++; continue; }
    if (t.kind === 'punct' && t.v === ')') {
      depth--;
      if (depth === 0 && start > 0) { const p = part(tokens.slice(start, k)); if (p) out.push(p); start = -1; }
      continue;
    }
    if (depth === 0 && t.kind === 'word' && (DML_VERBS.has(t.v) || t.v === 'select')) {
      const p = part(tokens.slice(k));
      if (p) out.push(p);
      break;
    }
  }
  return out;
}
