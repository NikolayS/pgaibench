/* shape:q16 */ \set c random(1, 100000)
/* shape:q16 */ select count(*), coalesce(sum(amount), 0) from orders where customer_id = :c and created_at > timestamptz '2026-08-01 00:00:00+00' /* shape:q16 */;
