import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationArm, generationCellDir, loadStoredCR } from "./generate";
import { requiredAccess } from "../llm/openrouter";
import { modelArms, storedCRFor } from "../run/batch";
import { parseArm } from "../run/episode";

// The lab maps an agy-cli row to its stored ag_* cells; the three existing access paths are unchanged.
test("access prefix per row", () => {
  expect(requiredAccess("google/gemini-4-carbon@agy")).toBe("agy-cli");
  expect(generationArm("google/gemini-4-carbon@agy", "v2")).toBe("ag_google_gemini-4-carbon@agy-v2");
  expect(generationArm("openai/gpt-6-astra", "v2")).toBe("cx_openai_gpt-6-astra-v2");
  expect(generationArm("anthropic/claude-opus-5.5", "v2")).toBe("cc_anthropic_claude-opus-5.5-v2");
  expect(generationArm("google/gemini-4-carbon", "v2")).toBe("or_google_gemini-4-carbon-v2");
  expect(requiredAccess("google/gemini-4-argon")).toBe("openrouter");
});

function fakeCell(out: string, scenario: string, model: string, sample: number) {
  const d = generationCellDir(out, scenario, model, "v2", sample); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "generation.json"), JSON.stringify({ status: "escalate", repair_rounds: 0, model_resolved: model }));
  writeFileSync(join(d, "cost.json"), JSON.stringify({ usd: 0, tokens: { calls: 1 } }));
  writeFileSync(join(d, "transcript.json"), "{}"); writeFileSync(join(d, "escalate.json"), JSON.stringify({ reason: "x" }));
  return d;
}

test("lab arm of an agy-cli row resolves to its stored ag_ cell; existing rows resolve as before", () => {
  const out = mkdtempSync(join(tmpdir(), "agy-"));
  for (const [m, pre] of [["google/gemini-4-carbon@agy", "ag_"], ["openai/gpt-6-astra", "cx_"], ["anthropic/claude-opus-5.5", "cc_"]] as const) {
    const d = fakeCell(out, "D5", m, 2);
    expect(d).toContain(`/D5-${pre}`);
    const arm = parseArm(modelArms([m])[0]!);
    expect(storedCRFor(arm, "D5", { fromGen: out, sample: 2 })!.source).toBe(d);
  }
});
