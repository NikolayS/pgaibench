/* shape:q26 */ \set i random(1, 2000000)
/* shape:q26 */ select kind, payload from events where id = :i /* shape:q26 */;
