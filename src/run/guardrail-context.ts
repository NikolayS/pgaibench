// Guardrail telemetry the runner can cheaply provide.
// collectFacts runs read-only catalog queries for the relations and GUCs a CR
// touches; buildGuardrailContext turns facts taken before (primary) and after
// (clone, right after rehearsal) into a GuardrailContext. The pre-rehearsal
// context carries only static facts; the post context adds rehearsal facts.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardrailContext, RehearsalStep } from '../guardrails/types';
import type { CR, Row, Snapshot, TelemetryRecord } from './types';

export interface GuardrailFacts {
  relfilenodes: Record<string, number>;
  relation_sizes: Record<string, number>;
  relation_rows: Record<string, number>;
  setting_context: Record<string, string>;
  setting_units: Record<string, string>;
  pending_restart: Record<string, boolean>;
  settings: Record<string, string>;
  dependents: Record<string, string[]>;
  definitions: Record<string, string>;
  function_volatility: Record<string, 'i' | 's' | 'v'>;
  column_types: Record<string, string>;
  index_valid: Record<string, boolean>;
  constraint_validated: Record<string, boolean>;
  detach_pending: string[];
  views: string[];
  errors: string[];
}

export const emptyFacts = (): GuardrailFacts => ({ relfilenodes: {}, relation_sizes: {}, relation_rows: {}, setting_context: {}, setting_units: {}, pending_restart: {},
  settings: {}, dependents: {}, definitions: {}, function_volatility: {}, column_types: {}, index_valid: {}, constraint_validated: {}, detach_pending: [], views: [], errors: [] });

const NOT_NAMES = new Set(['select', 'set', 'only', 'lateral', 'conflict', 'delete', 'update', 'insert', 'commit', 'true', 'false', 'each', 'row', 'statement', 'values', 'not', 'exists', 'if']);
const sqlSteps = (cr: CR) => cr.steps.flatMap(s => 'sql' in s ? [s.sql] : []);

// Quoted names keep their case and spaces; unquoted names fold to lower case.
const NAME = String.raw`(?:"[^"]+"|[a-z_][\w$]*)`;
export function crIdentifiers(cr: CR): string[] {
  const out = new Set<string>();
  const re = new RegExp(String.raw`\b(?:table|index|view|function|procedure|into|update|from|join|on|rename\s+to)\s+(?:(?:only|if|not|exists|concurrently)\s+)*(${NAME}(?:\.${NAME})?)`, 'gi');
  for (const sql of sqlSteps(cr)) for (const m of sql.matchAll(re)) {
    const last = [...m[1]!.matchAll(new RegExp(NAME, 'gi'))].at(-1)![0];
    const name = last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
    if (last.startsWith('"') || !NOT_NAMES.has(name)) out.add(name);
  }
  return [...out].sort();
}

export function crGucs(cr: CR): string[] {
  const out = new Set<string>();
  for (const s of cr.steps) if ('config' in s) out.add(s.config.name.toLowerCase());
  for (const sql of sqlSteps(cr)) for (const m of sql.matchAll(/(?:^|;)\s*set\s+(?:local\s+|session\s+)?([a-z_][\w.]*)\s*(?:=|\bto\b)/gim)) out.add(m[1]!.toLowerCase());
  return [...out].sort();
}

