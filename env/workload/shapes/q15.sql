/* shape:q15 */ \set a random(1, 20000)
/* shape:q15 */ select id, val, updated_at from prepared_part where account_id = :a order by updated_at desc limit 5 /* shape:q15 */;
