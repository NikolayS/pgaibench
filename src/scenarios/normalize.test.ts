import { expect, test } from 'bun:test';
import { normalizeSql } from './normalize';

const cases: [string, string, string][] = [
  ['comments and whitespace', "UPDATE  orders\n  SET status = 'x' -- note\n /* c */ WHERE id = 1", "update orders set status = 'x' where id = 1"],
  ['literals keep case and spaces', "SELECT 'Hello  World'", "select 'Hello  World'"],
  ['doubled quote inside a literal', "select 'it''s  A'", "select 'it''s  A'"],
  ['schema qualified name', 'update public.orders set a = 1', 'update orders set a = 1'],
  ['quoted identifiers', 'update "public"."orders" set "status" = 1', 'update orders set status = 1'],
  ['quoted identifier that needs quotes stays', 'select "Mixed Case"', 'select "Mixed Case"'],
  ['typed literal', "where created_at < TIMESTAMPTZ '2026-01-01 00:00:00+00'", "where created_at < '2026-01-01 00:00:00+00'"],
  ['typed literal, long type name', "where t < timestamp with time zone '2026-01-01'", "where t < '2026-01-01'"],
  ['cast on a literal', "where created_at < '2026-01-01'::timestamptz", "where created_at < '2026-01-01'"],
  ['cast on a literal, two words', "where t < '2026-01-01' :: timestamp with time zone", "where t < '2026-01-01'"],
  ['CAST function on a literal', "where t < CAST('2026-01-01' AS timestamptz)", "where t < '2026-01-01'"],
  ['cast on a column stays', 'where substr(k, 2)::int between 1 and 1000', 'where substr(k, 2)::int between 1 and 1000'],
  ['ONLY', 'UPDATE ONLY orders SET a = 1; ALTER TABLE ONLY orders ADD x int', 'update orders set a = 1; alter table orders add x int'],
  ['UPDATE alias with AS', "UPDATE orders AS o SET status = 'delivered' WHERE o.id < 5", "update orders set status = 'delivered' where o.id < 5"],
  ['UPDATE alias without AS', "update orders o set status = 'd'", "update orders set status = 'd'"],
  ['DELETE alias', 'delete from events e where e.id < 5', 'delete from events where e.id < 5'],
  ['DELETE without alias stays', 'delete from events where id < 5', 'delete from events where id < 5'],
  ['USING btree in CREATE INDEX', 'CREATE INDEX CONCURRENTLY i ON public.orders USING btree (external_ref)', 'create index concurrently i on orders (external_ref)'],
  ['other index methods stay', 'create index i on orders using gin (tags)', 'create index i on orders using gin (tags)'],
  ['SET SESSION', "SET SESSION lock_timeout = '1s'", "set lock_timeout = '1s'"],
  ['SET LOCAL stays', "SET LOCAL lock_timeout = '1s'", "set local lock_timeout = '1s'"],
  ['dollar-quoted body is normalised too', "DO $$ BEGIN\n  UPDATE orders AS o SET status = 'x'; -- c\nEND $$", "do $$ begin update orders set status = 'x'; end $$"],
  ['tagged dollar quote', 'do $body$ begin perform 1; end $body$', 'do $body$ begin perform 1; end $body$'],
  ['E string with backslash escape', "select E'a\\'b  C'", "select e'a\\'b  C'"],
];

for (const [label, input, want] of cases) test(`normalizeSql: ${label}`, () => expect(normalizeSql(input)).toBe(want));
