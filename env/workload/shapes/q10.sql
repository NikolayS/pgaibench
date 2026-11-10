/* shape:q10 */ \set id random(1800001, 2000000)
/* shape:q10 */ update events set payload = md5(payload) where id = :id /* shape:q10 */;
