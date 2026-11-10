/* shape:q05 */ \set id random(1, 5000000)
/* shape:q05 */ select id, customer_id, amount, status, created_at from orders where id = :id /* shape:q05 */;
