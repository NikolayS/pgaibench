# Coding standards

Judgement calls for review. Anything a check can enforce lives in
`bun run check` instead.

## Fakes of Postgres output match what the SQL returns

A test that fakes a Postgres answer must answer the way Postgres would for
the SQL the code actually sends: the same column names, types and name
rendering. Prefer rows captured from a real run (the lab, see
`env/README.md`) over rows written by hand. When the fake has to be written by
hand, derive it from the query, and say in a comment where its shape comes
from.

Why: a fake shaped like what the code expects, rather than what Postgres
returns, hides bugs in the SQL. The snapshot SQL once printed names through a
regclass cast, which drops the schema, and six rules would have silently
skipped on real data. The collector test passed because its fake rows were
already schema-qualified (`src/policy/snapshot-collect.test.ts` now renders as
Postgres does; `src/policy/sql-names.test.ts` blocks that cast).

## A policy rule test asserts its own rule, not the whole gate

A test for one policy rule asserts the findings of that rule, and of default
deny, with `fired()` from `src/policy/test-kit.ts`. It does not assert the
full list of findings, or a whole-gate verdict that another rule could change:
approve, defer or escalate. A reject verdict is fine, since no rule outranks
it. Other whole-gate verdicts belong in `src/policy/review.test.ts`, where
`onlyRules()` silences every rule the test does not name, and in
`src/policy/golden.test.ts` over the reference and corpus change requests.

Why: a near miss that expects `{ verdict: "approve", findings: [] }` also
asserts that every other rule stays silent, so a rule added by another ticket
breaks it. In the spec #1 run this broke the L-1 and X-1 fixtures across
parallel tickets (issue #20). Including default deny keeps a near miss from
passing only because its statement no longer classifies.

## Classifier facts land before the rule tickets that use them

When several rule tickets will need the same new fact from the classifier
(a new action kind, a field on `ClassifiedAction`, a new statement type, or
how statements group into transactions), we add that fact in its own PR
first, with its tests, and the rule tickets build on it. A rule ticket does
not add its own version of a fact another ticket also needs.

Why: in the spec #1 run, tickets #8 and #10 were written in parallel and each
added its own DML classification and its own grouping of actions by
transaction. The duplicates compiled, and one set of DML cases could never be
reached (fixed in `5f42deb50`). Splitting the classifier into one module per
statement family (`src/policy/classify/`) removes the merge conflicts, but
not the duplicated concepts (issue #20).

## A check sees only the actions its rule applies to

`review.ts` passes each check only the actions its rule's `applies_to`
selects in `src/policy/rules.yaml`. A rule that lists action kinds has a
`forKinds` check for exactly those kinds; `src/policy/checks/registry.test.ts`
holds the two equal. When a check needs a fact about another action (an
earlier step, the same transaction), the classifier records that fact on the
action the rule judges; the check does not search the other actions.

Why: before C5 (issue #20) each check repeated its rule's action filter by
hand, and only 3 of 30 read `applies_to`, so the rule data and the code could
disagree unseen. L-4 also read actions outside its `applies_to` to find a
validated NOT NULL proof; the classifier now records it as `proof_step`.
