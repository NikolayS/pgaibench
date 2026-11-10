/* shape:q08 */ \set id random(4500001, 5000000)
\set s random(1, 5)
/* shape:q08 */ update orders set status = (array['new', 'paid', 'shipped', 'delivered', 'returned'])[:s] where id = :id /* shape:q08 */;
