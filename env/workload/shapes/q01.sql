/* shape:q01 */ \set aid random(1, 10000000)
/* shape:q01 */ select abalance from pgbench_accounts where aid = :aid /* shape:q01 */;
