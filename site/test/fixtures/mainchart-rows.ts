// Chart rows for the main chart tests: the 24 rows of 2026-11-13 and a 30-row set.
import type { CRow } from '../../src/mainchart';

const R = (id: string, name: string, effort: string, family: string, done: number, dangerous: number, ranked = true): CRow =>
  ({ id, name, effort, family, done, dangerous, lo: Math.max(0, done - 2.5), hi: Math.min(19, done + 2), ranked });
// the 24 rows of 2026-11-13 (23 with a place)
export const TODAY: CRow[] = [
  R('a/fable', 'claude-fable-5.2', 'high', 'anthropic', 18, 0), R('a/fable:medium', 'claude-fable-5.2', 'medium', 'anthropic', 17, 0),
  R('a/opus', 'claude-opus-5.5', 'high', 'anthropic', 17, 0), R('a/opus:medium', 'claude-opus-5.5', 'medium', 'anthropic', 16.6, 0),
  R('g/carbon@agy', 'gemini-4-carbon CLI', 'medium', 'google', 16.2, 0), R('g/carbon-high@agy', 'gemini-4-carbon CLI', 'high', 'google', 16, 0),
  R('g/argon', 'gemini-4-argon', 'provider default', 'google', 16.2, 0.2), R('a/sonnet', 'claude-sonnet-5.5', 'high', 'anthropic', 16.2, 1),
  R('g/flash', 'gemini-3.8-flash', 'provider default', 'google', 15.2, 0), R('o/terra:high', 'gpt-6.1-terra', 'high', 'openai', 15, 0),
  R('a/sonnet:medium', 'claude-sonnet-5.5', 'medium', 'anthropic', 15.2, 1), R('o/terra', 'gpt-6.1-terra', 'medium', 'openai', 14, 0),
  R('o/sol', 'gpt-6.1-sol', 'medium', 'openai', 14, 0), R('o/astra', 'gpt-6-astra', 'medium', 'openai', 13, 0),
  R('o/sol:high', 'gpt-6.1-sol', 'high', 'openai', 13.2, 0), R('o/astra:high', 'gpt-6-astra', 'high', 'openai', 13, 0),
  R('a/haiku:high', 'claude-haiku-5.5', 'high', 'anthropic', 12.6, 0.2), R('o/luna', 'gpt-6-luna', 'medium', 'openai', 12.6, 1.2),
  R('o/luna:high', 'gpt-6-luna', 'high', 'openai', 12.6, 1.2), R('a/haiku', 'claude-haiku-5.5', 'medium', 'anthropic', 12.6, 1.6),
  R('m/kimi', 'kimi-k3.1-pro', 'high', 'open', 12.4, 2.6), R('q/qwen', 'qwen3.8-27b', 'provider default', 'open', 8.2, 4.2),
  R('d/deepseek', 'deepseek-v4-pro', 'no thinking', 'open', 4.4, 7), R('g/carbon@or', 'gemini-4-carbon API', 'provider default', 'google', 15.2, 0.2, false),
];
// 30 rows: today plus five more on the zero line at the same height, and one more far row
export const THIRTY: CRow[] = [...TODAY, ...[1, 2, 3, 4, 5].map(i => R(`x/m${i}`, `model-${i}-long-name`, 'high', i % 2 ? 'openai' : 'google', 14.4, 0)), R('x/far', 'far-model', 'medium', 'open', 10, 3.4)];
