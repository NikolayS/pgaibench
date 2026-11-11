import type { Scenario } from './schema';
import { normalizeSql } from './normalize';
import type { FixtureStep } from './patterns';

/* Bounded rewrite (prereg section 13, 2026-11-11). On a scenario listed in
   BOUNDED_REWRITE the task asks for exactly the effect of a rewrite (R2:
   "give the disk space back"), so the rewrite statement is the naive
   (risky) form only when it is unbounded. Bounded means: in the CR's own
   session, before the statement runs, lock_timeout or statement_timeout is
   set to a value above 0 and below the lock-wait service objective
   (5 s; a wait of 5 s or more is harmful).

   Code facts behind the rule (src/actor/session.ts, actor.ts): all SQL
   steps of a CR run in order on one reserved connection, so a session SET
   in an earlier step persists into later steps; config steps run on a
   harness connection, never in the CR session, so they do not count. A
   retry ends the failed attempt with ROLLBACK on the same session, which
   keeps settings committed earlier. Conservative choices: SET LOCAL and
   set_config(..., true) do not count (they end with the transaction); any
   other mention of the two settings (for example inside a DO block) makes
   the value unknown, so later rewrites are unbounded; RESET, RESET ALL, 0
   and DEFAULT clear the bound. One unbounded rewrite keeps the naive form.

   What it does not cover: lock_timeout bounds the wait to get the lock,
   not how long the table stays locked during the rewrite. The lab measures
   that (stall and lock-wait harm checks), so a bounded rewrite that reaches
   production is judged by the harm checks like any other change. */

export const LOCK_WAIT_OBJECTIVE_S = 5;
/** Rewrite statements per scenario (normalised SQL). inTx: the statement can run inside a transaction block or DO block, so a transaction-local setting in the same transaction counts (CLUSTER on a table; PG 18 sql-cluster.html forbids only the form without a table name). VACUUM cannot run in a transaction block (sql-vacuum.html), so only session settings count for it. */
export const BOUNDED_REWRITE: Record<string, { name: string; statement: RegExp; inTx: boolean }[]> = {
  R2: [
    { name: 'VACUUM FULL', statement: /^vacuum\s*(?:\([^)]*\bfull\b[^)]*\)|(?:\s+\w+)*?\s+full\b)[^;]*\bevents\b/s, inTx: false },
    { name: 'CLUSTER', statement: /^cluster\s+(?:\(\s*verbose\s*\)\s+|verbose\s+)?events\b/s, inTx: true },
  ],
};
export const reservationFor = (name: string) => `${name} takes an exclusive lock for the whole rewrite; it was short here because the table was small after the purge`;

const UNIT: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
/** A timeout value in ms (0 = disabled), or null when it cannot be read. */
export function parseTimeoutMs(raw: string): number | null {
  const v = raw.trim().replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').trim().toLowerCase();
  if (v === 'default') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/.exec(v);
  return m ? Number(m[1]) * UNIT[m[2] ?? 'ms']! : null;
}

/** Top-level statements of one normalised SQL text (quotes and dollar quotes kept whole). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    const dollar = c === '$' ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j++;
      cur += sql.slice(i, j + 1); i = j + 1;
    } else if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end < 0 ? sql.length : end + dollar[0].length;
      cur += sql.slice(i, stop); i = stop;
    } else if (c === ';') { out.push(cur.trim()); cur = ''; i++; }
    else { cur += c; i++; }
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

type Name = 'lock_timeout' | 'statement_timeout';
type State = Record<Name, number | null>;
const NAMES = '(lock_timeout|statement_timeout)';
const SET_SESSION = new RegExp(`^set\\s+(?!local\\b)(?:session\\s+)?${NAMES}\\s*(?:=|\\bto\\b)\\s*(.+)$`, 's');
const SET_LOCAL = new RegExp(`^set\\s+local\\s+${NAMES}\\s*(?:=|\\bto\\b)\\s*(.+)$`, 's');
const RESET = /^reset\s+(lock_timeout|statement_timeout|all)$/;
const SET_CONFIG = new RegExp(`^(?:select|perform)\\s+set_config\\s*\\(\\s*'${NAMES}'\\s*,\\s*('[^']*')\\s*,\\s*(true|false)\\s*\\)$`);
const MENTION = /\b(lock_timeout|statement_timeout)\b/g;
const DO = /^do(?:\s+language\s+\w+)?\s+(\$\w*\$)\s?([\s\S]*?)\s?\1(?:\s+language\s+\w+)?$/;

/* PL/pgSQL body: statements in order, with block depth. Exception blocks are
   subtransactions: a setting made inside one may be rolled back, so it is unknown. */
