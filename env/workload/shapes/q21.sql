/* shape:q21 */ \set aid random(1, 10000000)
/* shape:q21 */ select abalance from pgbench_accounts where aid = :aid /* shape:q21 */;
