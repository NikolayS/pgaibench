/* shape:q14 */ \set id random(1, 1280000)
\set v random(0, 999)
/* shape:q14 */ update prepared_part set val = :v, updated_at = current_timestamp where id = :id /* shape:q14 */;
