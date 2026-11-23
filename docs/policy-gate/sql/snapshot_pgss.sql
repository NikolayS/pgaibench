-- pg_stat_statements for the current database on THIS node. Run only if the
-- extension exists (collect-snapshot.sh checks). On a standby this reflects
-- standby-local queries, provided pg_stat_statements is in shared_preload_libraries there.
SELECT coalesce(json_agg(json_build_object(
  'queryid', queryid, 'query', query, 'calls', calls,
  'mean_exec_time_ms', mean_exec_time, 'rows', rows)), '[]'::json) AS pgss
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database());
