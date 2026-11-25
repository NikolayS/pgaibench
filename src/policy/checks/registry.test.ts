import { describe, expect, test } from "bun:test";
import { loadRuleData } from "../rule-data";
import { CHECKS } from "./index";
import { kindsOf } from "./shared";

// rules.yaml's applies_to is the one authority for which actions a rule judges
// (#20, C5); review.ts filters by it. A rule that lists action kinds has a
// forKinds check narrowing to exactly those kinds, so code and rule data
// cannot drift. A rule on "all" or on lock strength (lock>=MODE) has no kinds.

describe("each check narrows to its rule's applies_to", () => {
  test.each(loadRuleData().rules.map((r) => [r.id, r.applies_to] as const))("%s", (id, appliesTo) => {
    const kinds = kindsOf(CHECKS[id]!);
    const listsKinds = appliesTo.some((e) => e !== "all" && !e.startsWith("lock>="));
    if (!listsKinds) return expect(kinds).toBeUndefined();
    expect([...(kinds ?? [])].sort() as string[]).toEqual([...appliesTo].sort());
  });
});
