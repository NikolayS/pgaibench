import { describe, expect, test } from "bun:test";
import { lockHandling, toMs } from "./lock-handling";

const sq = (...sql: string[]) => sql.map((s) => ({ sql: s }));

describe("toMs", () => {
  test("units and bare numbers", () => {
    expect(toMs("'1s'")).toBe(1000); expect(toMs("500ms")).toBe(500); expect(toMs("2min")).toBe(120000);
    expect(toMs("1000")).toBe(1000); expect(toMs("'1.5s'")).toBe(1500); expect(toMs("'0'")).toBe(0); expect(toMs("abc")).toBeNull();
  });
});

describe("lockHandling", () => {
  test("no lock_timeout before ALTER TABLE", () => {
    const r = lockHandling(sq("ALTER TABLE t ADD COLUMN c int"));
    expect(r).toMatchObject({ locking_step: 1, locking_kind: "ALTER TABLE", lock_timeout_ms: null, lock_timeout_form: null, retries: false });
  });
  test("SET lock_timeout = '1s' in an earlier step", () => {
    expect(lockHandling(sq("SET lock_timeout = '1s'", "ALTER TABLE t ADD c int"))).toMatchObject({ lock_timeout_ms: 1000, lock_timeout_form: "SET" });
  });
  test("SET LOCAL ... TO in the same step", () => {
    expect(lockHandling(sq("BEGIN; SET LOCAL lock_timeout TO '2s'; ALTER TABLE t ADD c int; COMMIT"))).toMatchObject({ lock_timeout_ms: 2000, lock_timeout_form: "SET LOCAL", locking_step: 1 });
  });
  test("a setting after the lock does not count", () => {
    expect(lockHandling(sq("ALTER TABLE t ADD c int; SET lock_timeout = '1s'")).lock_timeout_ms).toBeNull();
  });
  test("the last setting before the lock gives the value", () => {
    expect(lockHandling(sq("SET lock_timeout = '5s'; SET lock_timeout = 300", "ALTER TABLE t ADD c int")).lock_timeout_ms).toBe(300);
  });
  test("set_config with a literal", () => {
    expect(lockHandling(sq("select set_config('lock_timeout', '750ms', false); alter table t add c int"))).toMatchObject({ lock_timeout_ms: 750, lock_timeout_form: "set_config" });
  });
  test("set_config with a variable from a FOREACH array: first value", () => {
    const r = lockHandling(sq("do $$ declare v_timeouts text[] := array['300ms','1s','3s']; v_t text; begin foreach v_t in array v_timeouts loop perform set_config('lock_timeout', v_t, false); begin alter table t add c int; exception when lock_not_available then null; end; end loop; end $$;"));
    expect(r).toMatchObject({ lock_timeout_ms: 300, lock_timeout_max_ms: 3000, lock_timeout_form: "set_config (variable)", retries: true, retry_how: ["loop with a lock handler"] });
  });
  test("set_config with a variable assigned a literal", () => {
    expect(lockHandling(sq("do $$ declare lt text := '2s'; begin perform set_config('lock_timeout', lt, true); alter table t add c int; end $$")).lock_timeout_ms).toBe(2000);
  });
  test("comments are ignored", () => {
    expect(lockHandling(sq("-- SET lock_timeout = '1s'\n/* set lock_timeout = 1 */ ALTER TABLE t ADD c int")).lock_timeout_ms).toBeNull();
  });
  test("CREATE INDEX CONCURRENTLY is not a locking statement; plain CREATE INDEX is", () => {
    expect(lockHandling(sq("CREATE INDEX CONCURRENTLY i ON t (a)")).locking_step).toBeNull();
    expect(lockHandling(sq("CREATE INDEX CONCURRENTLY i ON t (a)", "set lock_timeout='1s'", "create unique index j on t (b)"))).toMatchObject({ locking_step: 3, locking_kind: "CREATE INDEX", lock_timeout_ms: 1000 });
  });
  test("retries field and NOWAIT", () => {
    expect(lockHandling([{ sql: "LOCK TABLE t IN ACCESS EXCLUSIVE MODE NOWAIT", retries: 3 }])).toMatchObject({ locking_kind: "LOCK TABLE", nowait: true, retries: true, retry_how: ["retries field"] });
  });
  test("a config step setting lock_timeout counts", () => {
    expect(lockHandling([{ config: { name: "lock_timeout", value: "1s" } }, { sql: "ALTER TABLE t ADD c int" }])).toMatchObject({ lock_timeout_ms: 1000, lock_timeout_form: "config step" });
  });
});
