/* shape:q22 */ \set c random(1, 100000)
/* shape:q22 */ select status, count(*), sum(amount) from orders where customer_id = :c group by status /* shape:q22 */;
