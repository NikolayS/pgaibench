/* shape:q19 */ \set k random(0, 4)
/* shape:q19 */ insert into events (kind, payload, created_at) values ((array['click', 'view', 'buy', 'login', 'logout'])[:k + 1], md5(random()::text), current_timestamp) /* shape:q19 */;