export function crFunctions(cr: CR): string[] {
  const out = new Set<string>();
  for (const sql of sqlSteps(cr)) for (const m of sql.matchAll(/\b([a-z_][\w]*)\s*\(/gi)) out.add(m[1]!.toLowerCase());
  return [...out].sort();
}

const arr = (xs: string[]) => `array[${xs.map(x => `'${x.replaceAll("'", "''")}'`).join(',')}]::text[]`;

function queries(ids: string[], gucs: string[], funcs: string[]): [string, string][] {
  const I = arr(ids), G = arr(gucs), F = arr([...new Set([...ids, ...funcs])]);
  const rel = `select oid from pg_class where relname = any(${I})`;
  const deps = `select r.ev_class from pg_depend d join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass where d.refclassid = 'pg_class'::regclass and d.refobjid in (${rel})`;
  return [
    ['relations', `select c.relname, c.relfilenode, pg_total_relation_size(c.oid)::text as size, c.reltuples from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema') and c.relname = any(${I})`],
    ['settings', `select name, context, unit, pending_restart, setting from pg_settings where name = any(${G})`],
    ['dependents', `select distinct c.relname as object, v.relname as dependent from pg_depend d join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass join pg_class v on v.oid = r.ev_class join pg_class c on c.oid = d.refobjid and d.refclassid = 'pg_class'::regclass where c.relname = any(${I}) and v.oid <> c.oid order by 1, 2`],
    ['definitions', `select v.relname as name, pg_get_viewdef(v.oid) as definition from pg_class v where v.relkind in ('v', 'm') and (v.relname = any(${I}) or v.oid in (${deps})) union all select p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.proname = any(${I})`],
    ['volatility', `select distinct on (p.proname) p.proname as name, p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = any(${F}) order by p.proname, n.nspname = 'public' desc`],
    ['columns', `select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname = any(${I}) and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`],
    ['indexes', `select x.relname as name, i.indisvalid as valid from pg_index i join pg_class t on t.oid = i.indrelid join pg_class x on x.oid = i.indexrelid where t.relname = any(${I}) or x.relname = any(${I})`],
    ['constraints', `select conname as name, conrelid::regclass::text as "table", convalidated as validated from pg_constraint where conrelid in (${rel})`],
    ['detach', `select inhrelid::regclass::text as name from pg_inherits where inhdetachpending`],
    ['views', `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('v', 'm') and n.nspname = 'public' order by 1`],
  ];
}

type Client = { unsafe(q: string): PromiseLike<Row[]> };
const bool = (v: unknown) => v === true || v === 't' || v === 'true';

export async function collectFacts(client: Client, ids: string[], gucs: string[], funcs: string[] = []): Promise<GuardrailFacts> {
  const f = emptyFacts();
  const map: Record<string, (rows: Row[]) => void> = {
    relations: rows => { for (const r of rows) { f.relfilenodes[r.relname] = Number(r.relfilenode); f.relation_sizes[r.relname] = Number(r.size); f.relation_rows[r.relname] = Number(r.reltuples); } },
    settings: rows => { for (const r of rows) { f.setting_context[r.name] = r.context; if (r.unit) f.setting_units[r.name] = r.unit; f.pending_restart[r.name] = bool(r.pending_restart); f.settings[r.name] = String(r.setting); } },
    dependents: rows => { for (const r of rows) (f.dependents[r.object] ??= []).push(r.dependent); },
    definitions: rows => { for (const r of rows) f.definitions[r.name] = r.definition; },
    volatility: rows => { for (const r of rows) f.function_volatility[r.name] = r.provolatile; },
    columns: rows => { for (const r of rows) f.column_types[r.key] = r.type; },
    indexes: rows => { for (const r of rows) f.index_valid[r.name] = bool(r.valid); },
    constraints: rows => { for (const r of rows) f.constraint_validated[r.name] = bool(r.validated); },
    detach: rows => { f.detach_pending = rows.map(r => r.name); },
    views: rows => { f.views = rows.map(r => r.name); },
  };
  await client.unsafe('begin transaction read only');
  try {
    for (const [tag, sql] of queries(ids, gucs, funcs)) {
      await client.unsafe('savepoint facts');
      try { map[tag]!(Array.from(await client.unsafe(`-- pgaibench-facts ${tag}\n${sql}`))); await client.unsafe('release savepoint facts'); }
      catch (e) { f.errors.push(`${tag}: ${(e as Error).message}`); await client.unsafe('rollback to savepoint facts'); }
    }
  } finally { await client.unsafe('rollback'); }
  return f;
}

export function loadWorkloadTexts(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).filter(n => /^q\d{2}\.sql$/.test(n)).sort().map(n => [n.slice(0, 3),
    readFileSync(join(dir, n), 'utf8').split('\n').filter(l => l.trim() && !/^(?:\/\*.*?\*\/\s*)?\\/.test(l.trim())).join('\n').trim()]));
}

export function pgssTexts(s: Snapshot): string[] {
  return [...new Set(s.stats.pg_stat_statements.map(r => r.query).filter((q): q is string => typeof q === 'string'))];
}

export function buildGuardrailContext(o: { baseline: Snapshot; before: GuardrailFacts; after?: GuardrailFacts; rehearsal?: TelemetryRecord; workloadTexts?: Record<string, string>; pgss?: string[] }): GuardrailContext {
  const b = o.before;
  const ctx: GuardrailContext = { baseline: o.baseline, relation_sizes: b.relation_sizes, relation_rows: b.relation_rows, dependents: b.dependents, setting_context: b.setting_context,
    setting_units: b.setting_units, function_volatility: b.function_volatility, column_types: b.column_types, definitions: b.definitions,
    workload_texts: o.workloadTexts, pgss_texts: o.pgss ?? pgssTexts(o.baseline) };
  if (!o.after || !o.rehearsal) return ctx;
  const steps: RehearsalStep[] = (o.rehearsal.actor?.steps ?? []).map(s => Object.fromEntries(Object.entries({ ok: s.ok, rows_affected: s.rows_affected,
    setting_primary: s.setting_primary, setting_standby: s.setting_standby }).filter(([, v]) => v !== undefined)) as RehearsalStep);
  return { ...ctx, rehearsal: o.rehearsal.after, steps, ...(steps.length ? { rehearsed_through_step: steps.length - 1 } : {}),
    relfilenodes: { before: b.relfilenodes, after: o.after.relfilenodes }, views: { before: b.views, after: o.after.views },
    pending_restart: o.after.pending_restart, detach_pending: o.after.detach_pending };
}
