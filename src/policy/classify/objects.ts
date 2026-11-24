import type { StateSnapshot } from "../snapshot";
import { calledFunctions, nameFromList, qualify, READ_ONLY_FUNCTIONS, type Node } from "./ast";
import { deny, ok, type StatementClassifier } from "./types";

// Statements that create, drop, empty or maintain whole objects: indexes,
// tables, views, types, extensions.

/** Stands for every relation in the database, which no ticket scope lists. */
const ALL_RELATIONS = "*";

// obj.drop covers tables, views and types (02-action-vocabulary.md); other
// DROP statements stay default-deny.
const DROPPABLE_OBJECTS = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_MATVIEW", "OBJECT_TYPE"]);

// DROP TABLE and DROP VIEW name objects as a List; DROP TYPE as a TypeName.
const droppedName = (o: Node): string =>
  o.TypeName ? nameFromList({ List: { items: o.TypeName.names } }) : nameFromList(o);

// TRUNCATE ... CASCADE also truncates every table with a foreign key to a
// truncated table, transitively, so it touches all of them (TS-1).
function truncateCascade(named: string[], snapshot: StateSnapshot): string[] {
  const reached = new Set(named);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of snapshot.constraints) {
      if (c.type === "foreign_key" && c.references !== null && reached.has(c.references) && !reached.has(c.table)) {
        reached.add(c.table);
        grew = true;
      }
    }
  }
  return [...reached];
}

export const OBJECT_STATEMENTS: Record<string, StatementClassifier> = {
  // A new index on a table is in scope when its table is.
  IndexStmt: ({ body, step }) => ok({
    step,
    action: body.concurrent ? "idx.create_concurrent" : "idx.create_blocking",
    objects: [qualify(body.relation.schemaname, body.relation.relname)],
  }),
  // An extension is not a relation, so TS-5's allowlist, not TS-1, decides it.
  CreateExtensionStmt: ({ body, step }) => ok({ step, action: "ext.create", objects: [], extension: body.extname }),
  DropStmt: ({ body, step, snapshot }) => {
    if (body.removeType === "OBJECT_INDEX") {
      const indexes: string[] = body.objects.map(nameFromList);
      const tables = indexes.flatMap((i) => {
        const rel = snapshot.relations[i];
        return rel?.kind === "index" ? [rel.table] : [];
      });
      return ok({
        step,
        action: body.concurrent ? "idx.drop_concurrent" : "idx.drop_blocking",
        objects: [...new Set([...indexes, ...tables])],
      });
    }
    if (DROPPABLE_OBJECTS.has(body.removeType)) {
      return ok({ step, action: "obj.drop", objects: body.objects.map(droppedName), cascade: body.behavior === "DROP_CASCADE" });
    }
    return undefined;
  },
  CreateStmt: ({ body, step }) => {
    // A new table, plus any parent it inherits from or is a partition of.
    const parents: string[] = (body.inhRelations ?? []).map((r: Node) => qualify(r.RangeVar.schemaname, r.RangeVar.relname));
    return ok({ step, action: "obj.create", objects: [qualify(body.relation.schemaname, body.relation.relname), ...parents] });
  },
  // The view's query is stored, not run, so only the view is touched.
  ViewStmt: ({ body, step }) => ok({ step, action: "obj.create", objects: [qualify(body.view.schemaname, body.view.relname)] }),
  CreateTableAsStmt: ({ body, step }) => {
    // CREATE TABLE AS and CREATE MATERIALIZED VIEW run their query, so it
    // may call only read-only functions, as a query.read may.
    const unknown = [...new Set(calledFunctions(body.query).filter((f) => !READ_ONLY_FUNCTIONS.has(f)))];
    if (unknown.length > 0) {
      return deny(step, "unknown_function", `Step ${step} calls ${unknown.join(", ")}, which the policy gate does not know to be read-only.`,
        "Use only read-only built-in functions, or write the change as explicit SQL steps.", { functions: unknown });
    }
    return ok({ step, action: "obj.create", objects: [qualify(body.into.rel.schemaname, body.into.rel.relname)] });
  },
  TruncateStmt: ({ body, step, snapshot }) => {
    const named: string[] = body.relations.map((r: Node) => qualify(r.RangeVar.schemaname, r.RangeVar.relname));
    const cascade = body.behavior === "DROP_CASCADE";
    return ok({ step, action: "obj.truncate", objects: cascade ? truncateCascade(named, snapshot) : named, cascade });
  },
  VacuumStmt: ({ body, step }) => {
    const options = new Set((body.options ?? []).map((o: Node) => o.DefElem?.defname));
    if (options.has("full")) {
      return deny(step, "vacuum_full", `Step ${step} runs VACUUM FULL, which rewrites the table under ACCESS EXCLUSIVE.`,
        "Use plain VACUUM, or escalate if the table needs a rewrite.");
    }
    // VACUUM and ANALYZE share a node; with no relation list they cover the whole database.
    const rels: Node[] = body.rels ?? [];
    const objects = rels.length === 0
      ? [ALL_RELATIONS]
      : rels.map((r) => qualify(r.VacuumRelation.relation.schemaname, r.VacuumRelation.relation.relname));
    return ok({ step, action: "maint.vacuum_analyze", objects });
  },
};
