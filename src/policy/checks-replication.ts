import type { NodeName } from "./actions";
import type { Check, RuleFinding } from "./checks";
import { MEMORY_UNITS, TIME_UNITS } from "./rule-data";
import type { Setting } from "./snapshot";

// Checks for the replication and settings rules R-1 to R-4 and R-6 to R-9
// (issue #9). R-5 is retired: the Actor always restarts after a
// postmaster-context config step, and ALTER SYSTEM in a SQL step is denied.

const NODES: readonly NodeName[] = ["primary", "standby"];

// R-2: for the hot-standby settings, the standby's running value never drops
// below the primary's. The Actor restarts a node after each postmaster-context
// config step and orders a both-node step itself (ADR 0003), so the plan is
// unsafe only when separate steps leave the standby below the primary.
// Modeled in docs/policy-gate/tla/HotStandbyParam.tla.
const hotStandbyOrder: Check = ({ actions, snapshot, rule }) => {
  const settings = new Set(rule.settings ?? []);
  const running = new Map<string, Record<NodeName, string>>();
  const findings: RuleFinding[] = [];
  for (const a of actions) {
    if (a.action !== "cfg.set_restart" || !a.setting || !settings.has(a.setting) || a.value === undefined) continue;
    const current = running.get(a.setting) ?? {
      primary: snapshot.nodes.primary.settings[a.setting]?.value ?? "",
      standby: snapshot.nodes.standby.settings[a.setting]?.value ?? "",
    };
    const next = { ...current };
    for (const n of a.nodes ?? NODES) next[n] = a.value;
    running.set(a.setting, next);
    const primary = Number(next.primary);
    const standby = Number(next.standby);
    if (!Number.isFinite(primary) || !Number.isFinite(standby) || standby >= primary) continue;
    const raising = Number(a.value) > Number(current[a.nodes![0]]);
    findings.push({
      step: a.step,
      reason: `After step ${a.step} the standby runs ${a.setting} = ${next.standby} below the primary's ${next.primary}, so the standby stops replaying WAL.`,
      fix_hint: raising
        ? `Raise ${a.setting} on the standby first, or set both nodes in one config step (node: "both") and let the Actor order the restarts.`
        : `Lower ${a.setting} on the primary first, or set both nodes in one config step (node: "both") and let the Actor order the restarts.`,
      evidence: { setting: a.setting, primary: next.primary, standby: next.standby },
    });
  }
  return findings;
};

// R-3: every restart a config step implies is allowed by TS-2 (node.restart is
// not forbidden) and falls on a node the ticket allows downtime for.
const restartAllowed: Check = ({ actions, scope }) =>
  actions.filter((a) => a.action === "node.restart").flatMap((a) => {
    const node = a.nodes![0];
    const forbidden = scope.forbidden_actions.includes("node.restart");
    if (!forbidden && scope.downtime_allowed.includes(node)) return [];
    return [{
      step: a.step,
      reason: forbidden
        ? `Step ${a.step} sets ${a.setting}, a postmaster-context setting, so the Actor restarts ${node}; the ticket forbids restarts.`
        : `Step ${a.step} sets ${a.setting}, a postmaster-context setting, so the Actor restarts ${node}; the ticket allows no downtime on ${node}.`,
      fix_hint: "Reach the goal with a reload-context, role or table setting, or escalate for a maintenance window.",
      evidence: { node, setting: a.setting, downtime_allowed: scope.downtime_allowed, restart_forbidden: forbidden },
    }];
  });

// synchronous_standby_names: "FIRST n (a, b)", "ANY n (a, b)", "n (a, b)" or a
// plain list, which means FIRST 1. Postgres matches names case-insensitively.
function parseSyncNames(value: string): { count: number; names: string[] } | undefined {
  const text = value.trim();
  if (text === "") return { count: 0, names: [] };
  const m = /^(?:(?:first|any)\s+)?(\d+)\s*\((.*)\)$/is.exec(text);
  const list = m ? m[2] : text;
  const names = list.split(",").map((n) => n.trim().replace(/^"(.*)"$/s, "$1").toLowerCase());
  if (names.some((n) => n === "")) return undefined;
  return { count: m ? Number(m[1]) : 1, names };
}

