import { expect, test } from "bun:test";
import { join } from "node:path";
import ablation from "../../models.ablation.json";
import { loadModels, modelConfigSchema } from "./openrouter";

const main = loadModels(join(import.meta.dir, "../../models.v02.json"));

test("all 16 named v0.2 configurations pass the existing model loader", () => {
  expect(main.map((row) => row.id).sort()).toEqual([
    "openai/gpt-6.2-astra:high",
    "openai/gpt-6.2-astra",
    "openai/gpt-6.2-sol:high",
    "openai/gpt-6.2-sol",
    "openai/gpt-6-astra:high",
    "openai/gpt-6.1-sol:high",
    "anthropic/claude-fable-5.2:high",
    "anthropic/claude-fable-5.2:medium",
    "anthropic/claude-opus-5.5:high",
    "anthropic/claude-opus-5.5:medium",
    "anthropic/claude-sonnet-5.5:high",
    "anthropic/claude-sonnet-5.5:medium",
    "anthropic/claude-haiku-5.5:high",
    "google/gemini-4-carbon",
    "x-ai/grok-4.7",
    "z-ai/glm-5.3",
  ].sort());
});

test("main model IDs are unique, unquantized, routable and priced", () => {
  expect(new Set(main.map((row) => row.id)).size).toBe(main.length);
  for (const row of main) {
    expect(row).not.toHaveProperty("quantization");
    expect(["codex-cli", "claude-cli", "openrouter"]).toContain(row.access);
    expect(row.provider?.order.join("/") ?? "").not.toMatch(/fp8|mxfp4/i);
    expect(row.price_in).toBeGreaterThanOrEqual(0);
    expect(row.price_out).toBeGreaterThanOrEqual(0);
  }
});

test("subscription configurations resolve to the intended CLI model and effort", () => {
  for (const row of main.filter((row) => row.access === "codex-cli" || row.access === "claude-cli")) {
    const [model, effort = "medium"] = row.id.split("/")[1]!.split(":");
    expect(row.cli_model).toBe(row.access === "claude-cli" ? model!.replaceAll(".", "-") : model);
    expect(row.effort).toBe(effort);
  }
});

test("ablation entries document exclusions and do not overlap the main roster", () => {
  const mainIds = new Set(main.map((row) => row.id));
  expect(ablation.map((row) => row.id).sort()).toEqual([
    "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-pro-0813:high",
    "deepseek/deepseek-v4.1-flash-1017",
    "moonshotai/kimi-k3.1-pro",
    "qwen/qwen3.8-27b",
    "anthropic/claude-haiku-5.5",
  ].sort());
  for (const { ablation_reason, ...row } of ablation) {
    expect(ablation_reason.trim().length).toBeGreaterThan(0);
    expect(mainIds.has(row.id)).toBe(false);
    expect(modelConfigSchema.parse(row).id).toBe(row.id);
  }
});
