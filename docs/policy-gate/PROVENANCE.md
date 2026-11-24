# Provenance

Designed in a Claude web session on 2026-11-22, starting from the PGAIBench v0.2
blog post and evolving through: (1) does the benchmark constrain actions with a
state machine or invariants? (no: only runtime thresholds over a clone window);
(2) is modeling control-plane state transitions feasible? (yes, as plan validation
over an abstract, safety-relevant state, not exhaustive model checking); (3) draft
the action vocabulary and preconditions for the public scenarios.

## Verified at authoring time (read directly)

- Blog: https://postgres.ai/blog/20261123-pgaibench (v0.2 results, AAA, P2 gate
  rules, Track 2 escapes, limits).
- Site home: https://pgaibench.dev/ (v0.2 summary, Track 1/Track 2 tables).
- Scenario catalog: https://pgaibench.dev/scenarios/ (pgaibench-core 0.1.1: 19
  scored public scenarios, 6 unscored; one-line task and trap per scenario).
- Repo README: https://github.com/NikolayS/pgaibench (layout, conventions: tool-free
  models, prompts/ frozen, held-out not in repo, bun test offline).

## Assumed / not verified

- The harness's change-request schema and where rehearsal/P2 live in `src/`.
- Where the v0.2-only scenario IDs (C18, O1, O2, O3, S1, R18) are defined.
- Scenario details beyond one-line trap descriptions (spec/04 is paper analysis).
- `libpg-query` npm package compatibility with bun.
- **SQL in `sql/` was not executed** (no Postgres in the authoring sandbox).
- **TLA+ model was not run through TLC** (no tla2tools.jar available).
- Default thresholds (`S_scan`, `S_drop`, `A_txn`, `B`) are judgment calls.

## Companion doc

Readable version: https://claude.ai/artifact/DCTGssfGjx9u2USeoU8wcL