// R-4: every synchronous standby name matches a streaming standby (or is *),
// and the number required is no more than the standbys that match.
const syncStandbyNames: Check = ({ actions, snapshot, rule }) => {
  const settings = new Set(rule.settings ?? []);
  const streaming = snapshot.nodes.primary.replication.replicas
    .filter((r) => r.state === "streaming").map((r) => r.application_name);
  return actions.filter((a) => a.action === "cfg.set_reload" && settings.has(a.setting!) && a.value !== undefined).flatMap((a) => {
    const parsed = parseSyncNames(a.value!);
    const matching = parsed ? streaming.filter((s) => parsed.names.some((n) => n === "*" || n === s.toLowerCase())) : [];
    const unknown = parsed ? parsed.names.filter((n) => n !== "*" && !streaming.some((s) => s.toLowerCase() === n)) : [];
    if (parsed && unknown.length === 0 && parsed.count <= matching.length) return [];
    const reason = !parsed
      ? `Step ${a.step} sets synchronous_standby_names to ${JSON.stringify(a.value)}, which does not parse.`
      : unknown.length > 0
        ? `Step ${a.step} names ${unknown.join(", ")} as synchronous standbys, but no standby streams under that name; commits would wait for an acknowledgement that never comes.`
        : `Step ${a.step} requires ${parsed.count} synchronous standbys, but only ${matching.length} streaming standbys match; commits would wait forever.`;
    return [{
      step: a.step,
      reason,
      fix_hint: `Use the application_name of a streaming standby from pg_stat_replication (${streaming.join(", ") || "none streaming"}), or *, and require no more standbys than match.`,
      evidence: { value: a.value, streaming, unknown, required: parsed?.count ?? null, matching },
    }];
  });
};

const WAL_LEVELS = ["minimal", "replica", "logical"];

// R-6: wal_level stays at least replica while a standby, a physical slot or WAL
// archiving exists, and stays logical while a logical slot exists.
const walLevelKept: Check = ({ actions, snapshot, rule }) => {
  const settings = new Set(rule.settings ?? []);
  const { primary, standby } = snapshot.nodes;
  const slots = [...primary.replication.slots, ...standby.replication.slots];
  const logicalSlots = slots.filter((s) => s.slot_type === "logical").map((s) => s.slot_name);
  const physicalSlots = slots.filter((s) => s.slot_type === "physical").map((s) => s.slot_name);
  const standbys = primary.replication.replicas.map((r) => r.application_name);
  const hasStandby = standbys.length > 0 || standby.replication.in_recovery;
  const archiving = NODES.some((n) => ["on", "always"].includes(snapshot.nodes[n].settings.archive_mode?.value ?? "off"));
  const needs = logicalSlots.length > 0 ? "logical"
    : hasStandby || physicalSlots.length > 0 || archiving ? "replica" : "minimal";
  return actions.filter((a) => a.action === "cfg.set_restart" && settings.has(a.setting!) && a.value !== undefined).flatMap((a) => {
    const value = a.value!.trim().toLowerCase();
    const rank = WAL_LEVELS.indexOf(value === "archive" || value === "hot_standby" ? "replica" : value);
    // An unknown value is R-1's concern.
    if (rank < 0 || rank >= WAL_LEVELS.indexOf(needs)) return [];
    return [{
      step: a.step,
      reason: needs === "logical"
        ? `Step ${a.step} sets wal_level = ${a.value}, but logical slot ${logicalSlots.join(", ")} needs wal_level = logical.`
        : `Step ${a.step} sets wal_level = ${a.value}, which breaks streaming replication, replication slots and WAL archiving; the cluster needs at least replica.`,
      fix_hint: `Keep wal_level at ${needs} or above. Escalate if the ticket really means to drop the standby, slots or archiving.`,
      evidence: { value: a.value, needs, standbys, physical_slots: physicalSlots, logical_slots: logicalSlots, archive_mode: archiving },
    }];
  });
};

const libraryList = (value: string) =>
  value.split(",").map((l) => l.trim().replace(/^"(.*)"$/s, "$1")).filter((l) => l !== "");

