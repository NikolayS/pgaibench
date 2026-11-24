-- A small schema for the snapshot smoke test (snapshot.smoke.ts, #21): one
-- of each relation kind, constraint type and dependency the snapshot SQL
-- reads, plus pg_stat_statements rows. Not a model of the lab dataset.
CREATE EXTENSION pg_stat_statements;
CREATE SCHEMA ops;
CREATE TABLE ops.jobs (id int PRIMARY KEY);
CREATE TABLE public.customers (id int PRIMARY KEY, email text UNIQUE);
CREATE TABLE public.orders (
  id int PRIMARY KEY, customer_id int REFERENCES public.customers (id), status text, created_at timestamptz
) WITH (autovacuum_enabled = false, fillfactor = 90);
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (status <> '') NOT VALID;
CREATE INDEX orders_status_idx ON public.orders (status);
CREATE TABLE public.order_items (order_id int REFERENCES public.orders (id), qty int);
CREATE UNLOGGED TABLE public.scratch (id int);
CREATE TABLE public.events (id bigint, at date) PARTITION BY RANGE (at);
CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE VIEW public.orders_overview AS SELECT id, status FROM public.orders;
CREATE MATERIALIZED VIEW public.orders_totals AS SELECT status, count(*) AS n FROM public.orders GROUP BY status;
CREATE SEQUENCE public.ticket_seq;
CREATE TYPE public.order_status_enum AS ENUM ('new', 'paid');
CREATE TABLE public.order_status_history (id int, status public.order_status_enum);
CREATE ROLE app;
ALTER ROLE app IN DATABASE postgres SET work_mem = '8MB';
INSERT INTO public.customers SELECT g, 'c' || g FROM generate_series(1, 100) g;
INSERT INTO public.orders SELECT g, 1 + g % 100, CASE WHEN g % 2 = 0 THEN 'new' ELSE 'paid' END, now() FROM generate_series(1, 1000) g;
ANALYZE;
SET enable_seqscan = off;
SELECT count(*) FROM public.orders WHERE status = 'new';
RESET enable_seqscan;
