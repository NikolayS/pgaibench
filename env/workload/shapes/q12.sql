/* shape:q12 */ \set bid random(1, 100)
/* shape:q12 */ select b.bid, b.bbalance, sum(t.tbalance) from pgbench_branches b join pgbench_tellers t on t.bid = b.bid where b.bid = :bid group by b.bid, b.bbalance /* shape:q12 */;
