# TLA+ model of rule R-2

`HotStandbyParam.tla` models one hot-standby setting (for example
`max_connections`) moving from `Old` to `New` on a primary and one standby.
`conf` is the value ALTER SYSTEM writes, and `run` is the value in effect,
which changes only on restart. `Safe` says the standby's running value never
drops below the primary's, or WAL replay pauses. R-2 in
`src/policy/rules.yaml` cites this model.

The model checks the rule's design, not its code: nothing ties it to
`hotStandbyOrder` in `src/policy/checks/replication.ts`, which the review
tests from issue #9 cover. We run it by hand, not in CI (#16).

## Configs and results

| Config | Spec | Expected | TLC result (2026-11-24) |
|---|---|---|---|
| `HotStandbyParam.cfg` | guarded, raise 64 to 256 | `Safe` holds and `EventuallyDone` holds | no error; 7 distinct states |
| `HotStandbyParam_lower.cfg` | guarded, lower 256 to 64 | `Safe` holds and `EventuallyDone` holds | no error; 7 distinct states |
| `HotStandbyParam_unguarded.cfg` | unguarded | `Safe` violated | violated after `SetConf(primary)`, `Restart(primary)` (exit 12) |

So the guard is safe in both directions and never stops the change from
finishing, and without it a primary-first restart breaks `Safe` when raising.

## Running TLC

We used `tla2tools.jar` from the TLA+ v1.7.4 release (TLC 2.19, 8 August
2024), sha256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`,
on the `eclipse-temurin:21-jre` image, with no network. From the repo root,
with the jar in a directory of its own:

```bash
for cfg in HotStandbyParam HotStandbyParam_lower HotStandbyParam_unguarded; do
  docker run --rm --network none \
    -v "$PWD/docs/policy-gate/tla:/m:ro" -v "/path/to/tla2tools.jar:/t/tla2tools.jar:ro" -w /tmp \
    eclipse-temurin:21-jre java -cp /t/tla2tools.jar tlc2.TLC -workers 1 -metadir /tmp/states \
    -config "/m/$cfg.cfg" /m/HotStandbyParam.tla
done
```

TLC exits 0 when no error is found, and 12 on an invariant violation.
