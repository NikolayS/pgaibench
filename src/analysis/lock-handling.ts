// How an answer handles a lock queue, read from the stored change text.
// Descriptive only: defined after the results were known; changes no class,
// score or place.
//
// Locking statement: the first ALTER TABLE, CREATE [UNIQUE] INDEX without
// CONCURRENTLY, DROP TABLE, DROP INDEX without CONCURRENTLY, LOCK [TABLE],
// VACUUM FULL, CLUSTER, REINDEX without CONCURRENTLY or TRUNCATE, comments removed.
// lock_timeout: the last setting before that statement, by SET [LOCAL|SESSION]
// lock_timeout, set_config('lock_timeout', <literal or variable>, ...) or a
// config step. A variable takes its declared literal, or the first element of
// the array a FOREACH loop walks (the maximum is reported too).
// Retry: a step with the `retries` field (the harness reruns it on a lock
// timeout), or a LOOP/WHILE with an EXCEPTION handler for a lock timeout.

export type Step = { sql?: string | null; retries?: number; config?: { name: string; value: string } };
export interface LockHandling {
  locking_step: number | null; locking_kind: string | null;
  lock_timeout_ms: number | null; lock_timeout_max_ms: number | null;
  lock_timeout_form: "SET" | "SET LOCAL" | "set_config" | "set_config (variable)" | "config step" | null;
  nowait: boolean; retries: boolean; retry_how: string[];
}

export function toMs(v: string): number | null {
  const m = v.replace(/['"]/g, "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/);
  if (!m) return null;
  const x = Number(m[1]);
  return m[2] === "s" ? x * 1000 : m[2] === "min" ? x * 60000 : m[2] === "h" ? x * 3600000 : x;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const LOCK = /\b(alter\s+table|create\s+(?:unique\s+)?index(?!\s+concurrently)|drop\s+table|drop\s+index(?!\s+concurrently)|lock\s+(?:table\s+)?(?!timeout)[a-z_"]|vacuum\s+full|cluster\b|reindex\b(?![^;]*concurrently)|truncate\b)/i;
const KIND: [RegExp, string][] = [[/^alter/i, "ALTER TABLE"], [/^create/i, "CREATE INDEX"], [/^drop\s+table/i, "DROP TABLE"], [/^drop/i, "DROP INDEX"], [/^lock/i, "LOCK TABLE"], [/^vacuum/i, "VACUUM FULL"], [/^cluster/i, "CLUSTER"], [/^reindex/i, "REINDEX"], [/^truncate/i, "TRUNCATE"]];
const SETS = /\bset\s+(local\s+|session\s+)?lock_timeout\s*(?:=|\bto\b)\s*('[^']*'|"[^"]*"|[^\s;]+)|set_config\s*\(\s*'lock_timeout'\s*,\s*(?:'([^']*)'|([a-z_][a-z0-9_]*))/gi;

/** Literal values of a PL/pgSQL variable: its declared literal, or the array a FOREACH over it walks. */
function varValues(txt: string, v: string): string[] {
  const fe = new RegExp(`foreach\\s+${v}\\s+in\\s+array\\s+([a-z_][a-z0-9_]*|array\\s*\\[[^\\]]*\\])`, "i").exec(txt);
  if (fe) {
    const src = /^array/i.test(fe[1]!) ? fe[1]! : new RegExp(`\\b${fe[1]}\\b[^;]*?(?::=|=|\\bdefault\\b)\\s*(array\\s*\\[[^\\]]*\\])`, "i").exec(txt)?.[1];
    if (src) return [...src.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  }
  const d = new RegExp(`\\b${v}\\b[^;:=]*?(?::=|\\bdefault\\b)\\s*'([^']*)'`, "i").exec(txt);
  return d ? [d[1]!] : [];
}

export function lockHandling(steps: Step[]): LockHandling {
  const parts = steps.map((s) => (s.sql != null ? strip(s.sql) : ""));
  let li = -1, lockPos = -1, kind: string | null = null;
  for (let i = 0; i < parts.length && li < 0; i++) { const m = LOCK.exec(parts[i]!); if (m) { li = i; lockPos = m.index; kind = KIND.find(([r]) => r.test(m[1]!))![1]; } }
  const all = parts.join("\n;\n");
  let ms: number | null = null, max: number | null = null, form: LockHandling["lock_timeout_form"] = null;
  const upto = li < 0 ? parts.length : li + 1;
  for (let i = 0; i < upto; i++) {
    const st = steps[i]!;
    if (st.config && st.config.name.toLowerCase() === "lock_timeout") { ms = toMs(st.config.value); max = ms; form = "config step"; continue; }
    const p = parts[i]!, end = i === li ? lockPos : p.length;
    SETS.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = SETS.exec(p)) && m.index < end) {
      if (m[2] !== undefined) { ms = toMs(m[2]); max = ms; form = m[1] && /local/i.test(m[1]) ? "SET LOCAL" : "SET"; }
      else if (m[3] !== undefined) { ms = toMs(m[3]); max = ms; form = "set_config"; }
      else { const vs = varValues(all, m[4]!).map(toMs).filter((x): x is number => x !== null); ms = vs[0] ?? null; max = vs.length ? Math.max(...vs) : null; form = "set_config (variable)"; }
    }
  }
  const how: string[] = [];
  if (steps.some((s) => (s.retries ?? 0) > 0)) how.push("retries field");
  if (/\b(loop|while)\b/i.test(all) && /\bexception\b/i.test(all) && /(lock_not_available|55P03|lock_timeout|lock timeout|query_canceled)/i.test(all)) how.push("loop with a lock handler");
  return { locking_step: li < 0 ? null : li + 1, locking_kind: kind, lock_timeout_ms: ms, lock_timeout_max_ms: max, lock_timeout_form: form, nowait: /\bnowait\b/i.test(all), retries: how.length > 0, retry_how: how };
}
