# PGAIBench policy gate: design pack

This pack carries a design worked out in a Claude web session (2026-11-22) into
Claude Code, for implementation as one or more PRs against
[NikolayS/pgaibench](https://github.com/NikolayS/pgaibench). We build it first in
the neptunestation-org fork, based on `main`, and upstream after the replay.

**The idea in one paragraph.** PGAIBench v0.2 showed that AI models acting alone
break live Postgres clusters, and that a deterministic clone gate (P2) plus an AI
Auditor (P3) catch most of it. Both of those checks are empirical: they run the
change and watch. Neither constrains *what may be proposed*. This pack adds a
deterministic **policy gate** in front of
P2: every change-request step is parsed (libpg_query), classified into a closed
vocabulary of typed control-plane actions, and checked against declared
policy rules evaluated on a live, per-node snapshot of cluster state. Anything
that doesn't parse to a known action is denied by default. This is plan
validation (one path checked against policy rules), not model checking (no
state-space enumeration), which is why it is tractable.

## How to use

The pack is installed at `docs/policy-gate/` on branch `feat/precondition-gate`.
Decisions made after import are in the repo's `GLOSSARY.md` and `docs/adr/`;
where they disagree with this pack, they win. The protocols are P4 (policy gate),
P5 (policy gate + clone gate), P6 (+ Auditor) and P4-tool, since P1 is already
the text-only Auditor protocol.

## Contents

| Path | What it is |
| --- | --- |
| `KICKOFF.md` | Copy-paste prompts for Claude Code (session 1 and follow-ups) |
| `00-context.md` | Background: PGAIBench v0.2, AAA, findings, gaps, why this gate |
| `spec/01-abstract-state.md` | The snapshot `Σ` the gate reads, per node |
| `spec/02-action-vocabulary.md` | 24 typed actions + libpg_query mapping + default deny |
| `spec/03-rules.md` | 30 policy rules, thresholds, verdicts |
| `spec/04-scenario-coverage.md` | Rules vs. every public scenario (paper analysis, to verify) |
| `spec/05-implementation-plan.md` | PR sequence, tests, experiment arms, preregistration |
| `spec/06-formal-methods.md` | Where TLA+ and SMT fit; how to run the included spec |
| `spec/07-limits-and-open-questions.md` | Known gaps and resolved open questions |
| `src/policy/rules.yaml` | The 30 rules as data (single source of truth for the engine; moved into the harness) |
| `sql/snapshot.sql` | Per-node state collector, emits one JSON document |
| `sql/snapshot_pgss.sql` | `pg_stat_statements` collector (run only if installed) |
| `sql/cascade_closure.sql` | Approximate `pg_depend` closure for `S-2` |
| `scripts/bootstrap.sh` | Clone + branch + install pack |
| `scripts/collect-snapshot.sh` | Runs the collectors against one node |
| `src/policy/gen-rules-md.ts` | Regenerates `spec/03-rules.md` from the rule data (`bun run policy:rules-md`) |
| `tla/HotStandbyParam.tla` + two `.cfg` | TLA+ model of rule `R-2`: unguarded (expect violation) and guarded (expect safe + done) |
| `sketch/types.ts` | Type sketch only; adapt to the harness's real types |
| `PROVENANCE.md` | Where this came from, what is verified vs. assumed (SQL and TLA+ were not executed) |

## Companion doc

The same spec, in readable form, lives in a Claude Doc:
https://claude.ai/artifact/DCTGssfGjx9u2USeoU8wcL
This pack is the implementation-oriented superset; if they disagree, the pack wins.
