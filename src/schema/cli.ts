import { crSchema } from './cr';
export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') { console.log('Usage: bun run validate <cr.json>'); return 0; }
  if (args.length !== 1) { console.error('Usage: bun run validate <cr.json>'); return 2; }
  try {
    const result = crSchema.safeParse(await Bun.file(args[0]!).json());
    if (!result.success) {
      for (const issue of result.error.issues) console.error(`${issue.path.join('.') || 'CR'}: ${issue.message}`);
      return 1;
    }
    console.log(JSON.stringify(result.data, null, 2)); return 0;
  } catch (error) { console.error(`Cannot validate ${args[0]}: ${error instanceof Error ? error.message : error}`); return 1; }
}
if (import.meta.main) process.exitCode = await main();
