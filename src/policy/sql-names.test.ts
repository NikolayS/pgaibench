import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { regclassRenders } from "./sql-names";

// Postgres renders a regclass value without its schema for any relation on
// search_path, so SQL that prints a name through a regclass cast gets
// "orders", not "public.orders", and rules keyed on qualified names silently
// skip. Review finding 1 on #6 was exactly this. The design pack's SQL is the
// only SQL the snapshot collector sends, so every file in it must be clean.

const SQL_DIR = join(import.meta.dir, "..", "..", "docs", "policy-gate", "sql");

describe("regclassRenders", () => {
  test("flags a regclass cast whose value is printed", () => {
    expect(regclassRenders("SELECT c.oid::regclass::text AS rel FROM pg_class c")).toEqual([1]);
    expect(regclassRenders("SELECT json_build_object(\n  'index', i.indexrelid::regclass\n)")).toEqual([2]);
    expect(regclassRenders("SELECT CAST(c.oid AS regclass) FROM pg_class c")).toEqual([1]);
  });

  test("allows a literal catalog name cast to regclass, which only compares oids", () => {
    expect(regclassRenders("WHERE d.classid = 'pg_class'::regclass")).toEqual([]);
    expect(regclassRenders("WHERE d.classid = CAST('pg_class' AS regclass)")).toEqual([]);
  });

  test("a -- inside a string literal does not hide a cast after it", () => {
    expect(regclassRenders("SELECT '--', c.oid::regclass FROM pg_class c")).toEqual([1]);
  });

  test("allows to_regclass and ignores comments", () => {
    expect(regclassRenders("SELECT to_regclass(:'target')::oid -- never c.oid::regclass::text")).toEqual([]);
  });
});

test("no SQL in docs/policy-gate/sql/ prints a name through a regclass cast", () => {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql"));
  expect(files.length).toBeGreaterThan(0);
  const offending = files.flatMap((f) => regclassRenders(readFileSync(join(SQL_DIR, f), "utf8")).map((line) => `${f}:${line}`));
  expect(offending).toEqual([]);
});
