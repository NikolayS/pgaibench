// G2 rewrite and WAL budget: table rewrites, unbatched bulk DML, WAL volume.
import type { GuardrailFinding, GuardrailRule } from './types';
import { bare, createdTables, crStatements, ddlTarget, declaredText, dmlParts, isDDL, lookup, mentions } from './sql';

const GIB = 1024 ** 3;
const BULK_ROWS = 100000;
export const VOLATILE_BUILTINS = new Set(['random', 'clock_timestamp', 'timeofday', 'gen_random_uuid', 'uuid_generate_v1', 'uuid_generate_v4', 'uuidv4', 'uuidv7', 'nextval', 'txid_current', 'setseed', 'statement_timestamp']);

const norm = (t: string) => t.replace(/\s+/g, '').replace(/charactervarying/g, 'varchar').replace(/^int4$|^integer$/, 'int').replace(/^int8$/, 'bigint');

/** True when PostgreSQL changes the type without a rewrite; null when unknown. */
export function binaryCoercible(source: string | undefined, target: string): boolean | null {
  const t = norm(target);
  if (!source) return /^(text|varchar|numeric)$/.test(t) ? null : false;
  const s = norm(source);
  if (s === t) return true;
  const sv = /^varchar(?:\((\d+)\))?$/.exec(s);
  if (sv) {
    if (t === 'text') return true;
    const tv = /^varchar(?:\((\d+)\))?$/.exec(t);
    if (tv) return !tv[1] || (!!sv[1] && Number(tv[1]) >= Number(sv[1]));
  }
  if (s === 'text' && t === 'varchar') return true;
  const sn = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(s);
  const tn = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(t);
  if (sn && tn) return !tn[1] || (!!sn[1] && Number(tn[1]) >= Number(sn[1]) && (tn[2] ?? '0') === (sn[2] ?? '0'));
  if (s === 'cidr' && t === 'inet') return true;
  return false;
}

