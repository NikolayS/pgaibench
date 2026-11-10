/* shape:q07 */ \set id random(1, 5000000)
/* shape:q07 */ select id, customer_id, amount, status from orders where external_ref = 'ref-' || :id /* shape:q07 */;
