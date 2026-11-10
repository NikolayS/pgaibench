/* shape:q02 */ \set aid random(9000001, 10000000)
\set bid random(1, 100)
\set tid random(1, 1000)
\set delta random(-5000, 5000)
/* shape:q02 */ begin;
/* shape:q02 */ update pgbench_accounts set abalance = abalance + :delta where aid = :aid /* shape:q02 */;
/* shape:q02 */ select abalance from pgbench_accounts where aid = :aid /* shape:q02 */;
/* shape:q02 */ update pgbench_tellers set tbalance = tbalance + :delta where tid = :tid /* shape:q02 */;
/* shape:q02 */ update pgbench_branches set bbalance = bbalance + :delta where bid = :bid /* shape:q02 */;
/* shape:q02 */ insert into pgbench_history (tid, bid, aid, delta, mtime) values (:tid, :bid, :aid, :delta, current_timestamp) /* shape:q02 */;
/* shape:q02 */ end;
