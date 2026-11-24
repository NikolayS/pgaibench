-- PGAIBench policy gate: per-node state snapshot (Σ). Emits ONE JSON document.
-- Run on EVERY node (primary and each standby), in the target database.
-- Requires PG16+ (last_idx_scan / last_seq_scan); written for PG18.
-- Read-only. Smoke-tested on Postgres 18.4 against a small schema
-- (src/policy/snapshot.smoke.ts, bun run policy:smoke; #21). The lab capture
-- (#7) is its first run on the real dataset.
-- Relation names are always schema-qualified as nspname.relname, unquoted, the
-- way the classifier names them. We never render a name with a regclass cast,
-- which leaves off the schema for anything on search_path.
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
      'relation', ln.nspname || '.' || lc.relname, 'mode', l.mode, 'granted', l.granted,
      'pid', l.pid, 'xact_age_s', extract(epoch FROM now() - a.xact_start))), '[]'::json)
    FROM pg_locks l
    JOIN pg_class lc      ON lc.oid = l.relation
    JOIN pg_namespace ln  ON ln.oid = lc.relnamespace
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'relation'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.pid <> pg_backend_pid()),

  -- Note: pg_total_relation_size() is 0 for a partitioned parent; sum partitions if needed.
  'relations', (
    SELECT coalesce(json_agg(json_build_object(
      'name', n.nspname || '.' || c.relname, 'kind', c.relkind, 'persistence', c.relpersistence,
      'total_bytes', pg_total_relation_size(c.oid), 'reltuples', c.reltuples,
      'reloptions', c.reloptions, 'replica_identity', c.relreplident)), '[]'::json)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm', 'v', 'S', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp%'),

  -- PG18 stores NOT NULL constraints in pg_constraint (contype 'n') with convalidated.
  'constraints', (
    SELECT coalesce(json_agg(json_build_object(
      'name', con.conname, 'type', con.contype, 'validated', con.convalidated,
      'table', tn.nspname || '.' || t.relname,
      'index', CASE WHEN con.conindid <> 0 THEN xn.nspname || '.' || x.relname END,
      'references', CASE WHEN con.confrelid <> 0 THEN rn.nspname || '.' || r.relname END,
      'definition', pg_get_constraintdef(con.oid))), '[]'::json)
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    JOIN pg_class t       ON t.oid = con.conrelid
    JOIN pg_namespace tn  ON tn.oid = t.relnamespace
    LEFT JOIN pg_class x      ON x.oid = con.conindid
    LEFT JOIN pg_namespace xn ON xn.oid = x.relnamespace
    LEFT JOIN pg_class r      ON r.oid = con.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE con.conrelid <> 0
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')),

  'indexes', (
    SELECT coalesce(json_agg(json_build_object(
      'index', n.nspname || '.' || c.relname, 'table', tn.nspname || '.' || t.relname,
      'valid', i.indisvalid, 'primary', i.indisprimary, 'unique', i.indisunique,
      'replident', i.indisreplident,
      'total_bytes', pg_relation_size(i.indexrelid))), '[]'::json)
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t     ON t.oid = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp%'),

  -- Node-local counters: on a standby these reflect STANDBY reads (the L9 blind spot).
  'index_usage', (
    SELECT coalesce(json_agg(json_build_object(
      'index', schemaname || '.' || indexrelname, 'table', schemaname || '.' || relname,
      'idx_scan', idx_scan, 'last_idx_scan', last_idx_scan)), '[]'::json)
    FROM pg_stat_user_indexes),

  'table_usage', (
    SELECT coalesce(json_agg(json_build_object(
      'table', schemaname || '.' || relname,
      'seq_scan', seq_scan, 'last_seq_scan', last_seq_scan,
      'idx_scan', idx_scan, 'last_idx_scan', last_idx_scan,
      'n_live_tup', n_live_tup, 'n_dead_tup', n_dead_tup)), '[]'::json)
    FROM pg_stat_user_tables)
) AS snapshot;