// R-7: a new preload library list keeps every library loaded now on each node
// the step targets. Ticket scope has no field that names a removal, so every
// removal is rejected (TS-6: scope comes only from structured fields).
const preloadLibrariesKept: Check = ({ actions, snapshot, rule }) => {
  const settings = new Set(rule.settings ?? []);
  return actions.filter((a) => (a.action === "cfg.set_reload" || a.action === "cfg.set_restart")
    && settings.has(a.setting!) && a.value !== undefined).flatMap((a) => {
    const next = new Set(libraryList(a.value!));
    const current = (a.nodes ?? NODES).flatMap((n) => libraryList(snapshot.nodes[n].settings[a.setting!]?.value ?? ""));
    const dropped = [...new Set(current.filter((l) => !next.has(l)))];
    if (dropped.length === 0) return [];
    return [{
      step: a.step,
      reason: `Step ${a.step} replaces ${a.setting} with ${JSON.stringify(a.value)}, which unloads ${dropped.join(", ")}.`,
      fix_hint: `Append to the current list instead of replacing it: ${[...new Set([...current, ...next])].join(",")}.`,
      evidence: { setting: a.setting, value: a.value, current: [...new Set(current)], dropped },
    }];
  });
};

/** Postgres boolean input (parse_bool): on/off, true/false, yes/no, 1/0 and unique prefixes. */
export function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "on") return true;
  if (v === "0" || v === "of" || v === "off") return false;
  if (v === "") return undefined;
  if ("true".startsWith(v) || "yes".startsWith(v)) return true;
  if ("false".startsWith(v) || "no".startsWith(v)) return false;
  return undefined;
}

const isPlannerToggle = (setting: string) => setting === "autovacuum" || setting.startsWith("enable_");

// R-8: autovacuum and the enable_* planner toggles are never turned off
// cluster-wide (reject); a table-level autovacuum_enabled = false escalates.
const noToggleOff: Check = ({ actions }) => actions.flatMap((a): RuleFinding[] => {
  if ((a.action === "cfg.set_reload" || a.action === "cfg.set_restart") && isPlannerToggle(a.setting!) && parseBool(a.value ?? "") === false) {
    return [{
      step: a.step,
      verdict: "reject",
      reason: `Step ${a.step} turns ${a.setting} off for the whole cluster, which changes every query's plan or stops autovacuum everywhere.`,
      fix_hint: a.setting === "autovacuum"
        ? "Tune autovacuum per table with ALTER TABLE ... SET (autovacuum_vacuum_cost_delay = ...) instead."
        : "Fix the plan for the affected query (an index, ANALYZE or a role setting) instead of a cluster-wide planner toggle.",
      evidence: { setting: a.setting, value: a.value, nodes: a.nodes },
    }];
  }
  if (a.action === "ddl.set_reloption") {
    return Object.entries(a.options ?? {})
      .filter(([option, value]) => (option === "autovacuum_enabled" || option === "toast.autovacuum_enabled") && parseBool(value) === false)
      .map(([option, value]) => ({
        step: a.step,
        verdict: "escalate" as const,
        reason: `Step ${a.step} turns autovacuum off for ${a.objects[0]}, so its dead rows and transaction-ID age stop being cleaned up.`,
        fix_hint: "Tune the table's autovacuum thresholds or cost limits instead, or let a human approve turning it off.",
        evidence: { table: a.objects[0], option, value },
      }));
  }
  return [];
});

// R-9: standby-only settings go on the standby alone (reject otherwise), and an
// unlimited delay (-1), which lets a standby query hold replay back forever,
// escalates.
const standbyOnlySettings: Check = ({ actions, rule }) => {
  const settings = new Set(rule.settings ?? []);
  return actions.filter((a) => a.action === "cfg.set_reload" && settings.has(a.setting!)).flatMap((a): RuleFinding[] => {
    const nodes = a.nodes ?? [...NODES];
    if (nodes.includes("primary")) {
      return [{
        step: a.step,
        verdict: "reject",
        reason: `Step ${a.step} sets ${a.setting} on the primary; it only acts on a standby, so the step changes nothing intended there and hides what the standby runs.`,
        fix_hint: `Set ${a.setting} with node: "standby".`,
        evidence: { setting: a.setting, value: a.value, nodes },
      }];
    }
    if (Number.parseFloat(a.value ?? "") < 0) {
      return [{
        step: a.step,
        verdict: "escalate",
        reason: `Step ${a.step} sets ${a.setting} = ${a.value}, so a standby query can hold WAL replay back without limit and the standby falls behind.`,
        fix_hint: `Use a bounded ${a.setting} (for example 60s), or let a human approve an unlimited delay.`,
        evidence: { setting: a.setting, value: a.value, nodes },
      }];
    }
    return [];
  });
};

