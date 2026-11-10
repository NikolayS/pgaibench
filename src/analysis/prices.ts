// Price table for the cost estimate. Checked 2026-11-03. None of these
// figures was read from the vendor's own price page; treat USD totals as
// estimates and re-check before publishing.
//
// - gpt-6-sol: $2.00 / 1M input, $10.00 / 1M output, $0.20 / 1M cached input.
//   Source: third-party aggregators (eesel.ai "GPT-6 Sol pricing",
//   developersdigest.tech/models/gpt-6-sol), searched 2026-11-03.
// - Claude 5.5 standard base input/output list prices. CLI total_cost_usd
//   takes precedence because it accounts for cache pricing and other tiers.
//   Sources: https://www.anthropic.com/claude-opus-5-5,
//   https://www.anthropic.com/claude-sonnet-5-5,
//   https://www.anthropic.com/claude-haiku-5-5 (checked 2026-11-04).
// - Hetzner ccx23 (fsn1): $0.139 / hour on demand. Source: spendark.com
//   /instances/ccx23 ("prices checked July 2026"), after the 2026-06-15
//   Hetzner repricing. Hetzner's own page not checked.

export const TOKEN_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-6-sol": { input: 2.0, output: 10.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const VM_USD_PER_HOUR: Record<string, number> = { ccx23: 0.139 };

export function modelKey(model: string): string {
  // "gpt-6-sol-2026-10-01" or "gpt-6-sol (codex exec, requested)" -> "gpt-6-sol"
  const base = model.split(" ")[0]!;
  return Object.keys(TOKEN_PRICES_USD_PER_MTOK).find((k) => base === k || base.startsWith(`${k}-`)) ?? base;
}

export function tokenUsd(model: string, input: number, output: number): number | null {
  const p = TOKEN_PRICES_USD_PER_MTOK[modelKey(model)];
  return p ? (input * p.input + output * p.output) / 1e6 : null;
}

export function vmUsd(seconds: number, type = "ccx23"): number {
  return (seconds / 3600) * VM_USD_PER_HOUR[type]!;
}
