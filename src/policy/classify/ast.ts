// Helpers that read libpg_query parse trees, shared by the statement classifiers.

export const DEFAULT_SCHEMA = "public";

export type Node = Record<string, any>;

export const qualify = (schemaname: string | undefined, relname: string) => `${schemaname ?? DEFAULT_SCHEMA}.${relname}`;

// The value of a DefElem argument as text: true, 90, 0.01, off.
export const defElemValue = (arg: Node | undefined): string => {
  if (!arg) return "true";
  if (arg.String) return arg.String.sval;
  if (arg.Integer) return String(arg.Integer.ival ?? 0);
  if (arg.Float) return arg.Float.fval;
  if (arg.Boolean) return String(arg.Boolean.boolval ?? false);
  if (arg.TypeName) return arg.TypeName.names.at(-1).String.sval;
  return JSON.stringify(arg);
};

// The text of an A_Const in SET name = value: 'force_custom_plan', 64, 0.5, on.
export const constValue = (arg: Node): string => {
  const c = arg.A_Const;
  if (!c) return JSON.stringify(arg);
  if (c.sval) return c.sval.sval ?? "";
  if (c.ival) return String(c.ival.ival ?? 0);
  if (c.fval) return c.fval.fval;
  if (c.boolval) return String(c.boolval.boolval ?? false);
  return "";
};

export const nameFromList = (list: Node): string => {
  const parts = (list.List?.items ?? []).map((i: Node) => i.String?.sval as string);
  return parts.length === 1 ? qualify(undefined, parts[0]) : parts.join(".");
};

// A type name as written, without pg_catalog: "float8", "varchar(20)", "numeric(10,2)".
export function typeName(t: Node): string {
  const parts: string[] = t.names.map((n: Node) => n.String?.sval);
  const name = parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : parts.join(".");
  const mods = (t.typmods ?? []).map((m: Node) => m.A_Const?.ival?.ival ?? "?");
  const bounds = t.arrayBounds ? "[]".repeat(t.arrayBounds.length) : "";
  return `${name}${mods.length > 0 ? `(${mods.join(",")})` : ""}${bounds}`;
}

// Built-in functions a query.read may call: none writes, locks, signals or
// changes settings. Any other function in a SELECT is denied, because the
// parse tree cannot show what a user-defined function does.
export const READ_ONLY_FUNCTIONS = new Set([
  "count", "sum", "min", "max", "avg", "bool_and", "bool_or", "string_agg", "array_agg",
  "now", "current_setting", "age", "date_trunc", "date_part", "extract", "to_char", "round", "abs",
  "lower", "upper", "length", "format_type", "quote_ident", "split_part",
  "pg_size_pretty", "pg_total_relation_size", "pg_relation_size", "pg_table_size", "pg_indexes_size",
  "pg_describe_object", "pg_get_indexdef", "pg_get_constraintdef", "pg_get_viewdef",
  "pg_is_in_recovery", "pg_current_wal_lsn", "pg_last_wal_replay_lsn", "pg_wal_lsn_diff",
]);

export const functionName = (call: Node): string => {
  const parts: string[] = call.funcname.map((p: Node) => p.String?.sval);
  return parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : parts.join(".");
};

// Every function a parse tree calls.
export function calledFunctions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => calledFunctions(n, out));
  else if (node !== null && typeof node === "object") {
    const call = (node as Node).FuncCall;
    if (call) out.push(functionName(call));
    Object.values(node).forEach((v) => calledFunctions(v, out));
  }
  return out;
}

// True if any node in the tree passes the test.
export function hasNode(node: unknown, test: (n: Node) => boolean): boolean {
  if (Array.isArray(node)) return node.some((n) => hasNode(n, test));
  if (node === null || typeof node !== "object") return false;
  return test(node as Node) || Object.values(node).some((v) => hasNode(v, test));
}