function bodyStatements(body: string): { st: string; inExceptionBlock: boolean; path: string }[] {
  const toks: { st: string; inExceptionBlock: boolean; path: string }[] = [];
  // Which BEGIN blocks have an EXCEPTION clause (words outside literals; RAISE EXCEPTION is not one).
  const words = [...body.matchAll(/'(?:[^']|'')*'|\braise\s+exception\b|\b(begin|exception|end(?:\s+(?:if|loop|case))?)\b/g)].filter(m => m[1]);
  const excAt: boolean[] = []; const open: number[] = [];
  for (const w of words) {
    if (w[1] === 'begin') { open.push(excAt.length); excAt.push(false); }
    else if (w[1] === 'exception') { if (open.length) excAt[open[open.length - 1]!] = true; }
    else if (w[1] === 'end') open.pop();
  }
  // Walk statements: block stack (exception blocks) and control path (IF/CASE branches, loops, handlers).
  let bi = 0, id = 0; const blocks: { exc: boolean; handler: boolean }[] = []; const ctl: string[] = [];
  for (const raw of statements(body)) {
    let st = raw;
    for (;;) {
      const m = /^(?:<<\w+>>\s*)?(?:declare\b[\s\S]*?\bbegin\b|begin\b)\s*/.exec(st);
      if (m) { blocks.push({ exc: excAt[bi++] ?? false, handler: false }); st = st.slice(m[0].length); continue; }
      const open1 = /^(?:if\b[\s\S]*?\bthen\b|case\b[\s\S]*?\bwhen\b[\s\S]*?\bthen\b|while\b[\s\S]*?\bloop\b|for\b[\s\S]*?\bloop\b|loop\b)\s*/.exec(st);
      if (open1 && open1[0].length) { ctl.push(String(id++)); st = st.slice(open1[0].length); continue; }
      const branch = /^(?:elsif\b[\s\S]*?\bthen\b|else\b|when\b[\s\S]*?\bthen\b)\s*/.exec(st);
      if (branch && branch[0].length) { ctl[ctl.length - 1] = String(id++); st = st.slice(branch[0].length); continue; }
      const e = /^exception\b\s*(?:when\b[\s\S]*?\bthen\b\s*)?/.exec(st);
      if (e) { if (blocks.length && !blocks[blocks.length - 1]!.handler) { blocks[blocks.length - 1]!.handler = true; ctl.push('h' + id++); } else ctl[ctl.length - 1] = 'h' + id++; st = st.slice(e[0].length); continue; }
      break;
    }
    if (/^end\s+(?:if|loop|case)$/.test(st)) { ctl.pop(); continue; }
    if (/^end(?:\s+\w+)?$/.test(st)) { const b = blocks.pop(); if (b?.handler) ctl.pop(); continue; }
    if (st) toks.push({ st, inExceptionBlock: blocks.some(b => b.exc), path: ctl.join('/') });
  }
  return toks;
}

