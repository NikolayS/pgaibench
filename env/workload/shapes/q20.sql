/* shape:q20 */ \set i random(1, 100000)
/* shape:q20 */ select v from secret_lookup where k = 'k' || :i /* shape:q20 */;
