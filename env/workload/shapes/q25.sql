/* shape:q25 */ \set i random(1, 5000000)
/* shape:q25 */ select amount, status from orders where id = :i /* shape:q25 */;
