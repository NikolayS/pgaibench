import { parsePlPgSql, parseSql } from "../parse";
import type { Node } from "./ast";
import { deny, type StatementClassifier } from "./types";

// DO blocks (ADR 0005). The gate sees inside a DO block only when its body is
// a plain list of SQL statements: PL/pgSQL with no declared variables, no
// nested or labelled block, no exception handler, and no statement other than
// plain SQL. Such a block runs its statements in order in one transaction, so
// classify() replaces it with them. Anything else (loops, IF, EXECUTE, PERFORM,
// INTO, RAISE, COMMIT, another language) hides what runs, and stays denied.

export type DoBody = { plain: true; statements: Node[] } | { plain: false; found: string };

// What each PL/pgSQL statement other than plain SQL is called in the denial.
const NOT_PLAIN: Record<string, string> = {
  PLpgSQL_stmt_if: "IF", PLpgSQL_stmt_case: "CASE",
  PLpgSQL_stmt_loop: "a loop", PLpgSQL_stmt_while: "a loop", PLpgSQL_stmt_fori: "a loop", PLpgSQL_stmt_fors: "a loop",
  PLpgSQL_stmt_forc: "a loop", PLpgSQL_stmt_dynfors: "a loop", PLpgSQL_stmt_foreach_a: "a loop",
  PLpgSQL_stmt_exit: "EXIT", PLpgSQL_stmt_return: "RETURN", PLpgSQL_stmt_assign: "an assignment",
  PLpgSQL_stmt_dynexecute: "EXECUTE", PLpgSQL_stmt_perform: "PERFORM", PLpgSQL_stmt_raise: "RAISE",
  PLpgSQL_stmt_assert: "ASSERT", PLpgSQL_stmt_call: "CALL", PLpgSQL_stmt_getdiag: "GET DIAGNOSTICS",
  PLpgSQL_stmt_open: "a cursor", PLpgSQL_stmt_fetch: "a cursor", PLpgSQL_stmt_close: "a cursor",
  PLpgSQL_stmt_commit: "COMMIT", PLpgSQL_stmt_rollback: "ROLLBACK",
};

const option = (body: Node, name: string): string | undefined =>
  (body.args ?? []).map((a: Node) => a.DefElem).find((d: Node) => d?.defname === name)?.arg?.String?.sval;

/** The statements of a DO block's body if it is plain, or what makes it not plain. */
export function plainDoBody(body: Node): DoBody {
  const language = (option(body, "language") ?? "plpgsql").toLowerCase();
  if (language !== "plpgsql") return { plain: false, found: `LANGUAGE ${language}` };
  const source = option(body, "as") ?? "";
  let tag = "$pgaibench_do$";
  while (source.includes(tag)) tag = `${tag.slice(0, -1)}_$`;
  const parsed = parsePlPgSql(`DO ${tag}${source}${tag}`);
  const fn: Node | undefined = parsed.ok ? (parsed.functions[0] as Node)?.PLpgSQL_function : undefined;
  if (!fn) return { plain: false, found: "a body that does not parse as PL/pgSQL" };
  const block: Node = fn.action?.PLpgSQL_stmt_block ?? {};
  if (block.label) return { plain: false, found: "a labelled block" };
  if (block.exceptions) return { plain: false, found: "an EXCEPTION handler" };
  const body_: Node[] = block.body ?? [];
  // PL/pgSQL appends an implicit RETURN to the outermost block.
  const stmts = body_.at(-1)?.PLpgSQL_stmt_return && Object.keys(body_.at(-1)!.PLpgSQL_stmt_return).length === 0 ? body_.slice(0, -1) : body_;
  const statements: Node[] = [];
  for (const s of stmts) {
    const [kind] = Object.keys(s);
    if (kind === "PLpgSQL_stmt_block") {
      const inner: Node = s[kind];
      return { plain: false, found: inner.exceptions ? "an EXCEPTION handler" : inner.label ? "a labelled block" : "a nested BEGIN ... END block" };
    }
    if (kind !== "PLpgSQL_stmt_execsql") return { plain: false, found: NOT_PLAIN[kind] ?? kind };
    if (s[kind].into) return { plain: false, found: "INTO" };
    const sql = s[kind].sqlstmt?.PLpgSQL_expr?.query;
    const one = typeof sql === "string" ? parseSql(sql) : undefined;
    if (!one?.ok || one.stmts.length !== 1 || !one.stmts[0].stmt) return { plain: false, found: "a statement that does not parse on its own" };
    statements.push(one.stmts[0].stmt as Node);
  }
  // The implicit FOUND variable is always there; any other is declared.
  const declared = (fn.datums ?? []).some((d: Node) => d.PLpgSQL_var && d.PLpgSQL_var.refname !== "found");
  if (declared) return { plain: false, found: "DECLARE" };
  return { plain: true, statements };
}

// classify() expands a plain DO block before dispatch, so a DO block reaches
// this classifier only when its body is not plain.
export const DO_STATEMENTS: Record<string, StatementClassifier> = {
  DoStmt: ({ body, step }) => {
    const b = plainDoBody(body);
    const found = b.plain ? "statements" : b.found;
    return deny(step, "do_block", `Step ${step} is a DO block with ${found}, so the policy gate cannot see what it runs. A DO block is classified only when its body is a plain list of SQL statements.`,
      "Write each statement as its own SQL step, or keep the DO block to plain SQL statements (no DECLARE, loops, IF, EXECUTE, PERFORM, INTO, RAISE or COMMIT).", { found });
  },
};
