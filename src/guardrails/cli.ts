// bun run guardrails <cr.json> [ctx.json]
// Prints {findings, residual, evaluations} as JSON. Exit 0: clear.
// Exit 2: blocked. Exit 3: unevaluated (missing context). Exit 1: input error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCR } from '../schema/cr';
import { EXIT_CODES, runGuardrails } from './index';
import type { GuardrailContext } from './types';

type IO = { out: (s: string) => void; err: (s: string) => void };
const SHAPES = join(import.meta.dir, '..', '..', 'env', 'workload', 'shapes');

export function loadShapes(dir = SHAPES): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => [f.replace(/\.sql$/, ''), readFileSync(join(dir, f), 'utf8')]));
}

export function main(args: string[], io: IO): number {
  if (args.length < 1 || args.length > 2) { io.err('usage: bun run guardrails <cr.json> [ctx.json]\n'); return 1; }
  try {
    const cr = validateCR(JSON.parse(readFileSync(args[0], 'utf8')));
    const ctx: GuardrailContext = args[1] ? JSON.parse(readFileSync(args[1], 'utf8')) : {};
    if (!ctx.workload_texts) ctx.workload_texts = loadShapes();
    const report = runGuardrails(cr, ctx);
    io.out(JSON.stringify(report, null, 2) + '\n');
    return EXIT_CODES[report.residual];
  } catch (e) {
    io.err(`guardrails: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2), { out: s => process.stdout.write(s), err: s => process.stderr.write(s) }));
