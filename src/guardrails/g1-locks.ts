// G1 lock policy: bounded lock waits and non-blocking DDL forms.
import type { CR } from '../schema/types';
import type { GuardrailContext, GuardrailFinding, GuardrailRule, Severity } from './types';
import { bare, createdTables, crStatements, ddlTarget, isDDL, isDML, lookup, parseDurationMs, type CRStatement } from './sql';

const RULES = ['G1.lock_timeout', 'G1.concurrently', 'G1.not_valid', 'G1.validate_same_step', 'G1.set_not_null', 'G1.ddl_with_dml', 'G1.open_transaction', 'G1.detach_concurrently', 'G1.unique_using_index'];

/**
 * Step-level retry count. The field is added to the CR schema by another
 * branch; read it defensively. Valid: integer 1-10.
 */
export function stepRetries(step: CR['steps'][number]): number | null {
  const r = (step as any).retries;
  return Number.isInteger(r) && r >= 1 && r <= 10 ? r : null;
}

const MAX_LOCK_TIMEOUT_MS = 5000;

function lockTimeoutChange(text: string): number | null | undefined {
  let m = /^set (?:session |local )?lock_timeout (?:=|to) (.+)$/.exec(text);
  if (m) return /^default$/.test(m[1].trim()) ? null : parseDurationMs(m[1].trim()) ?? null;
  if (/^reset (lock_timeout|all)$/.test(text)) return null;
  m = /set_config \( 'lock_timeout' , '([^']*)'/.exec(text);
  if (m) return parseDurationMs(m[1]) ?? null;
  return undefined;
}

