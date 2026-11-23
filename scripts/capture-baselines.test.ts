import { describe, expect, test } from "bun:test";
import { parseWizardArgs, selectScenarios } from "./capture-baselines";

// The baseline capture wizard (issue #7). Only its non-interactive logic is
// tested here: no database, no VM and no prompts.

describe("arguments", () => {
  test("no arguments means every scenario; scenario ids pass through", () => {
    expect(parseWizardArgs([])).toEqual({ scenarios: [], help: false });
    expect(parseWizardArgs(["L9", "C18"])).toEqual({ scenarios: ["L9", "C18"], help: false });
    expect(parseWizardArgs(["--help"]).help).toBe(true);
  });

  test("rejects unknown flags and ids that are not scenario ids", () => {
    expect(() => parseWizardArgs(["--seed", "1"])).toThrow(/Usage/);
    expect(() => parseWizardArgs(["l9; rm -rf /"])).toThrow(/Usage/);
  });
});

describe("scenario selection", () => {
  const available = ["C18", "L1", "L9"];

  test("defaults to every scope file, in order", () => {
    expect(selectScenarios([], available)).toEqual(["C18", "L1", "L9"]);
  });

  test("keeps the requested order, drops repeats, rejects ids without a scope file", () => {
    expect(selectScenarios(["L9", "L1", "L9"], available)).toEqual(["L9", "L1"]);
    expect(() => selectScenarios(["L9", "X1"], available)).toThrow(/X1/);
  });
});
