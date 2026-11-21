// Scenario lab profile in RealLab: setup and sidecar happen only when a
// profile is set; without one the host commands are exactly the old ones.
import { expect, test } from "bun:test";
import { HarnessError, RealLab, type LabDeps } from "./lab";
import { snapshot } from "../telemetry/fixtures";
import { goodCR } from "./fixtures/good-cr";
import type { CollectOptions, Connection } from "../schema/types";

const host = { seed: 1, ip: "192.0.2.4", name: "s1" };
const summary = { tps: 500, overall: { count: 1000, p50_ms: 2, p99_ms: 20 }, shapes: {} };
const side = { version: "sidecar-v1", shape: "c18_lookup", start_epoch: 1, seconds: 3, tps_counts_1s: [5, 5, 5], mean_ms: 0.4, attempts: 1 };
const PROFILE = { setup: "C18", sidecar: { shape: "c18_lookup", clients: 8, session_s: 15, role: "shipping_api" } };

function deps(log: string[], over: Partial<LabDeps> = {}): LabDeps {
  return {
    collect: async (_c: Connection, _o: CollectOptions = {}) => snapshot(),
    applyCR: async (_cr, _t, o) => ({ steps: [{ ok: true, metrics: {} }], aborted: false, rolledBack: false, rollbackErrors: [], logPath: o!.logPath! }),
    run: async (_ip, cmd) => { log.push(cmd); return { stdout: cmd.includes("sidecar.sh") ? JSON.stringify(side) : cmd.includes("scenario-setup.sh") ? "setup ok" : JSON.stringify({ menu: "x", ...summary }), stderr: "", exitCode: 0 }; },
    tunnel: async (_ip, ports) => ({ ports: Object.fromEntries(ports.map((p) => [p, p + 30000])), close: async () => {} }),
    client: () => ({ unsafe: async () => [{ a: 1 }], end: async () => {} }),
    sleep: async () => {},
    ...over,
  };
}

test("no profile: baseline and production run only w_prod.sh, no sidecar field", async () => {
  const log: string[] = [];
  const lab = new RealLab(host, deps(log));
  await lab.open();
  const b = await lab.baseline(60);
  await lab.setup?.();
  const p = await lab.production(goodCR, b, 180, "/tmp/x.jsonl");
  expect(log.filter(c => !c.includes("w_prod.sh"))).toEqual([]);
  expect("sidecar" in b).toBe(false);
  expect("sidecar" in p.after).toBe(false);
});

test("profile: setup on the primary and the clone; sidecar in baseline and production, never on the clone", async () => {
  const log: string[] = [];
  const lab = new RealLab(host, deps(log));
  lab.profile(PROFILE);
  await lab.open();
  await lab.setup();
  const b = await lab.baseline(60);
  await lab.setup({ kind: "clone", port: 5503, n: 3, name: "c" });
  await lab.rehearse(goodCR, { kind: "clone", port: 5503, n: 3, name: "c" }, b, 120, "/tmp/r.jsonl");
  const p = await lab.production(goodCR, b, 180, "/tmp/x.jsonl");
  const setup = log.filter(c => c.includes("scenario-setup.sh"));
  expect(setup.map(c => c.replace(/^.*scenario-setup\.sh /, ""))).toEqual(["primary C18", "clone 3 C18"]);
  const sc = log.filter(c => c.includes("sidecar.sh")).map(c => c.replace(/^.*sidecar\.sh /, ""));
  expect(sc).toEqual(["60 c18_lookup 5432 8 15 shipping_api", "180 c18_lookup 5432 8 15 shipping_api"]);
  expect(b.sidecar?.tps_counts_1s).toEqual([5, 5, 5]);
  expect(p.after.sidecar?.shape).toBe("c18_lookup");
});

test("profile reset to null: back to the old commands", async () => {
  const log: string[] = [];
  const lab = new RealLab(host, deps(log));
  lab.profile(PROFILE); lab.profile(null);
  await lab.open();
  await lab.setup();
  await lab.baseline(60);
  expect(log.filter(c => !c.includes("w_prod.sh"))).toEqual([]);
});

test("setup failure is a harness error before the CR; sidecar failure leaves sidecar null with a note", async () => {
  const log: string[] = [];
  const lab = new RealLab(host, deps(log, { run: async (_ip, cmd) => cmd.includes("w_prod.sh") ? { stdout: JSON.stringify({ menu: "x", ...summary }), stderr: "", exitCode: 0 } : { stdout: "", stderr: "boom", exitCode: 1 } }));
  lab.profile(PROFILE);
  await lab.open();
  const e = await lab.setup().catch(x => x);
  expect(e).toBeInstanceOf(HarnessError);
  expect((e as HarnessError).reason).toBe("harness:scenario_setup_failed");
  const b = await lab.baseline(60);
  expect(b.sidecar).toBeNull();
  expect(b.errors.join()).toContain("sidecar");
});
