/* shape:q03 */ \set aid random(1, 9999900)
/* shape:q03 */ select sum(abalance), count(*) from pgbench_accounts where aid between :aid and :aid + 100 /* shape:q03 */;