export const g1: GuardrailRule = (cr, ctx, ev) => {
  for (const r of RULES) ev?.declare(r);
  ev?.declare('G1.attach_without_check', ['baseline.catalog.constraints']);
  ev?.declare('G1.no_retry', [], false);
  for (const r of RULES) ev?.ran(r);
  const out: GuardrailFinding[] = [];
  const add = (rule: string, step: number, message: string, evidence: unknown, severity: Severity = 'block') => out.push({ family: 'G1', rule, step_index: step, severity, message, evidence });
  const stmts = crStatements(cr);
  const created = createdTables(stmts);
  const isNew = (t: string | null, step: number) => t !== null && created.has(t) && created.get(t)! <= step;
  let lockMs: number | null = null;
  const reported = new Set<string>();
  const once = (rule: string, step: number, message: string, evidence: unknown, severity: Severity = 'block') => { const k = `${rule}@${step}`; if (!reported.has(k)) { reported.add(k); add(rule, step, message, evidence, severity); } };
  const empty = (t: string | null) => t !== null && (lookup(ctx.relation_rows, t) ?? lookup(ctx.relation_sizes, t)) === 0;
  const retried = retriedSteps(cr, stmts);

  for (const s of stmts) {
    const change = lockTimeoutChange(s.text);
    if (change !== undefined) { lockMs = change; continue; }
    if (!isDDL(s.text)) continue;
    const target = ddlTarget(s.text);
    const bounded = lockMs !== null && lockMs > 0 && lockMs <= MAX_LOCK_TIMEOUT_MS;
    const nowait = /^lock\b.*\bnowait$/.test(s.text);
    if (!isNew(target, s.step) && !bounded && !nowait) {
      once('G1.lock_timeout', s.step, `DDL runs without lock_timeout between 1 ms and ${MAX_LOCK_TIMEOUT_MS} ms; a blocked lock request queues all later queries`, { statement: s.text, lock_timeout_ms: lockMs });
    }
    if (bounded && !isNew(target, s.step) && !/\bconcurrently\b/.test(s.text) && !retried.has(s.step)) {
      once('G1.no_retry', s.step, 'DDL has lock_timeout but no retry mechanism (step retries 1-10, a retry loop, or a repeated step); a lock timeout fails the change', { statement: s.text, lock_timeout_ms: lockMs }, 'warn');
    }
    const det = /\bdetach partition (\S+)( concurrently| finalize)?/.exec(s.text);
    if (det && !det[2] && !isNew(target, s.step)) once('G1.detach_concurrently', s.step, 'DETACH PARTITION without CONCURRENTLY takes ACCESS EXCLUSIVE on the parent', { statement: s.text, partition: bare(det[1]) });
    if (/\badd (?:constraint \S+ )?(?:unique|primary key|exclude)\b/.test(s.text) && !/\b(?:unique|primary key) using index\b/.test(s.text) && !isNew(target, s.step) && !empty(target)) {
      once('G1.unique_using_index', s.step, 'ADD UNIQUE/PRIMARY KEY/EXCLUDE builds the index under ACCESS EXCLUSIVE; build it CONCURRENTLY first and add the constraint USING INDEX', { statement: s.text, table: target });
    }
    const att = /^alter table (?:if exists )?(?:only )?(\S+) attach partition (\S+) (for values .*)$/.exec(s.text);
    if (att) attachCheck(att, s, stmts, ctx, ev, isNew, empty, once);
    if (/^create (unique )?index (?!concurrently\b)/.test(s.text) && !isNew(target, s.step)) {
      const rows = target ? lookup(ctx.relation_rows, target) ?? lookup(ctx.relation_sizes, target) : undefined;
      if (rows !== 0) once('G1.concurrently', s.step, 'index build on an existing table must use CONCURRENTLY', { statement: s.text, table: target });
    }
    if (/^reindex\b(?: \([^)]*\))? (?:index|table|schema|database|system) (?!concurrently\b)/.test(s.text)) once('G1.concurrently', s.step, 'REINDEX must use CONCURRENTLY', { statement: s.text });
    if (/\badd (constraint \S+ )?(foreign key|check)\b/.test(s.text) && !/\bnot valid\b/.test(s.text) && !isNew(target, s.step)) {
      once('G1.not_valid', s.step, 'FK and CHECK constraints must be added NOT VALID and validated in a separate step', { statement: s.text });
    }
    const nn = /alter column (\S+) set not null/.exec(s.text);
    if (nn && !isNew(target, s.step) && !hasValidatedNotNull(stmts, s, nn[1], ctx.baseline?.catalog?.constraints ?? [])) {
      once('G1.set_not_null', s.step, `SET NOT NULL on ${nn[1]} needs a validated CHECK (${nn[1]} is not null) or NOT NULL NOT VALID constraint in an earlier step; otherwise it scans the table under ACCESS EXCLUSIVE`, { statement: s.text, column: nn[1] });
    }
  }

  // Per-step rules.
  cr.steps.forEach((_, step) => {
    const own = stmts.filter(s => s.step === step);
    const notValid = own.flatMap(s => { const m = /add constraint (\S+) .*\bnot valid\b/.exec(s.text); return m ? [m[1]] : []; });
    for (const s of own) {
      const m = /validate constraint (\S+)/.exec(s.text);
      if (m && notValid.includes(m[1])) once('G1.validate_same_step', step, `constraint ${m[1]} is added and validated in the same step; validate it in a separate step`, { constraint: m[1] });
    }
    const ddl = own.find(s => isDDL(s.text) && !/^lock\b/.test(s.text));
    const dml = own.find(s => isDML(s.text));
    if (ddl && dml) once('G1.ddl_with_dml', step, 'DDL and bulk DML in one step hold DDL locks for the duration of the DML', { ddl: ddl.text, dml: dml.text });
    let depth = 0;
    for (const s of own.filter(x => !x.nested)) {
      if (/^(begin|start transaction)\b/.test(s.text)) depth++;
      else if (/^(commit|end|abort)\b/.test(s.text) || (/^rollback\b/.test(s.text) && !/^rollback to\b/.test(s.text))) depth = 0;
    }
    if (depth > 0) once('G1.open_transaction', step, 'step opens a transaction and does not close it', { step });
  });
  return out;
};

