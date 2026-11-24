import { describe, expect, test } from "bun:test";
import { cleanSnapshot, cr } from "../test-kit";
import { classify } from "./index";

// REVOKE of table privileges is priv.revoke (#22, for O3-big-drop-a). Every
// other privilege change stays denied.

const run = (sql: string) => classify(cr(sql), cleanSnapshot);

describe("REVOKE on named tables", () => {
  test("is priv.revoke on the tables, with the privileges and grantees, and no table lock", () => {
    const { actions, denials } = run("REVOKE INSERT, UPDATE, DELETE ON public.notes_archive, secret_lookup FROM PUBLIC, bob");
    expect(denials).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({
      step: 0, action: "priv.revoke", objects: ["public.notes_archive", "public.secret_lookup"],
      privilege: { privileges: ["insert", "update", "delete"], grantees: ["PUBLIC", "bob"] },
      lock: expect.objectContaining({ mode: null }),
    })]);
  });

  test("REVOKE ALL lists its privileges as all", () => {
    expect(run("REVOKE ALL ON TABLE public.notes_archive FROM bob").actions[0])
      .toMatchObject({ privilege: { privileges: ["all"], grantees: ["bob"] } });
  });

  test("a column privilege names its columns", () => {
    expect(run("REVOKE UPDATE (status) ON public.orders FROM bob").actions[0])
      .toMatchObject({ privilege: { privileges: ["update (status)"] } });
  });
});

describe("other privilege changes stay denied", () => {
  test.each([
    ["GRANT", "GRANT SELECT ON public.orders TO bob"],
    ["GRANT OPTION FOR", "REVOKE GRANT OPTION FOR SELECT ON public.orders FROM bob"],
    ["CASCADE", "REVOKE SELECT ON public.orders FROM bob CASCADE"],
    ["ALL TABLES IN SCHEMA", "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM bob"],
    ["a schema", "REVOKE USAGE ON SCHEMA public FROM PUBLIC"],
    ["a sequence", "REVOKE USAGE ON SEQUENCE public.orders_id_seq FROM bob"],
    ["role membership", "REVOKE bob FROM alice"],
  ])("%s", (_name, sql) => {
    const { actions, denials } = run(sql);
    expect(actions).toEqual([]);
    expect(denials).toEqual([expect.objectContaining({ step: 0, code: "privilege_change", verdict: "reject" })]);
  });
});