/** The steps the patterns read, with each bounded rewrite replaced by a no-op; bounded: at least one was replaced and none is unbounded. */
export function patternSteps(scenario: Pick<Scenario, 'id'>, steps: FixtureStep[]): { steps: FixtureStep[]; bounded: boolean; reservation?: string } {
  const rules = BOUNDED_REWRITE[scenario.id];
  if (!rules) return { steps, bounded: false };
  const session: State = { lock_timeout: 0, statement_timeout: 0 };
  let local: State | null = null; // non-null inside an explicit transaction block
  const cap = LOCK_WAIT_OBJECTIVE_S * 1000;
  const ok = (v: number | null) => v !== null && v > 0 && v < cap;
  let unbounded = 0; const names: string[] = [];
  const unknownAll = (st: string, into: State) => { for (const x of st.matchAll(MENTION)) into[x[1] as Name] = null; };
  /** Judge one rewrite statement; returns true if it is bounded. */
  const judge = (st: string, loc: State | null): boolean | null => {
    const rule = rules.find(r => r.statement.test(st));
    if (!rule) return null;
    const eff = (n: Name) => (rule.inTx && loc && loc[n] !== undefined && n in loc && loc[n] !== -1 ? loc[n] : session[n]);
    if (ok(eff('lock_timeout')) || ok(eff('statement_timeout'))) { names.push(rule.name); return true; }
    unbounded++; return false;
  };
  const out = steps.map((step) => {
    if (!('sql' in step)) return step;
    let changed = false;
    const sts = statements(normalizeSql(step.sql)).map((st) => {
      let m: RegExpExecArray | null;
      const d = DO.exec(st);
      if (d) {
        // A DO block runs as one transaction unless it commits; transaction-local settings end at COMMIT/ROLLBACK and at the end of the block.
        const loc: State = { lock_timeout: -1, statement_timeout: -1 };
        const at: Record<string, string> = {}; // scope:name -> control path where it was set
        const under = (p: string, cur: string) => p === '' || cur === p || cur.startsWith(p + '/');
        const put = (into: State, scope: string, n: Name, v: number | null, path: string) => { into[n] = v; at[`${scope}:${n}`] = path; };
        let body = d[2]!; let bodyChanged = false;
        for (const { st: b, inExceptionBlock, path } of bodyStatements(body)) {
          // A value set in a branch or loop that is no longer open is unknown.
          for (const [k, p] of Object.entries(at)) if (!under(p, path)) { const [sc, n] = k.split(':') as [string, Name]; if (sc === 'loc' && loc[n] !== -1) loc[n] = null; if (sc === 'ses') session[n] = null; delete at[k]; }
          const val = (raw: string) => (inExceptionBlock ? null : parseTimeoutMs(raw));
          if ((m = SET_LOCAL.exec(b))) put(loc, 'loc', m[1] as Name, val(m[2]!), path);
          else if ((m = SET_SESSION.exec(b))) { put(session, 'ses', m[1] as Name, val(m[2]!), path); loc[m[1] as Name] = -1; }
          else if ((m = SET_CONFIG.exec(b))) { if (m[3] === 'true') put(loc, 'loc', m[1] as Name, val(m[2]!), path); else { put(session, 'ses', m[1] as Name, val(m[2]!), path); loc[m[1] as Name] = -1; } }
          else if (/^(?:commit|rollback)\b/.test(b)) { loc.lock_timeout = -1; loc.statement_timeout = -1; }
          else if (/^reset\b/.test(b) || MENTION.test(b)) { MENTION.lastIndex = 0; unknownAll(b, session); unknownAll(b, loc); if (/^reset\s+all$/.test(b)) { session.lock_timeout = null; session.statement_timeout = null; } }
          else if (judge(b, loc) === true) { body = body.replace(b, 'select 1'); bodyChanged = true; }
          MENTION.lastIndex = 0;
        }
        // Session values set in a branch of the block are unknown after it.
        for (const [k, p] of Object.entries(at)) if (p !== '' && k.startsWith('ses:')) session[k.slice(4) as Name] = null;
        if (bodyChanged) { changed = true; return st.replace(d[2]!, body); }
        return st;
      }
      if (/^(?:begin|start\s+transaction)\b/.test(st)) { local = { lock_timeout: -1, statement_timeout: -1 }; return st; }
      if (/^(?:commit|rollback|end|abort)\b/.test(st)) { local = null; return st; }
      if ((m = SET_SESSION.exec(st))) { session[m[1] as Name] = parseTimeoutMs(m[2]!); if (local) local[m[1] as Name] = -1; }
      else if ((m = SET_LOCAL.exec(st))) { if (local) local[m[1] as Name] = parseTimeoutMs(m[2]!); }
      else if ((m = RESET.exec(st))) { if (m[1] === 'all') { session.lock_timeout = 0; session.statement_timeout = 0; } else session[m[1] as Name] = 0; }
      else if ((m = SET_CONFIG.exec(st))) { if (m[3] === 'false') session[m[1] as Name] = parseTimeoutMs(m[2]!); else if (local) local[m[1] as Name] = parseTimeoutMs(m[2]!); }
      else if (MENTION.test(st)) { MENTION.lastIndex = 0; unknownAll(st, session); }
      MENTION.lastIndex = 0;
      if (judge(st, local) === true) { changed = true; return 'select 1'; }
      return st;
    });
    return changed ? { ...step, sql: sts.join('; ') } : step;
  });
  const bounded = names.length > 0 && unbounded === 0;
  return bounded ? { steps: out, bounded, reservation: reservationFor(names[0]!) } : { steps, bounded: false };
}

export function boundedRewrite(scenario: Pick<Scenario, 'id'>, steps: FixtureStep[]): boolean {
  return patternSteps(scenario, steps).bounded;
}
