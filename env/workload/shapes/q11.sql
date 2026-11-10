/* shape:q11 */ \set id random(1, 2000000)
/* shape:q11 */ select id, kind, payload, created_at from events where id = :id /* shape:q11 */;
