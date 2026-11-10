/* shape:q04 */ \set aid random(1, 10000000)
\set tid random(1, 1000)
\set bid random(1, 100)
/* shape:q04 */ insert into pgbench_history (tid, bid, aid, delta, mtime) values (:tid, :bid, :aid, 0, current_timestamp) /* shape:q04 */;
