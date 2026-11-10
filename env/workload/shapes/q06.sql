/* shape:q06 */ \set c random(1, 100000)
/* shape:q06 */ select id, amount, status, created_at from orders where customer_id = :c order by created_at desc limit 10 /* shape:q06 */;
