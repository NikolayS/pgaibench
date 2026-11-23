-- PGAIBench policy gate: per-node state snapshot (Σ). Emits ONE JSON document.
-- Run on EVERY node (primary and each standby), in the target database.
-- Requires PG16+ (last_idx_scan / last_seq_scan); written for PG18.
-- Read-only. Untested at authoring time (no Postgres in the authoring sandbox):
-- run against the lab once and fix before relying on it.
SELECT json_build_object(
  'collected_at',       now(),
  'server_version_num', current_setting('server_version_num')::int,
  'database',           current_database(),
  'in_recovery',        pg_is_in_recovery(),

  'settings', (
    SELECT coalesce(json_agg(json_build_object(
      'name', name, 'setting', setting, 'unit', unit, 'context', context,
      'vartype', vartype, 'min_val', min_val, 'max_val', max_val,
      'enumvals', enumvals, 'source', source, 'pending_restart', pending_restart
    ) ORDER BY name), '[]'::json)
    FROM pg_settings),

  'role_db_settings', (
    SELECT coalesce(json_agg(json_build_object(
      'role', r.rolname, 'database', d.datname, 'settings', s.setconfig)), '[]'::json)
    FROM pg_db_role_setting s
    LEFT JOIN pg_roles r    ON r.oid = s.setrole
    LEFT JOIN pg_database d ON d.oid = s.setdatabase),

  'replicas', (
    SELECT coalesce(json_agg(json_build_object(
      'application_name', application_name, 'client_addr', client_addr,
      'state', state, 'sync_state', sync_state, 'sync_priority', sync_priority,
      'replay_lag_s', extract(epoch FROM replay_lag))), '[]'::json)
    FROM pg_stat_replication),

  'wal_receiver', (
    SELECT row_to_json(w) FROM (
      SELECT status, sender_host, sender_port, slot_name FROM pg_stat_wal_receiver
    ) w),

  'slots', (
    SELECT coalesce(json_agg(json_build_object(
      'slot_name', slot_name, 'slot_type', slot_type, 'active', active)), '[]'::json)
    FROM pg_replication_slots),

  'sessions', (
    SELECT json_build_object(
      'client_backends',   count(*),
      'idle',              count(*) FILTER (WHERE state = 'idle'),
      'idle_in_txn',       count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
      'oldest_xact_age_s', extract(epoch FROM max(now() - xact_start)))
    FROM pg_stat_activity
    WHERE backend_type = 'client backend'),

  'locks', (
    SELECT coalesce(json_agg(json_build_object(
      'relation', l.relation::regclass::text, 'mode', l.mode, 'granted', l.granted,
      'pid', l.pid, 'xact_age_s', extract(epoch FROM now() - a.xact_start))), '[]'::json)
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'relation'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.pid <> pg_backend_pid()),

  -- Note: pg_total_relation_size() is 0 for a partitioned parent; sum partitions if needed.
  'relations', (
    SELECT coalesce(json_agg(json_build_object(
      'name', c.oid::regclass::text, 'kind', c.relkind, 'persistence', c.relpersistence,
      'total_bytes', pg_total_relation_size(c.oid), 'reltuples', c.reltuples,
      'reloptions', c.reloptions, 'replica_identity', c.relreplident)), '[]'::json)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp%'),

  -- PG18 stores NOT NULL constraints in pg_constraint (contype 'n') with convalidated.
  'constraints', (
    SELECT coalesce(json_agg(json_build_object(
      'name', con.conname, 'type', con.contype, 'validated', con.convalidated,
      'table', con.conrelid::regclass::text,
      'index', CASE WHEN con.conindid <> 0 THEN con.conindid::regclass::text END,
      'definition', pg_get_constraintdef(con.oid))), '[]'::json)
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE con.conrelid <> 0
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')),

  'indexes', (
    SELECT coalesce(json_agg(json_build_object(
      'index', i.indexrelid::regclass::text, 'table', i.indrelid::regclass::text,
      'valid', i.indisvalid, 'primary', i.indisprimary, 'unique', i.indisunique,
      'replident', i.indisreplident,
      'total_bytes', pg_relation_size(i.indexrelid))), '[]'::json)
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'),

  -- Node-local counters: on a standby these reflect STANDBY reads (the L9 blind spot).
  'index_usage', (
    SELECT coalesce(json_agg(json_build_object(
      'index', indexrelid::regclass::text, 'table', relid::regclass::text,
      'idx_scan', idx_scan, 'last_idx_scan', last_idx_scan)), '[]'::json)
    FROM pg_stat_user_indexes),

  'table_usage', (
    SELECT coalesce(json_agg(json_build_object(
      'table', relid::regclass::text,
      'seq_scan', seq_scan, 'last_seq_scan', last_seq_scan,
      'idx_scan', idx_scan, 'last_idx_scan', last_idx_scan,
      'n_live_tup', n_live_tup, 'n_dead_tup', n_dead_tup)), '[]'::json)
    FROM pg_stat_user_tables)
) AS snapshot;