// Unit multipliers as Postgres reads them in setting values (guc.c).

// A setting's base unit, e.g. "8kB" is 8192 bytes and "s" is 1000 ms.
function baseUnit(unit: string | null): { table: Record<string, number>; factor: number } | undefined {
  if (!unit) return undefined;
  const m = /^(\d*)(\D+)$/.exec(unit);
  if (!m) return undefined;
  const table = m[2] in MEMORY_UNITS ? MEMORY_UNITS : m[2] in TIME_UNITS ? TIME_UNITS : undefined;
  return table && { table, factor: Number(m[1] || 1) * table[m[2]] };
}

// The value in the setting's base unit, or why it is not a valid number for it.
function numericValue(value: string, s: Setting): number | string {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-zA-Z]*)\s*$/.exec(value);
  if (!m) return `${JSON.stringify(value)} is not a number`;
  let n = Number(m[1]);
  if (m[2]) {
    const base = baseUnit(s.unit);
    if (!base || !(m[2] in base.table)) return `${m[2]} is not a valid unit${s.unit ? ` for a setting in ${s.unit}` : " for a setting with no unit"}`;
    n = (n * base.table[m[2]]) / base.factor;
  }
  if (s.vartype === "integer") {
    n = Math.round(n);
    if (!m[2] && !Number.isInteger(Number(m[1]))) return `${value} is not an integer`;
  }
  return n;
}

// Why a value does not type-check against its pg_settings row, if it does not.
function typeError(value: string, s: Setting): string | undefined {
  switch (s.vartype) {
    case "bool":
      return parseBool(value) === undefined ? `${JSON.stringify(value)} is not a boolean` : undefined;
    case "enum": {
      const ok = (s.enumvals ?? []).some((e) => e.toLowerCase() === value.trim().toLowerCase());
      return ok ? undefined : `${JSON.stringify(value)} is not one of ${(s.enumvals ?? []).join(", ")}`;
    }
    case "integer":
    case "real": {
      const n = numericValue(value, s);
      if (typeof n === "string") return n;
      if (s.min_val !== null && n < Number(s.min_val)) return `${value} is below the minimum ${s.min_val}${s.unit ? ` ${s.unit}` : ""}`;
      if (s.max_val !== null && n > Number(s.max_val)) return `${value} is above the maximum ${s.max_val}${s.unit ? ` ${s.unit}` : ""}`;
      return undefined;
    }
    case "string":
      return undefined;
  }
}

// R-1: every new setting value type-checks against pg_settings on each node it
// targets (role settings against the primary's).
const valueTypeChecks: Check = ({ actions, snapshot }) =>
  actions.filter((a) => (a.action === "cfg.set_reload" || a.action === "cfg.set_restart" || a.action === "cfg.set_role")
    && a.setting && a.value !== undefined).flatMap((a) => {
    const nodes = a.action === "cfg.set_role" ? ["primary" as const] : a.nodes ?? NODES;
    for (const n of nodes) {
      const s = snapshot.nodes[n].settings[a.setting!];
      const error = s && typeError(a.value!, s);
      if (!error) continue;
      return [{
        step: a.step,
        reason: `Step ${a.step} sets ${a.setting} = ${a.value}, but ${error}.`,
        fix_hint: `Use a value pg_settings accepts for ${a.setting} (${s.vartype}${s.unit ? ` in ${s.unit}` : ""}).`,
        evidence: { setting: a.setting, value: a.value, node: n, vartype: s.vartype, unit: s.unit, min_val: s.min_val, max_val: s.max_val, enumvals: s.enumvals },
      }];
    }
    return [];
  });

export const REPLICATION_CHECKS: Record<string, Check> = {
  "R-1": valueTypeChecks,
  "R-2": hotStandbyOrder,
  "R-3": restartAllowed,
  "R-4": syncStandbyNames,
  "R-6": walLevelKept,
  "R-7": preloadLibrariesKept,
  "R-8": noToggleOff,
  "R-9": standbyOnlySettings,
};
