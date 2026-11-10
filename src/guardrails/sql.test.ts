import { describe, expect, test } from 'bun:test';
import { lex, splitStatements, crStatements, parseDurationMs, parseBytes } from './sql';

describe('lexer', () => {
  test('splits on semicolons outside quotes, comments and dollar quotes', () => {
    const stmts = splitStatements(lex("set lock_timeout = '1s'; -- a;b\nselect 'x;y', \"a;b\" /* c; */ ; do $f$ begin perform 1; end $f$;"));
    expect(stmts.map(s => s.text)).toEqual(["set lock_timeout = '1s'", "select 'x;y' , a;b", 'do $f$ begin perform 1; end $f$']);
  });
  test('lowercases words, keeps string literals, handles escaped quotes', () => {
    expect(splitStatements(lex("UPDATE T SET a = 'It''s' WHERE ID=1"))[0].text).toBe("update t set a = 'It''s' where id = 1");
  });
  test('keeps multi-char operators', () => {
    expect(splitStatements(lex('select a::int from t where a <= 1 and b <> 2'))[0].text).toBe('select a :: int from t where a <= 1 and b <> 2');
  });
});

describe('crStatements', () => {
  test('expands do-block bodies as nested statements', () => {
    const cr: any = { steps: [{ sql: "do $$ begin set lock_timeout = '500ms'; alter table t add column c int; exception when lock_not_available then perform pg_sleep(1); end $$" }] };
    const nested = crStatements(cr).filter(s => s.nested).map(s => s.text);
    expect(nested).toContain("set lock_timeout = '500ms'");
    expect(nested).toContain('alter table t add column c int');
  });
});

describe('units', () => {
  test('durations', () => {
    expect(parseDurationMs("'500ms'")).toBe(500);
    expect(parseDurationMs('5s')).toBe(5000);
    expect(parseDurationMs('2000')).toBe(2000);
    expect(parseDurationMs("'1min'")).toBe(60000);
    expect(parseDurationMs('banana')).toBeNull();
  });
  test('bytes', () => {
    expect(parseBytes('64MB')).toBe(64 * 1024 ** 2);
    expect(parseBytes('2GB')).toBe(2 * 1024 ** 3);
    expect(parseBytes('1024', 'kB')).toBe(1024 * 1024);
    expect(parseBytes('16', '8kB')).toBe(16 * 8192);
    expect(parseBytes('1024')).toBeNull();
  });
});
