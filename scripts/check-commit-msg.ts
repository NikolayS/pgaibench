import { readFileSync } from "node:fs";
import { checkCommitMessage } from "./guardrails";

// The commit-msg hook: bun run scripts/check-commit-msg.ts <message file>

const problems = checkCommitMessage(readFileSync(process.argv[2], "utf8"));
for (const p of problems) console.error(`commit-msg: ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
