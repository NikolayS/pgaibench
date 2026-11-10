import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKLOAD_VERSION } from "../src/run/lab";

const env = import.meta.dir;
// Postmaster-context settings in env/pg/pgaibench.conf: a -c override with another
// value leaves an error entry ("setting could not be applied") in pg_file_settings.
const POSTMASTER = ["listen_addresses", "max_connections", "shared_buffers", "max_locks_per_transaction", "wal_level", "max_wal_senders", "archive_mode", "hot_standby", "shared_preload_libraries"];

test("the clone starts with no override of a postmaster setting from pgaibench.conf (pg_file_settings has no error entry on the clone)", () => {
  const lib = readFileSync(join(env, "lib.sh"), "utf8");
  const run = lib.slice(lib.indexOf("run_clone_container() {"), lib.indexOf("\n}\n", lib.indexOf("run_clone_container() {")));
  const overrides = [...run.matchAll(/-c "?([a-z_]+)=/g)].map(m => m[1]);
  const conf = readFileSync(join(env, "pg/pgaibench.conf"), "utf8");
  expect(overrides.filter(o => POSTMASTER.includes(o!) && new RegExp(`^${o} =`, "m").test(conf))).toEqual([]);
  // The clone still archives nowhere: the archive command is a no-op.
  expect(run).toContain("archive_command=/bin/true");
});
test("the env version stamp names the clone start change (VMs need an env/ sync)", () => {
  expect(WORKLOAD_VERSION).toBe("w_prod-oracle-v2.7");
  expect(readFileSync(join(env, "workload/w_prod.sh"), "utf8")).toContain(`--arg version "${WORKLOAD_VERSION}"`);
});
