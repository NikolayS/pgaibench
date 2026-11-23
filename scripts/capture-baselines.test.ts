import { describe, expect, test } from "bun:test";
import {
  captureEnv, missingSetupFiles, parseWizardArgs, redactSecret, selectScenarios, stagePlan, upsertEnv,
} from "./capture-baselines";

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

describe("step plan", () => {
  test("four setup stages, one capture stage per scenario, then reset and commit", () => {
    expect(stagePlan(["L9", "C18"])).toEqual([
      "Pick the lab VM",
      "Copy env/ to the VM",
      "Postgres password",
      "Private setup files for corpus scenarios",
      "Capture L9",
      "Capture C18",
      "Reset the VM",
      "Validate and commit",
    ]);
  });

  test("only scenarios that require a private setup file, and lack it on the VM, are missing", () => {
    const plans = {
      L9: { requireSetup: false },
      C18: { requireSetup: true },
      O1: { requireSetup: true },
    };
    const onVm = new Set(["O1"]);
    expect(missingSetupFiles(["L9", "C18", "O1"], (id) => plans[id as keyof typeof plans], (id) => onVm.has(id)))
      .toEqual(["C18"]);
  });

  test("by default the check uses the real plans: public L9 needs none, corpus-only C18 does", () => {
    expect(missingSetupFiles(["L9", "C18"], undefined, () => false)).toEqual(["C18"]);
  });
});

describe("secrets", () => {
  test("the password is masked in anything we echo; the lab default and no password leave text alone", () => {
    expect(redactSecret("auth failed for s3cr3t-pw at s3cr3t-pw", "s3cr3t-pw")).toBe("auth failed for <redacted> at <redacted>");
    expect(redactSecret("cd /opt/pgaibench/env", "pgaibench")).toBe("cd /opt/pgaibench/env");
    expect(redactSecret("plain", undefined)).toBe("plain");
  });

  test("the password reaches the capture process only through its environment, and only when given", () => {
    const base = { PATH: "/bin", PGAIBENCH_PG_PASSWORD: "stale" };
    expect(captureEnv(base, "s3cr3t-pw")).toEqual({ PATH: "/bin", PGAIBENCH_PG_PASSWORD: "s3cr3t-pw" });
    expect(captureEnv(base, undefined)).toEqual({ PATH: "/bin" });
    expect(base.PGAIBENCH_PG_PASSWORD).toBe("stale");
  });

  test(".env gets the seed number but refuses any credential key", () => {
    expect(upsertEnv("A='1'\nPGAIBENCH_BASELINE_SEED='1'\n", "PGAIBENCH_BASELINE_SEED", "2"))
      .toBe("A='1'\nPGAIBENCH_BASELINE_SEED='2'\n");
    expect(upsertEnv("", "PGAIBENCH_BASELINE_SEED", "it's")).toBe("PGAIBENCH_BASELINE_SEED='it'\\''s'\n");
    for (const key of ["PGAIBENCH_PG_PASSWORD", "PGPASSWORD", "OPENAI_API_KEY", "GH_TOKEN", "SOME_SECRET"]) {
      expect(() => upsertEnv("", key, "x")).toThrow(/credential/);
    }
  });
});
