/* shape:q13 */ \set a random(1, 20000)
/* shape:q13 */ select count(*), sum(val) from prepared_part where account_id = :a /* shape:q13 */;