function hasValidatedNotNull(stmts: CRStatement[], at: CRStatement, col: string, baselineConstraints: { definition?: unknown }[]): boolean {
  const checkRe = new RegExp(`check\\(+${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}isnotnull\\)+`);
  if (baselineConstraints.some(c => typeof c.definition === 'string' && checkRe.test(c.definition.toLowerCase().replace(/\s+/g, '')) && !/not valid/i.test(c.definition))) return true;
  for (const s of stmts) {
    if (s.step >= at.step) break;
    const compact = s.text.replace(/\s+/g, '');
    if (checkRe.test(compact)) {
      const name = /add constraint (\S+)/.exec(s.text)?.[1];
      if (!/\bnot valid\b/.test(s.text)) return true;
      if (name && stmts.some(v => v.step < at.step && v.step > s.step && new RegExp(`validate constraint ${name}\\b`).test(v.text))) return true;
    }
    if (new RegExp(`add constraint \\S+ not null ${col}\\b`).test(s.text)) return true;
  }
  return false;
}

/** Steps whose DDL has a retry: step retries 1-10, a DO loop that catches lock_not_available, or the same DDL repeated in another step. */
function retriedSteps(cr: CR, stmts: CRStatement[]): Set<number> {
  const out = new Set<number>();
  cr.steps.forEach((step, i) => { if (stepRetries(step) !== null) out.add(i); });
  for (const s of stmts) if (/^do\b/.test(s.text) && /\bloop\b/.test(s.text) && /\block_not_available\b/.test(s.text)) out.add(s.step);
  const key = (x: string) => x.replace(/\bif (not )?exists /g, '');
  const ddl = stmts.filter(s => isDDL(s.text));
  for (const a of ddl) if (ddl.some(b => b.step !== a.step && key(b.text) === key(a.text))) out.add(a.step);
  return out;
}

/** Literal values of a partition bound, without quotes. */
function boundLiterals(bound: string): string[] {
  return [...bound.matchAll(/'((?:[^']|'')*)'|\b(\d+(?:\.\d+)?)\b/g)].map(m => (m[1] ?? m[2]).trim()).filter(Boolean);
}

/**
 * ATTACH PARTITION scans the candidate under lock unless a valid CHECK on the
 * candidate implies the bound. Evidence: an earlier CR step that adds and
 * validates a CHECK naming every bound literal, or the baseline catalog.
 */
function attachCheck(att: RegExpExecArray, s: CRStatement, stmts: CRStatement[], ctx: GuardrailContext, ev: Parameters<GuardrailRule>[2], isNew: (t: string | null, step: number) => boolean, empty: (t: string | null) => boolean, once: (rule: string, step: number, message: string, evidence: unknown) => void) {
  const rule = 'G1.attach_without_check';
  const cand = bare(att[2]);
  if (isNew(cand, s.step) || empty(cand)) { ev?.ran(rule); return; }
  const lits = boundLiterals(att[3]);
  const matches = (def: string) => lits.every(l => def.includes(l));
  for (const a of stmts) {
    if (a.step >= s.step) break;
    const m = /^alter table (?:if exists )?(?:only )?(\S+) add constraint (\S+) check (.*)$/.exec(a.text);
    if (!m || bare(m[1]) !== cand || !matches(m[3])) continue;
    const valid = !/\bnot valid$/.test(a.text) || stmts.some(v => v.step < s.step && v.order > a.order && new RegExp(`^alter table \\S+ validate constraint ${m[2]}$`).test(v.text));
    if (valid) { ev?.ran(rule); return; }
  }
  const catalog = ctx.baseline?.catalog?.constraints;
  if (!ev?.need(rule, { 'baseline.catalog.constraints': !!catalog }) && !catalog) return;
  const own = (catalog ?? []).filter(c => { const n = String(c.name).toLowerCase().split('.'); return n.length >= 2 && n[n.length - 2] === cand; });
  const ok = own.some(c => typeof c.definition === 'string' && /^check\b/i.test(c.definition) && !/not valid\s*$/i.test(c.definition) && matches(c.definition));
  if (!ok) once(rule, s.step, `ATTACH PARTITION ${cand} without a valid CHECK on the candidate that matches the bound: the candidate is scanned under lock`, { statement: s.text, candidate: cand, bound_literals: lits });
}
