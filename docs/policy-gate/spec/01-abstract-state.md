# 01 — Abstract state model `Σ`

The gate reads `Σ`, a snapshot taken from **every node** at gate time, plus a usage
history over window `W`. All fields come from standard catalog/stats views; only
`pg_stat_statements` is an extension. Collector: `sql/snapshot.sql`,
`sql/snapshot_pgss.sql`, wrapped by `scripts/collect-snapshot.sh`.

| Component | Fields | Source | Per node |
| --- | --- | --- | --- |
| Settings | name, setting, unit, context, vartype, min/max, enumvals, pending_restart | `pg_settings` | yes |
| Role/db settings | role, database, settings | `pg_db_role_setting` | primary |
| Topology | in_recovery, replicas (application_name, state, sync_state, replay_lag), wal receiver status, slots | `pg_is_in_recovery()`, `pg_stat_replication`, `pg_stat_wal_receiver`, `pg_replication_slots` | yes |
| Sessions | oldest client xact age, idle-in-txn count, total/idle client backends | `pg_stat_activity` | yes |
| Locks | relation, mode, granted, pid, xact age | `pg_locks` + `pg_stat_activity` | yes |
| Relations | name, kind, total size, reltuples, persistence, reloptions | `pg_class`, `pg_total_relation_size` | yes (sizes match on physical standby) |
| Constraints | name, type, validated, table, backing index, definition | `pg_constraint` | primary |
| Index usage | index, table, idx_scan, last_idx_scan | `pg_stat_user_indexes` | **yes, every node** |
| Table usage | seq_scan, idx_scan, last_seq_scan, last_idx_scan | `pg_stat_user_tables` | **yes, every node** |
| Query load | queryid, query text, calls, mean time | `pg_stat_statements` | **yes, every node** |
| Dependencies | `pg_depend` closure from a target | `sql/cascade_closure.sql`, computed per target at gate time | primary |
| Ticket scope | allowed objects/roles, forbidden action classes, max rows, cluster-scope flag, downtime allowed | harness, structured ticket fields | n/a |

## Notes

- **Usage needs deltas, not a snapshot.** `idx_scan` and `seq_scan` are cumulative
  per node and reset with stats. Take two snapshots `W` apart and diff, or use
  `last_idx_scan`/`last_seq_scan` (PG16+) as a cheaper "used within W" test.
  In the lab, `W` = the workload window before the CR is evaluated.
- **Standby stats are local to the standby.** That is the whole point for L9/R2.
- **Ticket scope is state.** The harness writes it; the Analyst never sees it as
  editable. Decide whether scenario authors write it by hand or a separate,
  sandboxed extractor derives it (open question).
- Snapshot JSON shape is defined by `sql/snapshot.sql`; the TS type sketch is in
  `sketch/types.ts`. Adapt to harness conventions.
