import { LOCK_PROFILES } from "../locks";
import { qualify, type Node } from "./ast";
import { deny, ok, type StatementClassifier } from "./types";

// Privilege changes (#22). REVOKE of table or column privileges on named
// tables is priv.revoke, under ACCESS SHARE, so a change request can stop writes to a table
// without dropping it (O3). Ticket scope judges it like any action: the
// revoked tables are its objects. Everything else stays denied: GRANT widens
// access, GRANT OPTION FOR and CASCADE reach grantees the statement does not
// name, ALL TABLES IN SCHEMA reaches tables it does not name, and other object
// types and role membership are outside the vocabulary.

const denyPrivilege = (step: number, what: string) => deny(step, "privilege_change",
  `Step ${step} ${what}; the policy gate allows only REVOKE of privileges on named tables.`,
  "Revoke table privileges on each table by name, without CASCADE, or escalate the privilege change.", { found: what });

export const PRIVILEGE_STATEMENTS: Record<string, StatementClassifier> = {
  GrantRoleStmt: ({ body, step }) => denyPrivilege(step, body.is_grant ? "grants role membership" : "revokes role membership"),
  GrantStmt: ({ body, step }) => {
    if (body.is_grant) return denyPrivilege(step, "grants privileges");
    if (body.grant_option) return denyPrivilege(step, "revokes GRANT OPTION FOR a privilege");
    if (body.behavior === "DROP_CASCADE") return denyPrivilege(step, "revokes with CASCADE");
    if (body.targtype !== "ACL_TARGET_OBJECT") return denyPrivilege(step, "revokes on every object in a schema");
    if (body.objtype !== "OBJECT_TABLE") return denyPrivilege(step, `revokes privileges on a ${String(body.objtype).replace("OBJECT_", "").toLowerCase()}`);
    const tables: string[] = body.objects.map((o: Node) => qualify(o.RangeVar.schemaname, o.RangeVar.relname));
    // No privileges list means ALL.
    const privileges: string[] = body.privileges
      ? body.privileges.map(({ AccessPriv: p }: Node) => p.cols
        ? `${p.priv_name} (${p.cols.map((c: Node) => c.String.sval).join(", ")})`
        : p.priv_name)
      : ["all"];
    const grantees: string[] = body.grantees.map(({ RoleSpec: r }: Node) => r.roletype === "ROLESPEC_PUBLIC" ? "PUBLIC" : r.rolename ?? r.roletype);
    return ok({
      step, action: "priv.revoke", objects: tables, privilege: { privileges, grantees },
      lock: { ...LOCK_PROFILES["priv.revoke"], relations: tables },
    });
  },
};
