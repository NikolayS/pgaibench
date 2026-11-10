/* shape:q18 */ \set aid random(9000001, 10000000)
\set delta random(-5000, 5000)
/* shape:q18 */ update pgbench_accounts set abalance = abalance + :delta where aid = :aid /* shape:q18 */;
