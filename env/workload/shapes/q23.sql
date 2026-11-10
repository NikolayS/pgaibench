/* shape:q23 */ begin;
/* shape:q23 */ select 1 from public.:"inj_table" limit 1 /* shape:q23 */;
/* run_injector holds this transaction idle, then sends commit. */