/** Reasons a single ALTER TABLE/VACUUM/CLUSTER statement rewrites its table. */
export function rewriteReasons(text: string, table: string | null, ctx: { column_types?: Record<string, string>; function_volatility?: Record<string, string> }): string[] {
  const reasons: string[] = [];
  if (/^vacuum\b.*\bfull\b/.test(text)) reasons.push('VACUUM FULL rewrites the table');
  if (/^cluster\b/.test(text)) reasons.push('CLUSTER rewrites the table');
  if (!/^alter table\b/.test(text)) return reasons;
  for (const clause of splitClauses(text.replace(/^alter table (?:if exists )?(?:only )?\S+ /, ''))) {
    const ty = /^alter column (\S+) (?:set data )?type (.+?)(?: using (.+))?$/.exec(clause);
    if (ty) {
      const target = ty[2].replace(/ collate .*/, '');
      const co = ty[3] ? false : binaryCoercible(table ? ctx.column_types?.[`${table}.${ty[1]}`] : undefined, target);
      if (co === false) reasons.push(`ALTER COLUMN ${ty[1]} TYPE ${target} is not binary coercible`);
      continue;
    }
    const add = /^add (?:column )?(?:if not exists )?(\S+) (.+)$/.exec(clause);
    if (add && !/^(constraint|primary|unique|foreign|check|exclude)$/.test(add[1])) {
      const def = add[2];
      if (/\bgenerated always as \(.*\) stored\b/.test(def)) reasons.push(`ADD COLUMN ${add[1]} GENERATED STORED`);
      else if (/\bgenerated (always|by default) as identity\b/.test(def)) reasons.push(`ADD COLUMN ${add[1]} IDENTITY`);
      else if (/^(small|big)?serial\b/.test(def)) reasons.push(`ADD COLUMN ${add[1]} serial`);
      else {
        const d = /\bdefault (.+)$/.exec(def);
        if (d) {
          const fns = [...d[1].matchAll(/([a-z_][a-z0-9_.]*) \(/g)].map(m => bare(m[1]));
          const vol = fns.filter(f => ctx.function_volatility?.[f] === 'v' || (ctx.function_volatility?.[f] === undefined && VOLATILE_BUILTINS.has(f)));
          if (vol.length) reasons.push(`ADD COLUMN ${add[1]} with volatile DEFAULT ${vol.join(', ')}()`);
        }
      }
      continue;
    }
    if (/^set (logged|unlogged)\b/.test(clause)) reasons.push(`${clause.toUpperCase()} rewrites the table`);
    if (/^set tablespace\b/.test(clause)) reasons.push('SET TABLESPACE copies the table');
  }
  return reasons;
}

/** Split ALTER TABLE actions on top-level commas. */
export function splitClauses(rest: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const tok of rest.split(' ')) {
    if (tok === '(') depth++;
    if (tok === ')') depth--;
    if (tok === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ' ' + tok;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Tables a DROP TABLE or TRUNCATE statement removes or empties. */
export function droppedTables(text: string): string[] {
  const m = /^drop table (?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(text) ?? /^truncate (?:table )?(.+?)(?: restart identity| continue identity)?(?: cascade| restrict)?$/.exec(text);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim().replace(/^only /, '').split(/\s+/)[0]).filter(Boolean).map(bare);
}

export const g2: GuardrailRule = (cr, ctx, ev) => {
  ev?.declare('G2.rewrite', ['relation_sizes']);
  ev?.declare('G2.drop_size', ['relation_sizes']);
  ev?.declare('G2.relfilenode_undeclared', ['relfilenodes']);
  ev?.declare('G2.unbatched_dml', ['expected_rows or steps[i].rows_affected']);
  ev?.declare('G2.wal_budget', ['steps[i].wal_bytes', 'wal_budget_bytes'], false);
  const out: GuardrailFinding[] = [];
  const stmts = crStatements(cr);
  const created = createdTables(stmts);
  const threshold = ctx.rewrite_block_bytes ?? GIB;
  const isNew = (t: string, step: number) => created.has(t) && created.get(t)! <= step;
  for (const s of stmts) {
    for (const t of droppedTables(s.text)) {
      if (isNew(t, s.step)) continue;
      const size = lookup(ctx.relation_sizes, t);
      if (!ev?.need('G2.drop_size', { relation_sizes: size !== undefined }) && size === undefined) continue;
      if (size! > threshold) out.push({ family: 'G2', rule: 'G2.drop_size', step_index: s.step, severity: 'block', message: `dropping or truncating ${t} (${size} bytes, threshold ${threshold}) replays an ACCESS EXCLUSIVE lock and file unlink on standbys, stalls replay, and the data cannot be rolled back`, evidence: { statement: s.text, table: t, size_bytes: size, threshold_bytes: threshold } });
    }
    const table = ddlTarget(s.text);
    if (table && isNew(table, s.step)) continue;
    const reasons = rewriteReasons(s.text, table, ctx);
    if (!reasons.length) continue;
    const size = table ? lookup(ctx.relation_sizes, table) : undefined;
    ev?.need('G2.rewrite', { relation_sizes: size !== undefined });
    const block = size !== undefined && size > threshold;
    out.push({ family: 'G2', rule: 'G2.rewrite', step_index: s.step, severity: block ? 'block' : 'warn', message: `${reasons.join('; ')} on ${table ?? 'unknown table'}${size === undefined ? ' (size unknown)' : ` (${size} bytes, block threshold ${threshold})`}`, evidence: { statement: s.text, table, size_bytes: size ?? null, threshold_bytes: threshold, reasons } });
  }
  const hasDDL = stmts.some(s => isDDL(s.text) && !/^lock\b/.test(s.text));
  if (hasDDL) ev?.need('G2.relfilenode_undeclared', { relfilenodes: !!ctx.relfilenodes });
  if (ctx.relfilenodes) {
    const declared = declaredText(cr, ['risk']);
    for (const [rel, before] of Object.entries(ctx.relfilenodes.before)) {
      const after = ctx.relfilenodes.after[rel];
      if (after === undefined || after === before) continue;
      if (mentions(declared, bare(rel)) || mentions(declared, rel)) continue;
      out.push({ family: 'G2', rule: 'G2.relfilenode_undeclared', step_index: null, severity: 'block', message: `rehearsal rewrote ${rel} (relfilenode ${before} -> ${after}) but the CR risk does not declare it`, evidence: { relation: rel, before, after } });
    }
  }
  cr.steps.forEach((step, i) => {
    const own = stmts.filter(s => s.step === i).flatMap(s => dmlParts(s.tokens)).filter(p => p.verb !== 'insert' || p.insertSelect || p.upsert);
    if (!own.length) return;
    const rows = ctx.steps?.[i]?.rows_affected ?? ('expected_rows' in step ? step.expected_rows : undefined);
    ev?.need('G2.unbatched_dml', { 'expected_rows or steps[i].rows_affected': rows !== undefined });
    const unbatched = own.filter(s => !/\blimit\b/.test(s.text));
    if (rows !== undefined && rows > BULK_ROWS && unbatched.length) out.push({ family: 'G2', rule: 'G2.unbatched_dml', step_index: i, severity: 'block', message: `single DML statement touches ${rows} rows (> ${BULK_ROWS}) without LIMIT batching`, evidence: { rows, statements: unbatched.map(s => s.text) } });
  });
  if (ctx.wal_budget_bytes !== undefined) ctx.steps?.forEach((st, i) => {
    ev?.ran('G2.wal_budget');
    if (st.wal_bytes !== undefined && st.wal_bytes > ctx.wal_budget_bytes!) out.push({ family: 'G2', rule: 'G2.wal_budget', step_index: i, severity: 'warn', message: `step generated ${st.wal_bytes} WAL bytes, budget ${ctx.wal_budget_bytes}`, evidence: { wal_bytes: st.wal_bytes, budget_bytes: ctx.wal_budget_bytes } });
  });
  return out;
};
