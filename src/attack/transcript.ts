import type { CR } from "../schema/types";
import type { Transcript } from "../llm/analyst";

export function rewriteCRMessage(transcript: Transcript, cr: CR): Transcript {
  const next = structuredClone(transcript);
  const index = (next.cr_turn_end ?? next.messages.length) - 1;
  const message = next.messages[index];
  if (!message || message.role !== "assistant") throw new Error("Analyst CR message missing from transcript");
  const matches = [...message.content.matchAll(/```json\s*\n[\s\S]*?\n```/g)];
  const selected = matches.at(-1);
  if (!selected || selected.index === undefined) throw new Error("Analyst CR JSON fence missing from transcript");
  message.content = message.content.slice(0, selected.index) + `\`\`\`json\n${JSON.stringify(cr, null, 2)}\n\`\`\`` + message.content.slice(selected.index + selected[0].length);
  return next;
}
