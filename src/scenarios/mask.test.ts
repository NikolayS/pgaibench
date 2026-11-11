import { describe, expect, test } from 'bun:test';
import { renderSteps } from './patterns';

/* Rule (SPEC, text patterns): patterns see executed SQL only.
   - Comments: removed.
   - Dollar-quoted bodies after DO, AS (function body) or EXECUTE: executed, matched.
   - Single-quoted literals after EXECUTE or EXECUTE format(: executed, matched.
   - Any other literal (single- or dollar-quoted) whose text looks like a SQL
     statement (DDL/DML keyword followed by a space): masked to '?'.
   - Other literals (values, setting names, dates) keep their text. */
const r = (sql: string) => renderSteps([{ sql }]);
const DROP = /drop\s+index/i, CREATE = /create\s+index/i;

describe('patterns never match text that is not executed', () => {
  const executed: [string, string, RegExp][] = [
    ['plain statement', 'DROP INDEX foo', DROP],
    ['DO body', 'DO $$ BEGIN DROP INDEX foo; END $$', DROP],
    ['DO body, named tag', 'DO $g$ BEGIN DROP INDEX foo; END $g$', DROP],
    ['DO with LANGUAGE', 'DO LANGUAGE plpgsql $$ BEGIN DROP INDEX foo; END $$', DROP],
    ['EXECUTE literal in DO', "DO $$ BEGIN EXECUTE 'DROP INDEX foo'; END $$", DROP],
    ['EXECUTE format in DO', "DO $$ BEGIN EXECUTE format('DROP INDEX %I', 'foo'); END $$", DROP],
    ['EXECUTE concatenation', "DO $$ BEGIN EXECUTE 'DROP INDEX ' || quote_ident('foo'); END $$", DROP],
    ['EXECUTE dollar literal', 'DO $$ BEGIN EXECUTE $q$DROP INDEX foo$q$; END $$', DROP],
    ['literal run through a variable (EXECUTE s): body literals stay', "DO $$ DECLARE s text := 'DROP INDEX foo'; BEGIN EXECUTE s; END $$", DROP],
    ['function body', 'CREATE FUNCTION f() RETURNS void AS $f$ DROP INDEX foo $f$ LANGUAGE sql', DROP],
  ];
  for (const [name, sql, re] of executed) test(`matched: ${name}`, () => expect(re.test(r(sql))).toBe(true));

  const inert: [string, string, RegExp][] = [
    ['pg_get_indexdef comparison', "SELECT pg_get_indexdef(i.indexrelid) = 'CREATE INDEX x ON public.t USING btree (bid)' FROM pg_index i", CREATE],
    ['format without EXECUTE', "SELECT format('DROP INDEX %I', 'foo')", DROP],
    ['RAISE message', "DO $$ BEGIN RAISE EXCEPTION 'run DROP INDEX foo first'; END $$", DROP],
    ['RAISE NOTICE with format args', "DO $$ BEGIN RAISE NOTICE 'next: drop index %', 'foo'; END $$", DROP],
    ['line comment', '-- DROP INDEX foo\nSELECT 1', DROP],
    ['block comment', '/* DROP INDEX foo */ SELECT 1', DROP],
    ['dollar literal in SELECT', 'SELECT $q$DROP INDEX foo$q$', DROP],
    ['literal in a DO body assignment', "DO $$ DECLARE s text := 'DROP INDEX foo'; BEGIN PERFORM 1; END $$", DROP],
  ];
  for (const [name, sql, re] of inert) test(`not matched: ${name}`, () => expect(re.test(r(sql))).toBe(false));

  const values: [string, string, string][] = [
    ['setting value', "SET lock_timeout = '500ms'", "'500ms'"],
    ['update value', "UPDATE orders SET status = 'cancelled' WHERE id = 1", "'cancelled'"],
    ['wal_level', "ALTER SYSTEM SET wal_level = 'minimal'", "'minimal'"],
    ['set_config', "SELECT set_config('lock_timeout', '1s', false)", "'lock_timeout'"],
    ['date', "DELETE FROM events WHERE created_at < '2026-08-01'", "'2026-08-01'"],
  ];
  for (const [name, sql, kept] of values) test(`value kept: ${name}`, () => expect(r(sql)).toContain(kept));
});
