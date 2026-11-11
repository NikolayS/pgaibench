import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectivityLoss } from "./connectivity";

// Shape of the stored A/A try-1 production record (lab-aa-try1-s1/D21-ref_aa-s1):
// the ssh process gone, every connect to the local forward ports refused.
const tryOne = [
  "settings: connect ECONNREFUSED 127.0.0.1:51411",
  "window replication primary: connect ECONNREFUSED 127.0.0.1:51411 (at 1794352568.8)",
  "window replication standby: connect ECONNREFUSED 127.0.0.1:51412 (at 1794352568.8)",
  "standby conflicts: connect ECONNREFUSED 127.0.0.1:51412",
];
const ports = [51411, 51412];

test("connect refused on a local tunnel port is a connectivity loss, not a database error", () => {
  expect(connectivityLoss(tryOne, ports)).toEqual(tryOne);
  expect(connectivityLoss(["wait_events: connect ETIMEDOUT 127.0.0.1:51411", "x: connect ECONNRESET 127.0.0.1:51412"], ports)).toHaveLength(2);
});
test("a database outage behind a live tunnel stays the database's (the CR's doing)", () => {
  // ssh accepts the local connect and then closes the channel when Postgres is down or restarting.
  const outage = ["settings: Connection terminated unexpectedly", "pg_stat_wal: the database system is starting up", "replication standby: read ECONNRESET",
    "settings: terminating connection due to administrator command", "replication primary: connect ECONNREFUSED 127.0.0.1:5432"];
  expect(connectivityLoss(outage, ports, true)).toEqual([]);
  // A port that is not one of our local forward ports is never the tunnel.
  expect(connectivityLoss(["settings: connect ECONNREFUSED 127.0.0.1:60000"], ports, true)).toEqual([]);
});
test("the tunnel liveness probe decides an ambiguous reset or timeout: the ssh process exited", () => {
  const errs = ["replication standby: read ECONNRESET", "settings: Connection terminated unexpectedly", "pg_stat_wal: the database system is starting up"];
  expect(connectivityLoss(errs, ports, false)).toEqual(["tunnel: ssh process exited", "replication standby: read ECONNRESET", "settings: Connection terminated unexpectedly"]);
});
test("replaying the stored A/A try-1 production records (both VMs) gives a connectivity loss", () => {
  const stored = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/tunnel-lost-aa-try1.json"), "utf8")) as Record<string, { errors: string[] }>;
  for (const s of ["s1", "s2"]) {
    const errors = stored[s]!.errors;
    // The stored records predate tunnel_ports: the local forward ports are the ephemeral ones in the errors.
    const local = [...new Set(errors.flatMap(e => [...e.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => Number(m[1])).filter(p => p >= 49152)))];
    expect(local.length).toBeGreaterThan(0);
    expect(connectivityLoss(errors, local).length).toBeGreaterThan(10);
  }
});
test("the harness ssh to the VM failing to connect (port 22) is a connectivity loss too", () => {
  const e = "oom_kills: /opt/pgaibench/env/oom-count.sh exited 255: ssh: connect to host 192.0.2.10 port 22: Operation timed out";
  expect(connectivityLoss([e], ports, true)).toEqual([e]);
  // A remote script's own nonzero exit is not.
  expect(connectivityLoss(["oom_kills: /opt/pgaibench/env/oom-count.sh exited 1: permission denied"], ports, true)).toEqual([]);
});
