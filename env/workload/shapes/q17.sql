/* shape:q17 */ \set id random(1, 4999950)
/* shape:q17 */ select sum(amount), count(*) from orders where id between :id and :id + 50 /* shape:q17 */;
