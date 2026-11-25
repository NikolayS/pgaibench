# 06 — Where formal methods fit

The gate itself is **plan validation**: check one proposed path against
preconditions on a snapshot. No state-space search at gate time, so no explosion.
Formal tools are used *offline*, on the rules and protocols, where state spaces are
tiny.

## TLA+ (ordering rules)

`tla/HotStandbyParam.tla` models rule R-2 for one hot-standby-critical setting on a
two-node cluster.

- `HotStandbyParam_unguarded.cfg`: unconstrained agent. TLC should report a `Safe`
  violation (SetConf primary, Restart primary) — the R8/C18 failure in miniature.
- `HotStandbyParam.cfg`: restarts gated by R-2. Expect `Safe` invariant to hold and
  `EventuallyDone` to hold (the guard does not block the legitimate change). Swap
  Old/New to check the lowering direction.

Run (needs Java and tla2tools.jar from https://github.com/tlaplus/tlaplus/releases):

```
java -cp tla2tools.jar tlc2.TLC -config HotStandbyParam_unguarded.cfg HotStandbyParam.tla
java -cp tla2tools.jar tlc2.TLC -config HotStandbyParam.cfg HotStandbyParam.tla
```

Next candidates: R-3 with N standbys and sync replication; X-2/X-4 as a model of
transaction boundaries and lock hold intervals; R-4 with FIRST/ANY quorum syntax.

## SMT (settings constraints)

R-1, R-2 and R-4 reduce to small linear constraints over integer settings. Today a
direct check is enough. If the rule set grows to cover interdependent settings
(memory budgets: `shared_buffers + max_connections * work_mem` vs RAM; worker pools:
`max_parallel_workers <= max_worker_processes`), encode the proposed post-state as
Z3 constraints and ask for satisfiability; an UNSAT core names the violated rules.

## Invariant oracles (SQL)

Each `step`-scoped rule is a SQL predicate over `Σ`. This is the same pattern as SQL
invariant oracles in pg_partition_magician: a named, versioned query that must
return no violating rows.

## Model-level property worth stating

For every public safe reference CR `c`: `gate(c) = pass`. For every trapped
reference `t` with coverage "full" in spec/04: `gate(t) ∈ {reject, defer, escalate}`.
Make both a test suite over `reference/`.
