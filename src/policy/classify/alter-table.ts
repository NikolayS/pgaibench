import { LOCK_PROFILES, type ActionLock } from "../locks";
import { calledFunctions, defElemValue, qualify, typeName, type Node } from "./ast";
import { deny, ok, type Classified, type ClassifiedAction, type ConstraintInfo, type StatementClassifier } from "./types";

const CONSTRAINT_TYPES: Record<string, ConstraintInfo["type"]> = {
  CONSTR_CHECK: "check", CONSTR_NOTNULL: "not_null", CONSTR_FOREIGN: "foreign_key",
  CONSTR_UNIQUE: "unique", CONSTR_PRIMARY: "primary_key", CONSTR_EXCLUSION: "exclusion",
};

// Functions whose value differs per row, so a column default that calls one rewrites the table.
const VOLATILE_DEFAULTS = new Set(["random", "gen_random_uuid", "uuidv4", "uuidv7", "clock_timestamp", "nextval", "timeofday"]);

// ADD COLUMN constraints that store a value per row, so the table is rewritten
// (a stored generated or identity column; a PG 18 virtual column stores
// nothing), and ones that read every row to build an index or check existing rows.
const rewritingColumnConstraint = (c: Node) =>
  c.contype === "CONSTR_IDENTITY" || (c.contype === "CONSTR_GENERATED" && c.generated_kind === "s");
const SCANNING_COLUMN_CONSTRAINTS = new Set(["CONSTR_UNIQUE", "CONSTR_PRIMARY", "CONSTR_FOREIGN", "CONSTR_CHECK"]);

// The column a constraint proves NOT NULL: NOT NULL col, or CHECK (col IS NOT NULL).
function notNullColumn(c: Node): string | undefined {
  if (c.contype === "CONSTR_NOTNULL" && c.keys?.length === 1) return c.keys[0].String?.sval;
  const test = c.contype === "CONSTR_CHECK" ? c.raw_expr?.NullTest : undefined;
  const fields = test?.nulltesttype === "IS_NOT_NULL" ? test.arg?.ColumnRef?.fields : undefined;
  return fields?.length === 1 ? fields[0].String?.sval : undefined;
}

// ALTER TABLE: one action per subcommand, except that SET (storage parameters)
// subcommands merge into one ddl.set_reloption action. A subcommand outside the
// vocabulary denies the whole statement.
function classifyAlterTable(body: Node, step: number): Classified {
  if (body.objtype !== "OBJECT_TABLE") {
    return deny(step, "unknown_statement", `Step ${step} is an ALTER statement on a ${body.objtype}, which is not in the policy gate's action vocabulary.`,
      "Use only statements the policy gate can classify, or escalate.", { statement: "AlterTableStmt", objtype: body.objtype });
  }
  const target = qualify(body.relation.schemaname, body.relation.relname);
  const actions: ClassifiedAction[] = [];
  let reloptions: Record<string, string> | undefined;
  for (const { AlterTableCmd: cmd } of body.cmds as Node[]) {
    const base = { step, objects: [target] };
    switch (cmd.subtype) {
      case "AT_AddColumn": {
        const constraints: Node[] = (cmd.def?.ColumnDef?.constraints ?? []).map((c: Node) => c.Constraint ?? {});
        const rewrites = calledFunctions(constraints).some((f) => VOLATILE_DEFAULTS.has(f))
          || constraints.some(rewritingColumnConstraint);
        const scans = rewrites || constraints.some((c) => SCANNING_COLUMN_CONSTRAINTS.has(c.contype));
        actions.push({ ...base, action: "ddl.add_column", column: cmd.def?.ColumnDef?.colname,
          lock: { ...LOCK_PROFILES["ddl.add_column"], rewrites, scans, relations: [target] } });
        continue;
      }
      case "AT_AddConstraint": {
        const c: Node = cmd.def.Constraint;
        const type = CONSTRAINT_TYPES[c.contype];
        if (!type) break;
        const notValid = c.skip_validation === true;
        const action = notValid ? "ddl.add_check_not_valid" : "ddl.add_constraint_validating";
        const constraint: ConstraintInfo = { name: c.conname, type, not_null_column: notNullColumn(c) };
        // A foreign key takes SHARE ROW EXCLUSIVE on both tables (PG 18 ALTER TABLE).
        const referenced = type === "foreign_key" ? qualify(c.pktable.schemaname, c.pktable.relname) : undefined;
        const lock: ActionLock = referenced
          ? { ...LOCK_PROFILES[action], mode: "ShareRowExclusiveLock", relations: [target, referenced] }
          : { ...LOCK_PROFILES[action], relations: [target] };
        actions.push({ ...base, objects: referenced ? [target, referenced] : [target], action, constraint, lock });
        continue;
      }
      case "AT_ValidateConstraint":
        actions.push({ ...base, action: "ddl.validate_constraint", constraint: { name: cmd.name } });
        continue;
      case "AT_SetNotNull":
        actions.push({ ...base, action: "ddl.set_not_null", column: cmd.name });
        continue;
      case "AT_AlterColumnType":
        actions.push({ ...base, action: "ddl.alter_column_type", column: cmd.name, new_type: typeName(cmd.def.ColumnDef.typeName) });
        continue;
      case "AT_DropColumn":
        actions.push({ ...base, action: "ddl.drop_column", column: cmd.name });
        continue;
      case "AT_SetRelOptions":
        if (!reloptions) {
          reloptions = {};
          actions.push({ ...base, action: "ddl.set_reloption", options: reloptions });
        }
        for (const item of cmd.def?.List?.items ?? []) {
          const d: Node = item.DefElem;
          reloptions[d.defnamespace ? `${d.defnamespace}.${d.defname}` : d.defname] = defElemValue(d.arg);
        }
        continue;
    }
    return deny(step, "unknown_statement", `Step ${step} has an ALTER TABLE ${cmd.subtype} subcommand, which is not in the policy gate's action vocabulary.`,
      "Use only statements the policy gate can classify, or escalate.", { statement: "AlterTableStmt", subtype: cmd.subtype });
  }
  return ok(...actions);
}

export const ALTER_TABLE_STATEMENTS: Record<string, StatementClassifier> = {
  AlterTableStmt: ({ body, step }) => classifyAlterTable(body, step),
};
