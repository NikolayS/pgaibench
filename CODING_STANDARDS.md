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
