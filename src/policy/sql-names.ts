// Postgres prints a regclass value without its schema for any relation on
// search_path. The policy gate keys rules on schema-qualified names, so the
// snapshot SQL must build names from nspname and relname, never by printing a
// regclass. See src/policy/sql-names.test.ts.

/**
 * 1-based line numbers where SQL casts a non-literal to regclass, with
 * `x::regclass` or `CAST(x AS regclass)`. A quoted literal cast
 * (`'pg_class'::regclass`, `CAST('pg_class' AS regclass)`) only compares
 * oids and is allowed, as is `to_regclass(...)`. `--` comments are ignored;
 * string literals are emptied first, so a `--` inside one is not a comment.
 */
export function regclassRenders(sql: string): number[] {
  const lines: number[] = [];
  sql.split("\n").forEach((line, i) => {
    const code = line.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, "");
    if (/(?<!')::\s*regclass\b/i.test(code) || /(?<!'\s*)\bAS\s+regclass\b/i.test(code)) lines.push(i + 1);
  });
  return lines;
}
