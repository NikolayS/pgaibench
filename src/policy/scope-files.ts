import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ticketScopeSchema, type TicketScope } from "./scope";

// Ticket scope files: one hand-written JSON sidecar per scenario ID in
// src/policy/scopes/ (ADR 0002). Pinned scenario files are never edited. A
// missing file is an error, so we never replay against an empty scope.

export const SCOPE_DIR = join(import.meta.dir, "scopes");

const SCENARIO_ID = /^[A-Z]+\d+$/;

/** The scenario IDs that have a ticket scope file. */
export function listScopeIds(dir = SCOPE_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
}

/** The validated ticket scope for a scenario; throws if there is none or it is invalid. */
export function loadScope(scenarioId: string, dir = SCOPE_DIR): TicketScope {
  const file = join(dir, `${scenarioId}.json`);
  if (!SCENARIO_ID.test(scenarioId) || !existsSync(file)) {
    throw new Error(`No ticket scope for scenario ${scenarioId}: expected ${file}`);
  }
  const parsed = ticketScopeSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ticket scope for scenario ${scenarioId}: ${parsed.error.message}`);
  return parsed.data;
}
