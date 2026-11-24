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
