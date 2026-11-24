# 02 — Action vocabulary

Every CR step must classify into exactly one of the 28 actions below, or the gate
rejects it (default deny). Classification uses the libpg_query parse tree (e.g. the
`libpg-query` npm package; verify it works under bun, else shell out to a small
helper), so the gate sees the real statement, not the Analyst's description.

`BEGIN`/`COMMIT`/`ROLLBACK` are transaction boundaries, not actions; the classifier
records which steps share a transaction (needed by X-rules).

| Action | Parse-tree match | Lock / effect | Transaction rule |
| --- | --- | --- | --- |
| `cfg.set_reload` | config step, `pg_settings.context` in (sighup, superuser) | effective on reload | outside txn |
| `cfg.set_restart` | config step, context = postmaster | sets `pending_restart` | outside txn |
| `cfg.set_role` | `AlterRoleSetStmt`, `AlterDatabaseSetStmt` | new sessions only | any |
| `cfg.set_session` | `VariableSetStmt` (incl. `SET LOCAL lock_timeout`) | current session | any |
| `node.reload` | `SelectStmt` whose only target is `pg_reload_conf()` | signals all backends on node | outside txn |
| `node.restart` | implied by every `cfg.set_restart`, once per node the step targets | drops all connections on node | n/a |
| `ddl.add_column` | `AlterTableStmt` / `AT_AddColumn` | brief ACCESS EXCLUSIVE; rewrite only with volatile default | any |
| `ddl.add_check_not_valid` | `AT_AddConstraint` (CHECK, NOT NULL, FK), `skip_validation = true` | brief lock, no scan; FK also locks referenced table | must COMMIT before matching validate |
| `ddl.validate_constraint` | `AT_ValidateConstraint` | SHARE UPDATE EXCLUSIVE during scan | own txn |
| `ddl.add_constraint_validating` | `AT_AddConstraint`, `skip_validation = false` | ACCESS EXCLUSIVE (SHARE ROW EXCLUSIVE for FK) across full scan | any |
| `ddl.set_not_null` | `AT_SetNotNull` | ACCESS EXCLUSIVE; scans unless a validated proof exists | any |
| `ddl.alter_column_type` | `AT_AlterColumnType` | ACCESS EXCLUSIVE; may rewrite | any |
| `ddl.drop_column` | `AT_DropColumn` | brief ACCESS EXCLUSIVE; irreversible | any |
| `ddl.set_reloption` | `AT_SetRelOptions`, `AT_ResetRelOptions` (SET and RESET in one statement are one action) | SHARE UPDATE EXCLUSIVE (autovacuum params) | any |
| `ddl.drop_constraint` | `AT_DropConstraint` without CASCADE | ACCESS EXCLUSIVE; a foreign key also locks the referenced table (from the snapshot) | any |
| `idx.create_concurrent` | `IndexStmt`, `concurrent = true` | SHARE UPDATE EXCLUSIVE; waits on old snapshots | outside txn |
| `idx.create_blocking` | `IndexStmt`, `concurrent = false` | SHARE; blocks writes | any |
| `idx.drop_concurrent` | `DropStmt`, `OBJECT_INDEX`, `concurrent = true` | SHARE UPDATE EXCLUSIVE | outside txn |
| `idx.drop_blocking` | `DropStmt`, `OBJECT_INDEX`, `concurrent = false` | ACCESS EXCLUSIVE on table | any |
| `obj.create` | `CreateStmt`, `ViewStmt`, `CreateTableAsStmt` | new object | any |
| `obj.drop` | `DropStmt` (table, type, view); behavior RESTRICT/CASCADE | ACCESS EXCLUSIVE; irreversible | any |
| `obj.truncate` | `TruncateStmt` | ACCESS EXCLUSIVE; replayed on standbys; irreversible | any |
| `ext.create` | `CreateExtensionStmt` | varies | any |
| `maint.vacuum_analyze` | `VacuumStmt` without FULL | SHARE UPDATE EXCLUSIVE | outside txn |
| `dml.bounded` | `UpdateStmt`, `DeleteStmt`, `InsertStmt` | ROW EXCLUSIVE; WAL scales with rows | any |
| `lock.table` | `LockStmt` | the mode it names (ACCESS EXCLUSIVE by default), held to COMMIT; changes nothing | inside a txn (denied outside one) |
| `priv.revoke` | `GrantStmt` revoking table or column privileges on named tables, RESTRICT | ACCESS SHARE (checked on Postgres 18.6); changes who may access the table | any |
| `query.read` | `SelectStmt` with no `INTO`, no locking clause, no data-modifying `WITH`, and only read-only built-in functions (ADR 0003) | ACCESS SHARE; writes nothing; touches no object for ticket scope | any |

## Default deny (reject, or escalate where noted)

`AlterSystemStmt` in a SQL step (settings go through config steps, ADR 0003),
`DoStmt` unless its body is plain SQL (a plain body is classified statement by statement, ADR 0005), `CreateFunctionStmt` in the same CR, `EXECUTE` of a built string,
`VACUUM FULL`, `CLUSTER`, `pg_terminate_backend`/`pg_cancel_backend` (escalate),
`ALTER SYSTEM RESET ALL`, `LOCK TABLE` outside a transaction, `DROP CONSTRAINT ... CASCADE`, `GRANT` and every other privilege change (`GRANT OPTION FOR`, `CASCADE`, `ALL TABLES IN SCHEMA`, non-table objects, role membership), a SELECT that calls a function not known to be
read-only or locks rows, any statement type not listed.

## Implementation notes

- Lock levels per command: PG18 docs, "Explicit Locking" table-level lock table and
  the per-command notes in the `ALTER TABLE` page. Encode as data next to the action.
- `cfg.*` classification needs `Σ.settings.context` to split reload vs restart.
- A `SET` inside the same session as later steps (e.g. `SET lock_timeout`) is
  tracked as session state for rule L-1, not as a standalone action outcome.
