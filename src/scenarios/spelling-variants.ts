import type { FixtureStep } from './patterns';

/* Test support: rewrite the SQL of a fixture into other spellings a
   competent engineer could write for the same statements. Each variant
   must classify exactly like the original (spellings.test.ts). Only code
   outside single-quoted literals is rewritten. */

const TABLES = ['orders', 'pgbench_accounts', 'pgbench_history', 'pgbench_tellers', 'pgbench_branches', 'events', 'secret_lookup', 'order_status_history'];
const KEYWORDS = /\b(select|from|where|and|or|not|update|set|delete|insert|into|values|alter|table|add|column|constraint|check|foreign|key|references|valid|validate|drop|index|concurrently|create|unique|on|using|if|exists|vacuum|analyze|full|verbose|begin|commit|end|do|loop|lock|nowait|in|mode|default|null|true|false|boolean|text|type|limit|returning|reset|local|to|attach|partition|for|values|cluster|truncate|only|rename|exception|when|then|raise|perform|declare|exit|while|is|between|any|cascade|role|database|system)\b/gi;

function outsideLiterals(sql: string, f: (code: string) => string): string {
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : f(part))).join('');
}

export type Variant = { name: string; rewrite: (sql: string) => string };

export const VARIANTS: Variant[] = [
  { name: 'upper-case keywords', rewrite: (s) => outsideLiterals(s, (c) => c.replace(KEYWORDS, (k) => k.toUpperCase())) },
  { name: 'schema-qualified quoted names', rewrite: (s) => outsideLiterals(s, (c) => c.replace(new RegExp(`(?<![\\w."$])(${TABLES.join('|')})(?![\\w"$])`, 'g'), (t, _n, off, all) => (/\b(?:on|from|update|table|into|join|references|vacuum|analyze|cluster|truncate|lock|only|exists|events)\s*(?:\([^)]*\)\s*)?$/i.test(all.slice(0, off)) ? `public."${t}"` : t))) },
  { name: 'line breaks and comments', rewrite: (s) => `/* reviewed */\n${outsideLiterals(s, (c) => c.split('--').map((p, i) => (i ? p : p.replace(/ +/g, '\n    '))).join('--'))}\n-- end of step` },
  { name: 'typed date literals', rewrite: (s) => s.replace(/(?<![\w:])'(\d{4}-\d{2}-\d{2}[^']*)'(?!\s*::)/g, "TIMESTAMPTZ '$1'") },
  { name: 'casts on date literals', rewrite: (s) => s.replace(/(?<![\w:])'(\d{4}-\d{2}-\d{2}[^']*)'(?!\s*::)/g, "'$1'::timestamptz") },
  { name: 'explicit USING btree', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/(\bcreate\s+(?:unique\s+)?index\b[^;(]*?\bon\s+(?:only\s+)?[\w."]+)\s*\(/gi, '$1 USING btree (')) },
  { name: 'UPDATE with an alias', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/\bupdate\s+((?:only\s+)?[\w."]+)\s+set\b/gi, 'UPDATE $1 AS u SET')) },
  { name: 'DELETE with an alias', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/\bdelete\s+from\s+((?:only\s+)?[\w."]+)\s+where\b/gi, 'DELETE FROM $1 AS d WHERE')) },
  { name: 'SET SESSION', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/(^|;\s*)set\s+(?!local\b|session\b)/gi, '$1SET SESSION ')) },
  { name: 'no optional COLUMN keyword', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/\b(add|alter|drop|rename)\s+column\b/gi, '$1')) },
  { name: 'optional COLUMN keyword added', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/\b(add|alter|drop)\s+(?!column\b|constraint\b|primary\b|unique\b|check\b|foreign\b|default\b|if\b|index\b|table\b|type\b|system\b|role\b|database\b|view\b|function\b|trigger\b|extension\b|schema\b|sequence\b|policy\b|rule\b|publication\b|subscription\b|materialized\b|owned\b|user\b|tablespace\b|statistics\b|server\b|domain\b|aggregate\b|operator\b|cast\b|collation\b|conversion\b|event\b|foreign\b|group\b|language\b|large\b|procedure\b|routine\b|transform\b|text\b|value\b|attribute\b|not\b|null\b|identity\b|expression\b|generated\b|exclude\b)(?=[a-z_]+\s)/gi, '$1 COLUMN ')) },
  { name: 'DROP INDEX IF EXISTS', rewrite: (s) => outsideLiterals(s, (c) => c.replace(/\bdrop\s+index\s+(concurrently\s+)?(?!if\b|concurrently\b)/gi, 'DROP INDEX $1IF EXISTS ')) },
];

export function rewriteSteps(steps: FixtureStep[], v: Variant): FixtureStep[] {
  return steps.map((st) => ('sql' in st ? { ...st, sql: v.rewrite(st.sql) } : st));
}
