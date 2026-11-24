import type { NodeName } from "../actions";
import type { StateSnapshot } from "../snapshot";
import { deny, ok, type ActionDraft, type Classified, type PolicyStep } from "./types";

const RELOAD_CONTEXTS = new Set(["sighup", "superuser", "user", "backend", "superuser-backend"]);

// Config steps classify without parsing. The Actor restarts each targeted node
// after a postmaster-context setting, so such a step implies node.restart per
// node; an omitted node means both nodes (ADR 0003).
export function classifyConfig(
  s: Extract<PolicyStep, { config: unknown }>, step: number, snapshot: StateSnapshot,
): Classified {
  if (s.node !== undefined && !["primary", "standby", "both"].includes(s.node)) {
    return deny(step, "malformed_step", `Step ${step} targets node ${JSON.stringify(s.node)}, which is not primary, standby or both.`,
      "Set node to primary, standby or both, or omit it for both nodes.", { node: s.node });
  }
  const nodes: NodeName[] = s.node === "primary" || s.node === "standby" ? [s.node] : ["primary", "standby"];
  const setting = s.config.name;
  const value = String(s.config.value);
  const context = snapshot.nodes[nodes[0]].settings[setting]?.context;
  if (context === "postmaster") {
    return ok(
      { step, action: "cfg.set_restart", objects: [], nodes, setting, value },
      ...nodes.map((n): ActionDraft => ({ step, action: "node.restart", objects: [], nodes: [n], setting })),
    );
  }
  if (context && RELOAD_CONTEXTS.has(context)) return ok({ step, action: "cfg.set_reload", objects: [], nodes, setting, value });
  if (context === undefined) {
    return deny(step, "unknown_setting", `Step ${step} sets ${setting}, which the state snapshot does not list.`,
      "Check the setting name against pg_settings.", { setting });
  }
  return deny(step, "unsettable_setting", `Step ${step} sets ${setting}, whose context (${context}) cannot be changed by a config step.`,
    "Remove the step; this setting cannot be changed on a running cluster.", { setting, context });
}
