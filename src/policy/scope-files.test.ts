import { describe, expect, test } from "bun:test";
import { buildCorpus } from "../control/corpus";
import { loadScenarios } from "../scenarios/schema";
import { listScopeIds, loadScope } from "./scope-files";

// Ticket scope files (issue #5): one hand-written sidecar per scenario,
// validated against the scope schema. Schema tests only; no database.

const publicIds = loadScenarios().map((s) => s.id);
const track2Ids = [...new Set(buildCorpus().map((i) => i.scenario))];
const replayIds = [...new Set([...publicIds, ...track2Ids])].sort();

describe("loading ticket scope", () => {
  test("an unknown scenario ID is an error, not an empty scope", () => {
    expect(() => loadScope("Z99")).toThrow(/no ticket scope.*Z99/i);
  });

  test("the replay covers the Track 2 scenarios that have no public scenario file", () => {
    for (const id of ["C18", "O1", "O2", "O3", "S1", "R18"]) expect(replayIds).toContain(id);
  });

  test.each(replayIds)("scenario %s has a scope file that validates", (id) => {
    expect(() => loadScope(id)).not.toThrow();
  });

  test("there is no scope file for a scenario the replay does not cover", () => {
    expect(listScopeIds()).toEqual(replayIds);
  });
});
