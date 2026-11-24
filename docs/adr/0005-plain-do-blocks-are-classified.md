# The policy gate reads DO blocks whose body is plain SQL

A DO block whose body is only a list of SQL statements is classified as those
statements: same step, run in order, in one transaction. A `SET LOCAL` inside
it holds for the statements after it, to the end of that transaction, so L-1
sees the lock_timeout the block sets. "Plain" means PL/pgSQL with no declared
variables, no nested or labelled block, no exception handler, and no
statement other than plain SQL: no loop, IF, EXECUTE, PERFORM, INTO, RAISE,
COMMIT or RETURN. Every other DO block stays denied by default, and the denial
names what the gate cannot see. Each statement inside goes through the same
classifier as at top level, so ALTER SYSTEM, a session kill or an unknown
statement inside a plain DO block is denied as it would be on its own.

Many good references wrap one or two DDL statements in
`DO $$ BEGIN SET LOCAL lock_timeout = '1s'; ... END $$` (24 of the 27 DO
steps in the good references). Denying all of them falsely blocked 15 good
references and two safe twins, against preregistration criterion 1 (#22). A plain
body hides nothing: the parse tree gives every statement it runs. Loops,
branches and dynamic SQL do hide what runs, or how often, so those stay
denied; the three good references with batching loops (L7, R2, R6) get
replay overrides instead (#22).

## Considered Options

- Keep denying every DO block and add a replay override for each affected
  reference. Rejected: an Analyst that writes the same safe change the
  references do would be blocked in live runs, and the overrides would
  multiply.
- Keep denying every DO block and count the blocks as justified. Rejected:
  nothing in a plain body is hidden from the gate, so the block is not
  justified.
- Also read loops whose bounds are constants. Rejected: the row count and the
  number of transactions depend on the data, which the gate does not see, and
  a COMMIT inside the loop changes the transaction model L-1 and the X rules
  rely on.
