// Offline isolation checks of the CLI generation path. No model call.
//
// N1: `codex debug prompt-input` does not show the tool list, so we run
// `codex exec` with the exact generation argv against a local capture
// endpoint (openai_base_url = 127.0.0.1) and a temporary home that holds a
// fake API-key login and the patched catalog. Every proxy variable points
// at a dead port, so nothing leaves the machine. The captured request body
// lists the tools the model would see: top-level `tools` and the
// `additional_tools` input items (the responses-lite form). The real login
// is never read here. Difference to a real call: the auth mode (API key, not
// ChatGPT); the tool list is built by the same code for both.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexGenArgs, childEnv, CliError, cliWrapper, codexCatalog, codexCatalogFor, spawn, type CliAccess } from "./cli-gen";
import TESTED from "./cli-tested.json";

export interface CodexRequestShape { tools: string[]; service_tier: string | null; parallel_tool_calls: boolean | null; model: string | null;
  /** reasoning.effort and text.verbosity as sent (null when absent). */
  reasoning_effort: string | null; text_verbosity: string | null }

const names = (ts: any[], pre = ""): string[] => (Array.isArray(ts) ? ts : []).flatMap((t) => t?.type === "namespace" ? names(t.tools, `${pre}${t.name}.`) : [`${pre}${t?.name ?? t?.type}`]);

/** Tool names and request settings of one captured Responses API body. */
export function requestShape(b: any): CodexRequestShape {
  const extra = (Array.isArray(b?.input) ? b.input : []).filter((i: any) => i?.type === "additional_tools").flatMap((i: any) => names(i.tools));
  return { tools: [...names(b?.tools ?? []), ...extra], service_tier: b?.service_tier ?? null, parallel_tool_calls: typeof b?.parallel_tool_calls === "boolean" ? b.parallel_tool_calls : null, model: b?.model ?? null,
    reasoning_effort: b?.reasoning?.effort ?? null, text_verbosity: b?.text?.verbosity ?? null };
}

const DEAD_PROXY = "http://127.0.0.1:9";

export async function codexOfferedTools(req: { cliModel: string; effort: string; catalogBase?: string }, parent: Record<string, string | undefined> = process.env): Promise<CodexRequestShape> {
  const catalogJson = codexCatalogFor(await codexCatalog(parent), req.cliModel, req.catalogBase);
  const bodies: unknown[] = [];
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
    if (r.method === "POST" && new URL(r.url).pathname.endsWith("/responses")) {
      const raw = new Uint8Array(await r.arrayBuffer()), enc = r.headers.get("content-encoding") ?? "";
      try { bodies.push(JSON.parse(new TextDecoder().decode(enc.includes("zstd") ? Bun.zstdDecompressSync(raw) : enc.includes("gzip") ? Bun.gunzipSync(raw) : raw))); } catch { bodies.push({ undecodable: enc }); }
    }
    // GET is the WebSocket upgrade: a plain 200 makes Codex fall back to an HTTPS POST, which we capture.
    return r.method === "GET" ? new Response("") : new Response("capture only", { status: 400 });
  } });
  const home = mkdtempSync(join(tmpdir(), "gen-capture-")), cwd = mkdtempSync(join(tmpdir(), "gen-capture-cwd-"));
  try {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "offline-capture-placeholder" }), { mode: 0o600 });
    writeFileSync(join(home, "catalog.json"), catalogJson);
    writeFileSync(join(home, "system.md"), "Offline capture.");
    const args = buildCodexGenArgs(req.cliModel, req.effort, join(home, "system.md"), cwd, join(home, "catalog.json"));
    args.splice(1, 0, "-c", `openai_base_url=${JSON.stringify(`http://127.0.0.1:${srv.port}/v1`)}`);
    const env = { ...childEnv("codex-cli", parent, { HOME: home, CODEX_HOME: home }), HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, ALL_PROXY: DEAD_PROXY, NO_PROXY: "127.0.0.1,localhost" };
    await spawn("codex", args, "List your tools.", env, cwd, 120_000);
  } finally {
    srv.stop(true);
    rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
  const b = bodies.find((x: any) => x && typeof x === "object" && "model" in x);
  // Also when the body could not be decoded: fail closed.
  if (!b) throw new CliError(`codex ${req.cliModel}: the offline capture got no request; the tool list cannot be read`, "access:isolation_failed", false, true);
  return requestShape(b);
}

/** N1/N5: fails closed (access:isolation_failed) unless the offline request of this model carries no tool at all,
 *  no service tier (the standard tier sends none) and reasoning.effort equal to the requested effort. */
export async function codexToolFree(req: { cliModel: string; effort: string; catalogBase?: string }, parent: Record<string, string | undefined> = process.env): Promise<CodexRequestShape> {
  const s = await codexOfferedTools(req, parent);
  if (s.service_tier !== null) throw new CliError(`codex ${req.cliModel}: the request carries service_tier ${s.service_tier}; the standard tier sends none`, "access:isolation_failed", false, true);
  if (s.tools.length) throw new CliError(`codex ${req.cliModel}: the request offers tools ${s.tools.join(", ")}; generation needs an empty tool list`, "access:isolation_failed", false, true);
  if (s.reasoning_effort !== req.effort) throw new CliError(`codex ${req.cliModel}: the request carries reasoning.effort ${s.reasoning_effort ?? "(none)"}; requested ${req.effort}`, "access:isolation_failed", false, true);
  return s;
}

export interface TestedClis { codex: string[]; claude: string[]; codex_features: string[] }

/** N4: before any model call. Each CLI the run uses must report a version
 *  from cli-tested.json, unless allowUntested (--allow-untested-cli; the
 *  caller then runs the full isolation preflight first). Independently of
 *  that flag, every name in `codex features list` must be on the known
 *  list, so a new tool-bearing feature cannot appear unnoticed. */
export async function cliVersionGate(accesses: CliAccess[], parent: Record<string, string | undefined> = process.env, o: { tested?: TestedClis; allowUntested?: boolean } = {}): Promise<{ untested: string[] }> {
  const tested = o.tested ?? TESTED, untested: string[] = [], bad: string[] = [];
  for (const a of [...new Set(accesses)]) {
    const w = await cliWrapper(a, parent), v = w.split(" ")[1] ?? "", list = a === "codex-cli" ? tested.codex : tested.claude;
    if (!list.includes(v)) { untested.push(w); bad.push(`${w} is not a tested version (${list.join(", ")})`); }
  }
  if (accesses.includes("codex-cli")) {
    const home = mkdtempSync(join(tmpdir(), "gen-features-"));
    try {
      const r = await spawn("codex", ["features", "list"], "", childEnv("codex-cli", parent, { HOME: home, CODEX_HOME: home }), home, 60_000);
      const names = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean);
      if (r.code !== 0 || !names.length) throw new CliError(`codex features list: no output (exit ${r.code}); the feature set cannot be checked`, "access:isolation_failed", false, true);
      const unknown = names.filter((n) => !tested.codex_features.includes(n));
      if (unknown.length) throw new CliError(`unknown Codex features: ${unknown.join(", ")}; review them (tool-bearing ones go into CODEX_DISABLED_FEATURES) and add them to src/llm/cli-tested.json`, "access:isolation_failed", false, true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  if (bad.length && !o.allowUntested) throw new CliError(`${bad.join("; ")}. Pass --allow-untested-cli for a deliberate upgrade (runs the full isolation preflight first)`, "access:untested_cli", false, true);
  return { untested };
}
